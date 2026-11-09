// UI-05 + MKT-01 in Paper mode: XAUUSDT is validated against MEXC "Get Contract Info" (recorded public
// response served by a stub; no network), published, picked up by the RUNNING feed process without a
// restart (sub.ticker XAU_USDT on its live socket), selectable in Trade Settings once approved in a
// strategy version, and previewed with its own contract specification. Live order submission stays
// disabled throughout.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { and, desc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  INTERVAL_MS,
  Decimal,
  PAPER_TEMPLATE,
  type CandleInterval
} from '@trendpilot/domain';
import {
  MexcPublicError,
  parseContractInfo,
  recordMarketTick,
  schema,
  type ContractInfoSource,
  type MexcContractDetail,
  type MexcKline,
  type MexcTicker,
  type PublicMarketSource,
  type WsLike
} from '@trendpilot/db';
import * as validate from '@/app/v1/admin/instruments/validate/route';
import * as instrumentsAdmin from '@/app/v1/admin/instruments/route';
import * as feeds from '@/app/v1/admin/market-feeds/route';
import * as packages from '@/app/v1/admin/strategy-packages/route';
import * as versions from '@/app/v1/admin/strategy-packages/[id]/versions/route';
import * as publish from '@/app/v1/admin/strategy-versions/[id]/publish/route';
import * as instruments from '@/app/v1/instruments/route';
import * as blocks from '@/app/v1/me/order-blocks/route';
import * as previewDraft from '@/app/v1/me/order-blocks/preview/route';
import { setPairContractSourceForTests } from '@/server/adminCatalog';
import { blockBody, call, direct, resetAndSeed, signIn, teardown, USERS, VERSION } from '../helpers';
import { startFeed, type RunningFeed } from '../../../worker/src/feed';
import { testDatabaseUrl } from '../testDb';

const here = path.dirname(fileURLToPath(import.meta.url));
const XAU_INFO = parseContractInfo(JSON.parse(fs.readFileSync(path.join(here, '../../../../packages/db/test/fixtures/mexc-public/contract-info-XAU_USDT.json'), 'utf8')), 'XAU_USDT');

/** MEXC Get Contract Info stand-in: XAU_USDT from the recorded response; scripted failures. */
class ContractInfoStub implements ContractInfoSource {
  next: Error | null = null;
  asked: string[] = [];
  async contractInfo(sym: string) {
    this.asked.push(sym);
    if (this.next) {
      const e = this.next;
      this.next = null;
      throw e;
    }
    if (sym.toUpperCase() !== 'XAU_USDT') throw new MexcPublicError('Contract does not exist (code 1001)', 'API', 1001);
    return XAU_INFO;
  }
}

/** Public REST stand-in for the feed (detail, candles, clock). Counts ticker calls (expected: none). */
class RestStub implements PublicMarketSource {
  readonly requestCounts: Record<string, number> = {};
  private n(k: string) {
    this.requestCounts[k] = (this.requestCounts[k] ?? 0) + 1;
  }
  async serverTimeMs() {
    this.n('ping');
    return Date.now();
  }
  async ticker(sym: string): Promise<MexcTicker> {
    this.n('ticker');
    throw new MexcPublicError(`unexpected REST ticker ${sym}`, 'NETWORK');
  }
  async klines(_sym: string, interval: CandleInterval, from: Date, to: Date): Promise<MexcKline[]> {
    this.n('kline');
    const ms = INTERVAL_MS[interval];
    const out: MexcKline[] = [];
    for (let t = Math.ceil(from.getTime() / ms) * ms; t <= to.getTime(); t += ms) out.push({ openTime: new Date(t), open: '2650', high: '2651', low: '2649', close: '2650.5' });
    return out;
  }
  async contractDetail(sym: string): Promise<MexcContractDetail> {
    this.n('detail');
    if (sym === 'XAU_USDT') return { exchangeSymbol: sym, contractSize: XAU_INFO.contractSize, priceUnit: XAU_INFO.priceUnit, volUnit: XAU_INFO.volUnit, minVol: XAU_INFO.minVol, maxVol: XAU_INFO.maxVol, state: 0, apiAllowed: true };
    const spec = sym === 'BTC_USDT' ? { contractSize: '0.0001', priceUnit: '0.1' } : { contractSize: '0.01', priceUnit: '0.01' };
    return { exchangeSymbol: sym, ...spec, volUnit: '1', minVol: '1', maxVol: '1000000', state: 0, apiAllowed: true };
  }
}

