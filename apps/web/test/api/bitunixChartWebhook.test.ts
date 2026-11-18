// 18 Nov 2026 deployed-panel gap: a TradingView alert from a Bitunix chart (BITUNIX:XAUUSDT.P, 5m)
// was answered 422 ROUTE_NOT_FOUND because no route could be saved with the Bitunix contract as its
// signal contract (the Admin form offered MEXC contracts only). This test runs the REAL webhook
// handler and worker against a mocked Bitunix exchange:
//   1. the sanitized production payload is rejected ROUTE_NOT_FOUND while no Bitunix route exists;
//   2. an administrator saves the 5m Bullish and Bearish routes with Bitunix XAUUSDT as the signal
//      contract (the existing MEXC route and its targets stay as they were);
//   3. the same payload is then accepted, and BULLISH_FLIP / BEARISH_FLIP reach the investor's Live
//      Bitunix XAUUSDT order block (Long, then close-and-reverse to Short), visible in the Admin
//      signal log. No real order is sent.
import { and, desc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BitunixQuoteWriter, getOperationsStatus, ExchangePriceCache, FIXTURE_IDS, installBitunixTestSeam, installLiveTestSeam, listRecentRejections, listRecentSignalEvents, listSignalRoutes, schema, syncBitunixConnection, type ConnectionRow } from '@trendpilot/db';
import { buildTradingViewPayload, Decimal, normalizeSource, type SignalAction } from '@trendpilot/domain';
import * as blocks from '@/app/v1/me/order-blocks/route';
import * as resume from '@/app/v1/me/order-blocks/[id]/resume/route';
import * as conn from '@/app/v1/me/exchange-connection/route';
import * as activate from '@/app/v1/me/live/activate/route';
import * as bitunixInstrument from '@/app/v1/admin/instruments/bitunix/route';
import * as signalRoutes from '@/app/v1/admin/signal-routes/route';
import * as approve from '@/app/v1/admin/live/connections/[id]/approve/route';
import * as capabilities from '@/app/v1/admin/live/capabilities/route';
import * as contracts from '@/app/v1/admin/live/contracts/[id]/route';
import * as platform from '@/app/v1/admin/live/platform/route';
import * as webhook from '@/app/v1/webhooks/tradingview/[ingressToken]/route';
import { setTestClock } from '@/server/clock';
import { adminLiveData } from '@/server/live';
import { BTC, blockBody, call, direct, teardown, userId, USERS } from '../helpers';
const FIXTURE_PACKAGE = FIXTURE_IDS.package;
import { MockBitunixExchange } from '../bitunixOrderMock';
import { MockMexc } from '../mexcMock';
import { ALL_DAYS, clock, cookies, drain, openFromAlert, plus, publishVersion } from '../paperReplay';

const M5 = 5 * 60_000;
const D = (v: Decimal.Value) => new Decimal(v);
const LIMITS = { maxOrderContracts: '1', maxOrderNotionalUsdt: '5000', maxLeverage: 10, maxExposureUsdt: '10000' };
const x = Object.assign(new MockBitunixExchange(), { nowMs: () => clock.now.getTime() });
const cache = new ExchangePriceCache();
let idA: string;
let xau: string;
let block: string;
let bar = new Date('2026-11-18T10:00:00Z');

const bxConn = async (ownerId: string): Promise<ConnectionRow> => (await direct.db.select().from(schema.exchangeConnections).where(and(eq(schema.exchangeConnections.ownerId, ownerId), eq(schema.exchangeConnections.exchange, 'BITUNIX'))))[0]!;
const livePositions = async () => direct.db.select().from(schema.positions).where(and(eq(schema.positions.ownerId, idA), eq(schema.positions.mode, 'LIVE'))).orderBy(desc(schema.positions.createdAt));
const decisionsOf = (eventId: string) => direct.db.select().from(schema.signalDecisions).where(and(eq(schema.signalDecisions.eventId, eventId), eq(schema.signalDecisions.orderBlockId, block)));

