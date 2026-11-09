// Public MEXC WebSocket as the primary ticker source. The stream is driven directly (ingest calls
// and a fake connectivity view); the feed, database, NOTIFY, quote routes and SSE are the real ones.
// Checks: WS quotes are stored and labelled, no REST ticker call while the stream is healthy, REST
// errors (incl. 510 rate limit) never mark a contract DOWN while WS quotes are fresh, freshness is
// tracked per contract separately from socket connectivity, the optional REST fallback is labelled
// and rate-limited, and stored quotes reach browsers over SSE within a second.
import { desc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  latestQuote,
  MarketFeed,
  MexcPublicError,
  QUOTE_NOTIFY_CHANNEL,
  QuoteListener,
  recordMarketTick,
  schema,
  type MexcContractDetail,
  type MexcKline,
  type MexcTicker,
  type PublicMarketSource,
  type QuoteHubEvent,
  type StreamTicker,
  type TickerStreamView
} from '@trendpilot/db';
import { INTERVAL_MS, type CandleInterval } from '@trendpilot/domain';
import * as quotesRoute from '@/app/v1/market/quotes/route';
import * as streamRoute from '@/app/v1/market/quotes/stream/route';
import * as feeds from '@/app/v1/admin/market-feeds/route';
import { setTestClock } from '@/server/clock';
import { closeQuoteHub } from '@/server/quoteHub';
import { BTC, call, direct, ETH, resetAndSeed, signIn, teardown, USERS, XRP_DISABLED } from '../helpers';
import { testDatabaseUrl } from '../testDb';

const clock = { now: new Date('2026-11-09T10:00:00Z') };
const advance = (ms: number) => (clock.now = new Date(clock.now.getTime() + ms));

class RestStub implements PublicMarketSource {
  calls: string[] = [];
  klineError: MexcPublicError | null = null;
  tickerBid = 70000;
  readonly requestCounts: Record<string, number> = {};
  private count(k: string, what: string) {
    this.calls.push(what);
    this.requestCounts[k] = (this.requestCounts[k] ?? 0) + 1;
  }
  async serverTimeMs() {
    this.count('ping', 'ping');
    return clock.now.getTime();
  }
  async ticker(sym: string): Promise<MexcTicker> {
    this.count('ticker', `ticker ${sym}`);
    const b = this.tickerBid;
    return { exchangeSymbol: sym, bid: String(b), ask: String(b + 0.5), mark: String(b + 0.2), last: String(b), index: null, exchangeTimeMs: clock.now.getTime() - 300 };
  }
  async klines(sym: string, interval: CandleInterval, from: Date, to: Date): Promise<MexcKline[]> {
    this.count('kline', `kline ${sym} ${interval}`);
    if (this.klineError) throw this.klineError;
    const ms = INTERVAL_MS[interval];
    const out: MexcKline[] = [];
    for (let t = Math.ceil(from.getTime() / ms) * ms; t <= to.getTime(); t += ms) out.push({ openTime: new Date(t), open: '70000', high: '70010', low: '69990', close: '70005' });
    return out;
  }
  async contractDetail(sym: string): Promise<MexcContractDetail> {
    this.count('detail', `detail ${sym}`);
    const spec = sym === 'BTC_USDT' ? { contractSize: '0.0001', priceUnit: '0.1' } : { contractSize: '0.01', priceUnit: '0.01' };
    return { exchangeSymbol: sym, ...spec, volUnit: '1', minVol: '1', maxVol: '1000000', state: 0, apiAllowed: true };
  }
}

class FakeStream implements TickerStreamView {
  up = true;
  since: Date | null = new Date(clock.now);
  connected() {
    return this.up;
  }
  connectedSince() {
    return this.up ? this.since : null;
  }
}

const rest = new RestStub();
const stream = new FakeStream();
let feed: MarketFeed;
let cookies: { admin: string; investor: string };

const wsTick = (sym: string, bid: number, exchangeLagMs = 500): StreamTicker => ({
  exchangeSymbol: sym,
  bid: String(bid),
  ask: String(bid + 0.1),
  mark: String(bid + 0.05),
  last: String(bid),
  index: null,
  exchangeTimeMs: clock.now.getTime() - exchangeLagMs,
  receivedAt: new Date(clock.now)
});
const status = async (id = BTC) => (await direct.db.select().from(schema.marketFeedStatus).where(eq(schema.marketFeedStatus.instrumentId, id)))[0]!;
const newestQuote = async (id = BTC) => (await direct.db.select().from(schema.marketQuotes).where(eq(schema.marketQuotes.instrumentId, id)).orderBy(desc(schema.marketQuotes.asOf)).limit(1))[0];
const events = async (kind: string) => (await direct.db.select().from(schema.marketFeedEvents).where(eq(schema.marketFeedEvents.kind, kind))).map((e) => e.message);
const tickerCalls = () => rest.calls.filter((c) => c.startsWith('ticker')).length;