class FakeWs implements WsLike {
  static all: FakeWs[] = [];
  readyState = 0;
  binaryType = 'blob';
  sent: { method: string; param?: { symbol: string } }[] = [];
  onopen: WsLike['onopen'] = null;
  onmessage: WsLike['onmessage'] = null;
  onclose: WsLike['onclose'] = null;
  onerror: WsLike['onerror'] = null;
  constructor(readonly url: string) {
    FakeWs.all.push(this);
    setTimeout(() => {
      this.readyState = 1;
      this.onopen?.({});
    }, 10);
  }
  send(data: string) {
    const m = JSON.parse(data);
    this.sent.push(m);
    if (m.method === 'ping') setTimeout(() => this.recv({ channel: 'pong', data: Date.now() }), 5);
    if (m.method === 'sub.ticker') setTimeout(() => this.recv({ channel: 'rs.sub.ticker', data: 'success' }), 5);
  }
  close() {
    this.readyState = 3;
  }
  recv(msg: unknown) {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
  subs = () => this.sent.filter((m) => m.method === 'sub.ticker').map((m) => m.param!.symbol);
}

const until = async (what: string, fn: () => Promise<boolean> | boolean, ms = 8_000) => {
  const end = Date.now() + ms;
  while (!(await fn())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
};

const SUGGEST = { suggestedStopPct: '1', suggestedTakeProfitPct: '2', suggestedTrailingEnabled: false, suggestedTrailingPct: '1' };
const stub = new ContractInfoStub();
let admin: string;
let investor: string;
let xauId: string;
let feed: RunningFeed | null = null;
const rest = new RestStub();
const feedLog: string[] = [];

beforeAll(async () => {
  await resetAndSeed();
  admin = await signIn(USERS.admin.email);
  investor = await signIn(USERS.investorA.email);
  setPairContractSourceForTests({ source: 'MEXC_PUBLIC', client: stub });
});

afterAll(async () => {
  setPairContractSourceForTests(null);
  await feed?.stop();
  await teardown();
});

describe('XAUUSDT validates against MEXC Get Contract Info', () => {
  it('XAUUSDT and XAU_USDT resolve to the exchange symbol XAU_USDT with MEXC specs and leverage limits', async () => {
    for (const symbol of ['XAUUSDT', 'xau_usdt']) {
      const r = await call(validate.POST, { method: 'POST', path: '/x', cookie: admin, body: { symbol } });
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({
        symbol: 'XAUUSDT',
        exchangeSymbol: 'XAU_USDT',
        base: 'XAU',
        settleCoin: 'USDT',
        source: 'MEXC_PUBLIC',
        fixtureLabel: null,
        contract: { multiplier: '0.001', priceTick: '0.01', qtyStep: '1', minQty: '1', maxQty: '1000000', takerFeeRate: '0.0002' },
        leverage: { min: 1, max: 1000 },
        warnings: []
      });
      expect(Math.max(...r.body.leverageChoices)).toBe(200);
    }
    expect(stub.asked).toEqual(['XAU_USDT', 'XAU_USDT']);
  });

  it('an unknown symbol is a field error; a rate limit and a timeout are distinct, retryable errors', async () => {
    const unknown = await call(validate.POST, { method: 'POST', path: '/x', cookie: admin, body: { symbol: 'NOTREALUSDT' } });
    expect(unknown.status).toBe(400);
    expect(unknown.body.issues).toEqual([{ path: 'symbol', message: 'NOTREAL_USDT is not a MEXC Futures contract.' }]);

    stub.next = new MexcPublicError('contract info: Requests are too frequent (code 510)', 'API', 510);
    const limited = await call(validate.POST, { method: 'POST', path: '/x', cookie: admin, body: { symbol: 'XAUUSDT' } });
    expect(limited).toMatchObject({ status: 429, body: { code: 'RATE_LIMITED' } });

    stub.next = new MexcPublicError('GET /api/v1/contract/detail/country: The operation was aborted due to timeout', 'NETWORK');
    const timeout = await call(validate.POST, { method: 'POST', path: '/x', cookie: admin, body: { symbol: 'XAUUSDT' } });
    expect(timeout).toMatchObject({ status: 503, body: { code: 'EXCHANGE_UNAVAILABLE', message: expect.stringMatching(/not a problem with the ticker/) } });

    const bad = await call(validate.POST, { method: 'POST', path: '/x', cookie: admin, body: { symbol: 'XAU-USD' } });
    expect(bad.status).toBe(400);
  });
});

describe('publish → market data without a feed restart', () => {
  it('the running feed process is subscribed to the existing pairs only', async () => {
    FakeWs.all = [];
    feed = await startFeed({
      env: { DATABASE_URL: testDatabaseUrl(), LIVE_ORDER_TRANSPORT: 'disabled', MARKET_FEED_POLL_MS: '1000', NODE_ENV: 'test' },
      source: rest,
      wsFactory: (u) => new FakeWs(u),
      log: (m) => feedLog.push(m)
    });
    await until('socket subscriptions', () => (FakeWs.all[0]?.subs().length ?? 0) >= 2);
    expect(FakeWs.all[0]!.subs()).toEqual(['BTC_USDT', 'ETH_USDT']);
  });

  it('Publish stores XAUUSDT → XAU_USDT with the MEXC contract spec (not fixture metadata)', async () => {
    const r = await call(instrumentsAdmin.POST, { method: 'POST', path: '/x', cookie: admin, body: { symbol: 'XAU_USDT', ...SUGGEST } });
    expect(r.status).toBe(201);
    xauId = r.body.id;
    expect(r.body).toMatchObject({ symbol: 'XAUUSDT', exchangeSymbol: 'XAU_USDT', base: 'XAU', quote: 'USDT', status: 'PUBLISHED', isFixture: false, fixtureLabel: null, contract: { multiplier: '0.001', priceTick: '0.01', qtyStep: '1', minQty: '1' } });
    expect(Math.max(...r.body.leverageChoices)).toBe(200);
    expect((await call(instrumentsAdmin.POST, { method: 'POST', path: '/x', cookie: admin, body: { symbol: 'XAUUSDT', ...SUGGEST } })).status).toBe(409);
    const audit = await direct.db.select().from(schema.auditEvents).where(eq(schema.auditEvents.targetId, xauId));
    expect(audit[0]?.after).toMatchObject({ exchangeSymbol: 'XAU_USDT', contractSource: 'MEXC_PUBLIC' });
  });

  it('the running feed subscribes sub.ticker XAU_USDT on the same socket within a cycle (no restart)', async () => {
    await until('sub.ticker XAU_USDT', () => FakeWs.all[0]!.subs().includes('XAU_USDT'));
    expect(FakeWs.all).toHaveLength(1); // same socket, same process
    expect(feedLog.some((l) => l.includes('→ sub.ticker XAU_USDT'))).toBe(true);
  });

  it('a push.ticker for XAU_USDT is stored as a public WebSocket quote and the contract turns HEALTHY', async () => {
    const ts = Date.now() - 300;
    FakeWs.all[0]!.recv({ channel: 'push.ticker', symbol: 'XAU_USDT', ts, data: { symbol: 'XAU_USDT', bid1: 2650.25, ask1: 2650.3, fairPrice: 2650.27, lastPrice: 2650.28, timestamp: ts } });
    await until('XAU quote', async () => (await direct.db.select().from(schema.marketQuotes).where(eq(schema.marketQuotes.instrumentId, xauId))).length > 0);
    const [q] = await direct.db.select().from(schema.marketQuotes).where(eq(schema.marketQuotes.instrumentId, xauId)).orderBy(desc(schema.marketQuotes.asOf));
    expect(q).toMatchObject({ source: 'MEXC_PUBLIC', channel: 'WS' });
    await until('XAU HEALTHY', async () => (await direct.db.select().from(schema.marketFeedStatus).where(eq(schema.marketFeedStatus.instrumentId, xauId)))[0]?.state === 'HEALTHY');
    expect(rest.requestCounts.ticker ?? 0).toBe(0);
    // A newly published pair waits for its first ticker as STARTING, never a false STALE/DOWN.
    const changes = (await direct.db.select().from(schema.marketFeedEvents).where(and(eq(schema.marketFeedEvents.instrumentId, xauId), eq(schema.marketFeedEvents.kind, 'STATE_CHANGED')))).map((e) => e.message);
    expect(changes).toEqual([expect.stringMatching(/STARTING → HEALTHY/)]);
  });

  it('Market Data Feed lists XAUUSDT (MEXC XAU_USDT) with its WebSocket price and no spec mismatch', async () => {
    await until('contract check', async () => (await direct.db.select().from(schema.marketFeedStatus).where(eq(schema.marketFeedStatus.instrumentId, xauId)))[0]?.contractCheckedAt != null);
    const r = await call(feeds.GET, { path: '/x', cookie: admin });
    const xau = r.body.items.find((i: { instrumentId: string }) => i.instrumentId === xauId);
    expect(xau).toMatchObject({ symbol: 'XAUUSDT', exchangeSymbol: 'XAU_USDT', instrumentStatus: 'PUBLISHED', feed: { state: 'HEALTHY', contractMismatches: [] }, latestQuote: { sourceLabel: 'MEXC public market data · WebSocket' } });
    const ev = await direct.db.select().from(schema.marketFeedEvents).where(and(eq(schema.marketFeedEvents.instrumentId, xauId), eq(schema.marketFeedEvents.kind, 'CONTRACT_MISMATCH')));
    expect(ev).toHaveLength(0);
    await feed!.stop();
    feed = null;
  });
});

describe('investor Trade Settings and order preview use XAU’s own contract', () => {
  let versionId: string;

  it('investors see the published pair; an admin approves it in a strategy version', async () => {
    const list = await call(instruments.GET, { path: '/x', cookie: investor });
    expect(list.body.items.map((i: { symbol: string }) => i.symbol)).toContain('XAUUSDT');
    const pkgs = await call(packages.GET, { path: '/x', cookie: admin });
    const pkgId = pkgs.body.items.find((p: { versions: { id: string }[] }) => p.versions.some((v) => v.id === VERSION)).id;
    const d = await call(versions.POST, { method: 'POST', path: '/x', cookie: admin, params: { id: pkgId }, body: { ...PAPER_TEMPLATE, instrumentIds: [xauId] } });
    expect(d.status).toBe(201);
    const p = await call(publish.POST, { method: 'POST', path: '/x', cookie: admin, params: { id: d.body.id }, ifMatch: d.body.revision });
    expect(p.status).toBe(200);
    versionId = p.body.id;
  });

  it('the order preview prices XAU with its 0.001 XAU contract size, 0.01 tick and the fresh public quote', async () => {
    await recordMarketTick(direct.db, { instrumentId: xauId, asOf: new Date(Date.now() - 200), bid: '2650.25', ask: '2650.30', mark: '2650.27', last: '2650.28', source: 'MEXC_PUBLIC', channel: 'WS' });
    const body = blockBody({ instrumentId: xauId, strategyVersionId: versionId, orderCostUsdt: '100', leverage: 10, mode: 'PAPER' });
    const r = await call(previewDraft.POST, { method: 'POST', path: '/x', cookie: investor, body });
    expect(r.status).toBe(200);
    expect(r.body.quote.source).toBe('MEXC_PUBLIC');
    expect(r.body.instrument).toEqual({ symbol: 'XAUUSDT', exchangeSymbol: 'XAU_USDT', fixtureLabel: null });
    const long = r.body.sides.find((s: { side: string }) => s.side === 'LONG');
    // 100 USDT × 10 = 1000 USDT notional; one contract = 0.001 XAU × ask.
    const expected = new Decimal(1000).div(new Decimal(long.entryPrice).times('0.001')).floor();
    expect(new Decimal(long.contracts).eq(expected)).toBe(true);
    expect(Number(long.contracts)).toBeGreaterThan(300); // a BTC-sized (0.0001) or fixture spec would differ by 10×
    expect(new Decimal(long.entryPrice).mod('0.01').eq(0)).toBe(true);
  });

  it('the investor can save a Paper order block for XAUUSDT; live order submission stays disabled', async () => {
    const r = await call(blocks.POST, { method: 'POST', path: '/x', cookie: investor, body: blockBody({ instrumentId: xauId, strategyVersionId: versionId, mode: 'PAPER' }), headers: { 'idempotency-key': 'xau-block-1' } });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ instrumentId: xauId, mode: 'PAPER' });
    expect(process.env.LIVE_ORDER_TRANSPORT ?? 'disabled').toBe('disabled');
  });
});