/** The alert TradingView sends from the BITUNIX:XAUUSDT.P 5m chart (sanitized: token and investor data removed). */
const payload = (action: SignalAction, barOpen: Date, referencePrice: string) =>
  JSON.stringify(buildTradingViewPayload({ action, exchange: 'BITUNIX', symbol: 'XAUUSDT.P', interval: '5', barOpen, firedAt: plus(new Date(barOpen.getTime() + M5), 1), referencePrice }));

async function post(raw: string) {
  const token = process.env.DEV_INGRESS_TOKEN!;
  const res = await webhook.POST(new Request(`http://localhost/v1/webhooks/tradingview/${token}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: raw }), {
    params: Promise.resolve({ ingressToken: token })
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

/** A fresh Bitunix XAUUSDT price (BITUNIX_PUBLIC quote) that the mocked exchange also fills at. */
async function bitunixPrice(mark: string) {
  const at = clock.now;
  cache.putBook('BITUNIX', 'XAUUSDT', { bid: D(mark).minus('0.05').toFixed(), ask: D(mark).plus('0.05').toFixed(), last: mark, exchangeTimeMs: at.getTime(), receivedAt: at });
  cache.putMark('BITUNIX', 'XAUUSDT', { mark, index: mark, exchangeTimeMs: at.getTime(), receivedAt: at });
  const w = new BitunixQuoteWriter(direct.db, cache, { minIntervalMs: 0 });
  await w.refresh();
  expect(await w.onUpdate('XAUUSDT', at)).toBe('WRITTEN');
  x.fillPrice.XAUUSDT = mark;
}

/** Next closed 5m bar: price, alert through the webhook, then the worker drains its jobs. */
async function nextAlert(action: SignalAction, price: string) {
  bar = new Date(bar.getTime() + M5);
  clock.now = plus(new Date(bar.getTime() + M5), 3);
  setTestClock(() => clock.now);
  await bitunixPrice(price);
  const r = await post(payload(action, bar, `${price}.0`));
  await drain(clock.now);
  return r;
}

beforeAll(async () => {
  await openFromAlert({ a: null, b: null }); // seeded users and cookies, the fixture MEXC route
  idA = await userId(USERS.investorA.email);
  installLiveTestSeam({ requesterFor: () => new MockMexc(), bitunixRequesterFor: () => x, transportEnabled: true, confirm: { attempts: 2, delayMs: 0 } });
  installBitunixTestSeam({ requesterFor: () => x });

  // The published Bitunix gold perpetual (Bitunix XAUUSDT, quantity in XAU).
  const added = await call(bitunixInstrument.POST, { method: 'POST', path: '/x', cookie: cookies.admin, body: { symbol: 'BTCUSDT' } });
  const [bxBtc] = await direct.db.select().from(schema.instruments).where(eq(schema.instruments.id, added.body.instrument.id));
  const { id: _i, createdAt: _c, updatedAt: _u, ...rest } = bxBtc!;
  const [row] = await direct.db
    .insert(schema.instruments)
    .values({ ...rest, symbol: 'XAUUSDT', exchangeSymbol: 'XAUUSDT', base: 'XAU', quote: 'USDT', priceTick: '0.01', qtyStep: '0.01', minQty: '0.01', maxQty: '100', status: 'PUBLISHED', isFixture: false })
    .returning();
  xau = row!.id;
  x.setSettings('XAUUSDT', { longLeverage: 10, shortLeverage: 10 });
  expect((await call(contracts.POST, { method: 'POST', path: '/x', cookie: cookies.admin, params: { id: xau }, body: { allowed: true } })).status).toBe(200);
  for (const c of ['OPEN_WITH_ATTACHED_STOP', 'REDUCE_ONLY_CLOSE', 'STOP_RESIZE_AFTER_PARTIAL_CLOSE', 'CANCEL_STOP', 'BITUNIX_OPEN_WITH_ATTACHED_STOP', 'BITUNIX_HEDGE_CLOSE_BY_POSITION'])
    expect((await call(capabilities.POST, { method: 'POST', path: '/x', cookie: cookies.admin, body: { capability: c, state: 'PILOT_ACCEPTED', evidence: 'test: mocked exchange' } })).status).toBe(200);
  expect((await call(platform.POST, { method: 'POST', path: '/x', cookie: cookies.admin, body: { enabled: true, note: 'test' } })).status).toBe(200);

  // Lineage v-next: 5m, approves Bitunix XAUUSDT (production: v11, BITUNIX:XAUUSDT), reverses on the opposite flip.
  const version = await publishVersion({ timeframe: '5m', instrumentIds: [BTC, xau], oppositePolicy: 'CLOSE_AND_REVERSE' });

  // Investor A: verified Bitunix account (Hedge), approved, Live activated, one Live XAUUSDT block.
  x.usdt.available = '5000';
  expect((await call(conn.PUT, { method: 'PUT', cookie: cookies.a, body: { exchange: 'BITUNIX', accountRef: 'bx-a', apiKey: 'bitunix-key-a-1111', secretKey: 'bitunix-secret-a' } })).body.connection).toMatchObject({ status: 'VERIFIED', positionMode: 'HEDGE' });
  expect((await call(approve.POST, { method: 'POST', path: '/x', cookie: cookies.admin, params: { id: (await bxConn(idA)).id }, body: LIMITS })).status).toBe(200);
  expect((await call(activate.POST, { method: 'POST', path: '/v1/me/live/activate?exchange=BITUNIX', cookie: cookies.a })).status).toBe(200);
  expect((await syncBitunixConnection(direct.db, (await bxConn(idA)).id, x)).ok).toBe(true);
  const created = await call(blocks.POST, { method: 'POST', path: '/x', cookie: cookies.a, body: blockBody({ instrumentId: xau, strategyVersionId: version, mode: 'LIVE', orderCostUsdt: '100', leverage: 10, weekdays: ALL_DAYS }) });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const rs = await call(resume.POST, { method: 'POST', path: '/x', cookie: cookies.a, params: { id: created.body.id }, ifMatch: created.body.revision });
  expect(rs.status, JSON.stringify(rs.body)).toBe(200);
  block = created.body.id;
}, 120_000);

afterAll(async () => {
  installLiveTestSeam(null);
  installBitunixTestSeam(null);
  setTestClock(null);
  await teardown();
});

describe('BITUNIX:XAUUSDT.P 5m through the real webhook handler (mocked execution)', () => {
  const routesBefore: { id: string; revision: number; targets: unknown[] }[] = [];

  it('before the fix: the sanitized alert is 422 ROUTE_NOT_FOUND and recorded in the Admin rejection log', async () => {
    routesBefore.push(...(await listSignalRoutes(direct.db)).map((r) => ({ id: r.id, revision: r.revision, targets: r.targets })));
    expect(routesBefore.length).toBeGreaterThan(0); // the existing MEXC routes
    clock.now = plus(new Date(bar.getTime() + M5), 3);
    setTestClock(() => clock.now);
    const r = await post(payload('BULLISH_FLIP', bar, '4065.2'));
    expect(r).toMatchObject({ status: 422, body: { status: 'rejected', reason: 'ROUTE_NOT_FOUND', message: 'No approved route for BITUNIX:XAUUSDT.P 5m BULLISH_FLIP.' } });
    const [rej] = await listRecentRejections(direct.db, 1);
    expect(rej).toMatchObject({ reason: 'ROUTE_NOT_FOUND', httpStatus: 422, detail: { payload: { source_exchange: 'BITUNIX', source_symbol: 'XAUUSDT.P', interval: '5' } } });
    expect(x.posts).toHaveLength(0);
  });

  it('the administrator saves the 5m Bullish and Bearish routes with Bitunix XAUUSDT as signal contract', async () => {
    for (const action of ['BULLISH_FLIP', 'BEARISH_FLIP'] as const) {
      const r = await call(signalRoutes.POST, {
        method: 'POST',
        path: '/x',
        cookie: cookies.admin,
        // As typed in the form: lower-case exchange; TradingView's {{ticker}} with ".P".
        body: { name: `Gold 5m Bitunix ${action}`, sourceExchange: 'bitunix', sourceSymbol: 'xauusdt.p', interval: '5', action, kind: 'ACTIONABLE', instrumentId: xau, packageId: FIXTURE_PACKAGE, maxSignalAgeSeconds: 120, clockToleranceSeconds: 5 }
      });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
    }
    const all = await listSignalRoutes(direct.db);
    const bx = all.filter((r) => r.instrument.id === xau);
    // Stored exactly as the webhook normalizes {{exchange}} and {{ticker}} (trim + upper case; ".P" kept).
    expect(bx.map((r) => [r.sourceExchange, r.sourceSymbol, r.interval, r.action]).sort()).toEqual([
      ['BITUNIX', 'XAUUSDT.P', '5', 'BEARISH_FLIP'],
      ['BITUNIX', 'XAUUSDT.P', '5', 'BULLISH_FLIP']
    ]);
    expect(normalizeSource(' bitunix ')).toBe('BITUNIX');
    // Existing MEXC routes and their optional targets are untouched.
    for (const b of routesBefore) expect(all.find((r) => r.id === b.id)).toMatchObject({ revision: b.revision, targets: b.targets });
  });

  it('after the fix: the same alert is accepted (202) and BULLISH_FLIP opens a Long on the Bitunix block', async () => {
    const r = await post(payload('BULLISH_FLIP', bar, '4065.2'));
    expect(r.status, JSON.stringify(r.body)).toBe(202);
    const [ev] = await direct.db.select().from(schema.signalEvents).where(eq(schema.signalEvents.id, r.body.eventId as string));
    expect(ev).toMatchObject({ sourceExchange: 'BITUNIX', sourceSymbol: 'XAUUSDT.P', interval: '5', instrumentId: xau, disposition: 'DISPATCH' });

    const fresh = await nextAlert('BULLISH_FLIP', '4066');
    expect(fresh.status).toBe(202);
    const d = await decisionsOf(fresh.body.eventId as string);
    expect(d.map((x) => [x.step, x.status]).sort()).toEqual([
      ['ENTRY_SCREEN_V1', 'READY_FOR_EVALUATION'],
      ['ENTRY_V1', 'ENTRY_APPROVED']
    ]);
    expect(x.posts.at(-1)).toMatchObject({ symbol: 'XAUUSDT', side: 'BUY', tradeSide: 'OPEN', orderType: 'MARKET' });
    expect((await livePositions())[0]).toMatchObject({ status: 'OPEN', side: 'LONG', instrumentId: xau, orderBlockId: block, protectionStatus: 'PROTECTED' });
  });

  it('BEARISH_FLIP closes the Long on Bitunix and reverses to Short on the same block', async () => {
    const before = x.posts.length;
    const r = await nextAlert('BEARISH_FLIP', '4060');
    expect(r.status).toBe(202);
    await drain(clock.now);
    const d = await decisionsOf(r.body.eventId as string);
    expect(d.length).toBeGreaterThan(0);
    const sent = x.posts.slice(before);
    expect(sent.map((p) => [p.symbol, p.side, p.tradeSide])).toEqual([
      ['XAUUSDT', 'BUY', 'CLOSE'], // Bitunix Hedge mode: closing the Long leg is side BUY + tradeSide CLOSE + positionId
      ['XAUUSDT', 'SELL', 'OPEN']
    ]);
    const pos = await livePositions();
    expect(pos.map((p) => [p.side, p.status])).toEqual([
      ['SHORT', 'OPEN'],
      ['LONG', 'CLOSED']
    ]);
  });

  it('the Admin signal log shows the Bitunix source with its dispatched outcomes', async () => {
    const log = await listRecentSignalEvents(direct.db, 10);
    const bitunix = log.filter((e) => e.source === 'BITUNIX:XAUUSDT.P');
    expect(bitunix.map((e) => e.action)).toEqual(['BEARISH_FLIP', 'BULLISH_FLIP', 'BULLISH_FLIP']);
    for (const e of bitunix) expect(e).toMatchObject({ interval: '5', disposition: 'DISPATCH', job: { status: 'DONE' } });
    expect(bitunix[1]!.outcomes).toMatchObject({ ENTRY_APPROVED: 1 });
  });
});

describe('Admin Live and Operations show Bitunix on its own', () => {
  it('Live readiness is per exchange: PILOT_ACCEPTED is kept and shown, and the actual blocking conditions are named', async () => {
    // Investor B connects Bitunix but is neither approved nor activated.
    expect((await call(conn.PUT, { method: 'PUT', cookie: cookies.b, body: { exchange: 'BITUNIX', accountRef: 'bx-b', apiKey: 'bitunix-key-b-2222', secretKey: 'bitunix-secret-b' } })).body.connection).toMatchObject({ status: 'VERIFIED' });
    const d = await adminLiveData();
    const bx = d.exchanges.find((e) => e.exchange === 'BITUNIX')!;
    expect(bx.allowlisted).toEqual(['XAUUSDT']);
    // Evidence status preserved: the two recorded Bitunix capabilities stay PILOT_ACCEPTED, the third has no record.
    expect(bx.capabilities).toEqual([
      { id: 'BITUNIX_OPEN_WITH_ATTACHED_STOP', state: 'PILOT_ACCEPTED' },
      { id: 'BITUNIX_HEDGE_CLOSE_BY_POSITION', state: 'PILOT_ACCEPTED' },
      { id: 'BITUNIX_TPSL_RESIZE', state: 'PENDING' }
    ]);
    expect(d.control.capabilities.BITUNIX_OPEN_WITH_ATTACHED_STOP).toMatchObject({ state: 'PILOT_ACCEPTED', evidence: 'test: mocked exchange' });
    expect(bx.blocking.map((b) => b.reason)).toEqual(['CAPABILITY_PENDING']);
    expect(bx.blocking[0]!.text).toBe('No operator record (VERIFIED or PILOT_ACCEPTED) for BITUNIX_TPSL_RESIZE: the Bitunix adapter refuses that order type (CAPABILITY_UNVERIFIED).');
    expect(bx).toMatchObject({ readyAccounts: 1, accounts: 2 });
    // Capabilities carry their exchange, so the UI renders one evidence table per exchange.
    expect(new Set(d.capabilities.filter((c) => c.id.startsWith('BITUNIX_')).map((c) => c.exchange))).toEqual(new Set(['BITUNIX']));
    expect(d.capabilities.find((c) => c.id === 'OPEN_WITH_ATTACHED_STOP')!.exchange).toBe('MEXC');

    // Account controls are exchange-specific: A's Bitunix account is ready, B's names Bitunix (not MEXC).
    const a = d.connections.find((c) => c.exchange === 'BITUNIX' && c.owner.email === USERS.investorA.email)!;
    expect(a.blockers).toEqual([]);
    const b = d.connections.find((c) => c.exchange === 'BITUNIX' && c.owner.email === USERS.investorB.email)!;
    expect(b.blockers.map((x) => x.reason)).toEqual(['LIVE_ACCOUNT_NOT_APPROVED', 'LIVE_NOT_ACTIVATED']);
    expect(b.blockers[0]!.text).toBe('The Bitunix account has not been approved for Live trading by an administrator.');
    expect(b.blockers.map((x) => x.text).join(' ')).not.toMatch(/MEXC/);
  });

  it('Operations shows feed health per exchange and contract: the healthy Bitunix XAUUSDT stream is visible next to MEXC', async () => {
    const ops = await getOperationsStatus(direct.db, clock.now);
    const row = ops.feed.contracts.find((c) => c.instrumentId === xau)!;
    // No candle-sync status row exists for this contract; its own BITUNIX_PUBLIC quotes decide.
    expect(row).toMatchObject({ exchange: 'BITUNIX', exchangeSymbol: 'XAUUSDT', feed: { source: 'BITUNIX_PUBLIC', state: 'HEALTHY' }, latestQuote: { source: 'BITUNIX_PUBLIC', freshness: 'FRESH' } });
    expect(ops.feed.contracts.find((c) => c.instrumentId === BTC)).toMatchObject({ exchange: 'MEXC', exchangeSymbol: 'BTC_USDT' });
    expect(ops.alerts.map((x) => x.message).join('\n')).not.toMatch(/XAUUSDT feed/);
  });
});