beforeAll(async () => {
  await resetAndSeed();
  setTestClock(() => clock.now);
  cookies = { admin: await signIn(USERS.admin.email), investor: await signIn(USERS.investorA.email) };
  feed = new MarketFeed(direct.db, { source: rest, now: () => clock.now, stream, backfillBars: 210, rand: () => 0.5, restFallback: { enabled: false } });
  feed.setClockOffset(0);
});

afterAll(async () => {
  setTestClock(null);
  await closeQuoteHub();
  await teardown();
});

describe('WebSocket is the primary ticker source', () => {
  it('a push.ticker is stored as MEXC_PUBLIC via WebSocket, queues its market.tick job, and the contract is HEALTHY', async () => {
    await feed.refreshCoverage();
    expect(feed.coveredExchangeSymbols).toEqual(expect.arrayContaining(['BTC_USDT', 'ETH_USDT']));
    expect(await feed.ingestStreamTicker(wsTick('BTC_USDT', 70000))).toBe('WRITTEN');
    const q = (await newestQuote())!;
    expect(q).toMatchObject({ source: 'MEXC_PUBLIC', channel: 'WS' });
    expect(Number(q.bid)).toBe(70000);
    expect(q.asOf.toISOString()).toBe('2026-11-09T09:59:59.500Z'); // exchange time, offset 0
    const s = await status();
    expect(s).toMatchObject({ state: 'HEALTHY', quoteChannel: 'WS' });
    expect(s.lastStreamAt?.toISOString()).toBe('2026-11-09T10:00:00.000Z');
    const jobs = await direct.db.select().from(schema.jobs).where(eq(schema.jobs.kind, 'market.tick'));
    expect(jobs.some((j) => (j.payload as { instrumentId: string; source: string }).instrumentId === BTC)).toBe(true);
    // The entry check reads the same quote.
    expect((await latestQuote(direct.db, BTC, clock.now))?.source).toBe('MEXC_PUBLIC');
  });

  it('a repeated exchange timestamp is not written twice', async () => {
    const t = wsTick('BTC_USDT', 70000);
    t.exchangeTimeMs = Date.parse('2026-11-09T09:59:59.500Z');
    expect(await feed.ingestStreamTicker(t)).toBe('REPEAT');
  });

  it('the cycle makes zero REST ticker calls while WebSocket quotes are fresh (REST only for detail and candles)', async () => {
    await feed.ingestStreamTicker(wsTick('ETH_USDT', 3500));
    for (let i = 0; i < 5; i++) {
      advance(2_000);
      await feed.ingestStreamTicker(wsTick('BTC_USDT', 70000 + i));
      await feed.ingestStreamTicker(wsTick('ETH_USDT', 3500 + i));
      const s = await feed.cycle();
      expect(s.instruments.filter((r) => r.symbol !== 'XRPUSDT').every((r) => r.state === 'HEALTHY')).toBe(true);
    }
    expect(tickerCalls()).toBe(0);
    expect(rest.calls.filter((c) => c === 'ping')).toHaveLength(0); // clock comes from WebSocket pongs
    expect(rest.calls.some((c) => c.startsWith('kline'))).toBe(true); // closed-candle backfill still uses REST
  });

  it('a REST 510 (IP rate limit) does not mark a contract DOWN while fresh WebSocket quotes arrive, and pauses REST', async () => {
    // Force a candle sync to be due.
    await direct.db.update(schema.marketFeedStatus).set({ lastCandleOpen: null });
    rest.klineError = new MexcPublicError('kline BTC_USDT: Requests are too frequent (code 510)', 'API', 510);
    advance(2_000);
    await feed.ingestStreamTicker(wsTick('BTC_USDT', 70100));
    await feed.ingestStreamTicker(wsTick('ETH_USDT', 3600));
    const before = rest.calls.length;
    const s = await feed.cycle();
    const btc = s.instruments.find((r) => r.exchangeSymbol === 'BTC_USDT')!;
    expect(btc.state).toBe('HEALTHY');
    expect(btc.error).toMatch(/REST: .*510/);
    expect((await status()).state).toBe('HEALTHY');
    expect((await status()).lastError).toMatch(/^REST: .*510/);
    expect(await events('STATE_CHANGED')).not.toContainEqual(expect.stringContaining('→ DOWN'));
    expect(feed.restPausedUntil).toBeGreaterThan(clock.now.getTime());
    // During the cooldown no REST call at all is made; quotes keep flowing over the WebSocket.
    const afterFirst = rest.calls.length;
    expect(afterFirst - before).toBe(1);
    for (let i = 0; i < 3; i++) {
      advance(2_000);
      await feed.ingestStreamTicker(wsTick('BTC_USDT', 70200 + i));
      await feed.ingestStreamTicker(wsTick('ETH_USDT', 3700 + i));
      const c = await feed.cycle();
      expect(c.instruments.find((r) => r.exchangeSymbol === 'BTC_USDT')).toMatchObject({ state: 'HEALTHY', skipped: 'RATE_LIMIT' });
    }
    expect(rest.calls.length).toBe(afterFirst);
    // After the cooldown REST resumes and the error clears.
    rest.klineError = null;
    advance(75_000);
    await feed.ingestStreamTicker(wsTick('BTC_USDT', 70300));
    await feed.ingestStreamTicker(wsTick('ETH_USDT', 3800));
    await feed.cycle();
    expect(await status()).toMatchObject({ state: 'HEALTHY', consecutiveFailures: 0, lastError: null });
  });

  it('freshness is per contract: one contract going quiet on a connected socket is STALE, the other stays HEALTHY', async () => {
    for (let i = 0; i < 9; i++) {
      advance(2_000);
      await feed.ingestStreamTicker(wsTick('ETH_USDT', 3900 + i)); // BTC receives nothing
      await feed.cycle();
    }
    expect((await status(BTC)).state).toBe('STALE');
    expect((await status(ETH)).state).toBe('HEALTHY');
    expect(tickerCalls()).toBe(0); // fallback is off: still no REST ticker
  });

  it('a disconnected socket with no fresh quote is DOWN; reconnect + push recovers and records the unverified window', async () => {
    stream.up = false;
    advance(16_000);
    await feed.cycle();
    expect((await status(BTC)).state).toBe('DOWN');
    expect((await status(ETH)).state).toBe('DOWN');
    expect((await status(BTC)).stateSince).toBeTruthy();
    stream.up = true;
    stream.since = new Date(clock.now);
    advance(1_000);
    expect(await feed.ingestStreamTicker(wsTick('BTC_USDT', 71000))).toBe('WRITTEN');
    expect((await status(BTC)).state).toBe('HEALTHY');
    expect(await events('RECOVERED')).toContainEqual(expect.stringMatching(/recovered from DOWN \(WebSocket\)/));
    expect((await events('UNVERIFIED_INTERVAL')).length).toBeGreaterThan(0);
  });

  it('stale-price rules are unchanged: an old exchange timestamp is not stored', async () => {
    expect(await feed.ingestStreamTicker(wsTick('ETH_USDT', 4000, 20_000))).toBe('STALE');
    expect((await status(ETH)).state).toBe('STALE');
  });

  it('explicitly enabled REST fallback reads the ticker only when the stream is not fresh, labels it, and rate-limits it', async () => {
    const fb = new MarketFeed(direct.db, { source: rest, now: () => clock.now, stream, backfillBars: 210, rand: () => 0.5, restFallback: { enabled: true, minIntervalMs: 10_000 } });
    fb.setClockOffset(0);
    await fb.refreshCoverage();
    const t0 = tickerCalls();
    advance(2_000);
    await fb.ingestStreamTicker(wsTick('BTC_USDT', 71100));
    await fb.cycle(); // BTC fresh via WS → no fallback; ETH stale → one fallback read
    expect(rest.calls.slice(-20).filter((c) => c === 'ticker ETH_USDT')).toHaveLength(1);
    expect(tickerCalls() - t0).toBe(1);
    const eq1 = (await newestQuote(ETH))!;
    expect(eq1.channel).toBe('REST_FALLBACK');
    expect((await status(ETH)).state).toBe('HEALTHY');
    // Fallback quote ages out; the next fallback read waits for the minimum interval.
    advance(16_000);
    await fb.ingestStreamTicker(wsTick('BTC_USDT', 71200));
    await fb.cycle();
    expect(tickerCalls() - t0).toBe(2);
    advance(2_000);
    await fb.ingestStreamTicker(wsTick('BTC_USDT', 71300));
    await fb.cycle();
    expect(tickerCalls() - t0).toBe(2);
    expect(rest.calls.filter((c) => c === 'ticker BTC_USDT')).toHaveLength(0);
  });
});

describe('quotes reach the UI from TrendPilot, never from MEXC', () => {
  it('GET /v1/market/quotes returns the latest stored quote with its source label; investors see published contracts only', async () => {
    advance(1_000);
    await feed.ingestStreamTicker(wsTick('BTC_USDT', 72000));
    const calls = rest.calls.length;
    const inv = await call(quotesRoute.GET as never, { path: '/v1/market/quotes', cookie: cookies.investor });
    expect(inv.status).toBe(200);
    const btc = inv.body.items.find((i: { instrumentId: string }) => i.instrumentId === BTC);
    expect(btc.quote).toMatchObject({ source: 'MEXC_PUBLIC', channel: 'WS', sourceLabel: 'MEXC public market data · WebSocket' });
    expect(Number(btc.quote.bid)).toBe(72000);
    expect(inv.body.items.some((i: { instrumentId: string }) => i.instrumentId === XRP_DISABLED)).toBe(false);
    const adm = await call(quotesRoute.GET as never, { path: '/v1/market/quotes', cookie: cookies.admin });
    expect(adm.body.items.some((i: { instrumentId: string }) => i.instrumentId === XRP_DISABLED)).toBe(true);
    expect(rest.calls.length).toBe(calls); // refresh never calls the exchange
    expect((await call(quotesRoute.GET as never, { path: '/v1/market/quotes' })).status).toBe(401);
  });

  it('admin feed view shows the quote channel and REST fallback label', async () => {
    const r = await call(feeds.GET as never, { path: '/v1/admin/market-feeds', cookie: cookies.admin });
    const eth = r.body.items.find((i: { instrumentId: string }) => i.instrumentId === ETH);
    expect(eth.latestQuote.sourceLabel).toMatch(/MEXC public market data · (WebSocket|REST fallback)/);
    expect(r.body).toHaveProperty('transport');
  });

  it('every stored quote is NOTIFYed on commit', async () => {
    const l = new QuoteListener({ connectionString: testDatabaseUrl() });
    const got: QuoteHubEvent[] = [];
    l.subscribe((e) => got.push(e));
    for (let i = 0; i < 50 && !l.connectedSince; i++) await new Promise((r) => setTimeout(r, 20));
    advance(1_000);
    await recordMarketTick(direct.db, { instrumentId: BTC, asOf: new Date(clock.now), bid: '72100', ask: '72100.1', mark: '72100.05', last: '72100', source: 'MEXC_PUBLIC', channel: 'WS', receivedAt: new Date(clock.now) });
    for (let i = 0; i < 50 && got.length === 0; i++) await new Promise((r) => setTimeout(r, 20));
    await l.close();
    expect(QUOTE_NOTIFY_CHANNEL).toBe('market_quote');
    expect(got[0]).toMatchObject({ kind: 'quote', note: { instrumentId: BTC, bid: '72100', channel: 'WS', source: 'MEXC_PUBLIC' } });
  });

  it('SSE: a snapshot, then each stored quote is pushed to the browser within one second', async () => {
    const ac = new AbortController();
    const res = await streamRoute.GET(new Request('http://localhost:3000/v1/market/quotes/stream', { headers: { cookie: cookies.investor }, signal: ac.signal }));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/event-stream/);
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = '';
    const next = async (event: string, timeoutMs: number) => {
      const until = Date.now() + timeoutMs;
      for (;;) {
        const m = new RegExp(`event: ${event}\\ndata: (.*)\\n\\n`).exec(buf);
        if (m) {
          buf = buf.slice(m.index + m[0].length);
          return JSON.parse(m[1]!);
        }
        if (Date.now() > until) throw new Error(`no ${event} event within ${timeoutMs} ms`);
        const r = await Promise.race([reader.read(), new Promise<{ done: true; value: undefined }>((r) => setTimeout(() => r({ done: true, value: undefined }), until - Date.now()))]);
        if (r.value) buf += dec.decode(r.value, { stream: true });
      }
    };
    const snap = await next('snapshot', 3_000);
    expect(snap.items.find((i: { instrumentId: string }) => i.instrumentId === BTC).quote.channel).toBe('WS');
    // Wait until the shared listener is connected, then store a quote as the feed would.
    for (let i = 0; i < 50; i++) {
      const { quoteHub } = await import('@/server/quoteHub');
      if (quoteHub().connectedSince) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    advance(1_000);
    const t0 = Date.now();
    expect(await feed.ingestStreamTicker(wsTick('BTC_USDT', 72500))).toBe('WRITTEN');
    const q = await next('quote', 1_000);
    expect(Date.now() - t0).toBeLessThan(1_000);
    expect(q).toMatchObject({ instrumentId: BTC, channel: 'WS', sourceLabel: 'MEXC public market data · WebSocket' });
    expect(Number(q.bid)).toBe(72500);
    expect(q.receivedAt).toBe(clock.now.toISOString());
    // A disabled contract's quote is not sent to investors.
    await recordMarketTick(direct.db, { instrumentId: XRP_DISABLED, asOf: new Date(clock.now), bid: '1', ask: '1.1', mark: '1.05', last: '1', source: 'FIXTURE' });
    await expect(next('quote', 400)).rejects.toThrow(/no quote/);
    ac.abort();
    await reader.cancel().catch(() => undefined);
  });
});
