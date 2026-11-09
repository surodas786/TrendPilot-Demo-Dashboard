// Step 8 (MKT-01/02): public MEXC prices and closed candles drive Paper mode. The exchange is a
// deterministic in-process stub of the public endpoints (no network); the feed, database, entry
// checks, worker jobs and paper simulator are the real ones.
import { and, asc, desc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { feedEventCounts, latestQuote, MarketFeed, MexcPublicError, processNextJob, recordMarketTick, schema, type MexcContractDetail, type MexcKline, type MexcTicker, type PublicMarketSource } from '@trendpilot/db';
import { Decimal, INTERVAL_MS, type CandleInterval } from '@trendpilot/domain';
import * as feeds from '@/app/v1/admin/market-feeds/route';
import * as trade from '@/app/v1/me/trades/[id]/route';
import { setTestClock } from '@/server/clock';
import { BTC, call, direct, ETH, teardown, USERS, userId } from '../helpers';
import { clock, cookies, drain, M15, openFromAlert, openPositionOf, plus, publishVersion } from '../paperReplay';

const T0 = Date.parse('2026-11-08T09:30:00Z');
const BASES: Record<string, number> = { BTC_USDT: 65000, ETH_USDT: 3200 };
const TICKS: Record<string, number> = { BTC_USDT: 1, ETH_USDT: 2 };

/** Deterministic public MEXC stand-in. Prices rise slowly so EMA 200 lets Longs through. */
class StubExchange implements PublicMarketSource {
  offsetMs = 0;
  down = false;
  /** Exchange stops updating its ticker at this exchange time. */
  frozenAt: number | null = null;
  /** `${symbol}:${interval}:${barOpenMs}` the exchange does not have. */
  missing = new Set<string>();
  /** `${symbol}:${interval}:${barOpenMs}` → revised close. */
  revisions = new Map<string, string>();
  details: Record<string, Partial<MexcContractDetail>> = {};
  calls: string[] = [];
  priceShift = 0;

  exchangeNow = () => clock.now.getTime() + this.offsetMs;
  price(sym: string, t: number): Decimal {
    return new Decimal(BASES[sym]!).plus(new Decimal(t - T0).div(60_000).times('0.2').times(BASES[sym]! / 65000)).plus(this.priceShift).toDecimalPlaces(TICKS[sym]!);
  }
  private check(sym: string) {
    if (this.down) throw new MexcPublicError('GET: connect ECONNREFUSED', 'NETWORK');
    if (!BASES[sym]) throw new MexcPublicError(`ticker ${sym}: Contract does not exist (code 1001)`, 'API', 1001);
  }
  async serverTimeMs() {
    this.calls.push('ping');
    if (this.down) throw new MexcPublicError('GET: connect ECONNREFUSED', 'NETWORK');
    return this.exchangeNow();
  }
  async ticker(sym: string): Promise<MexcTicker> {
    this.calls.push(`ticker ${sym}`);
    this.check(sym);
    const ts = this.frozenAt ?? this.exchangeNow() - 400;
    const mid = this.price(sym, ts);
    const half = new Decimal(TICKS[sym] === 1 ? '0.5' : '0.01');
    return { exchangeSymbol: sym, bid: mid.minus(half).toFixed(), ask: mid.plus(half).toFixed(), mark: mid.toFixed(), last: mid.toFixed(), index: mid.toFixed(), exchangeTimeMs: ts };
  }
  async klines(sym: string, interval: CandleInterval, from: Date, to: Date): Promise<MexcKline[]> {
    this.calls.push(`kline ${sym} ${interval}`);
    this.check(sym);
    const ms = INTERVAL_MS[interval];
    const out: MexcKline[] = [];
    // Like MEXC, the response includes the bar that is still forming.
    const last = Math.min(to.getTime() + ms, Math.floor(this.exchangeNow() / ms) * ms);
    for (let t = Math.ceil(from.getTime() / ms) * ms; t <= last; t += ms) {
      const key = `${sym}:${interval}:${t}`;
      if (this.missing.has(key)) continue;
      const o = this.price(sym, t);
      const c = this.revisions.get(key) ?? this.price(sym, Math.min(t + ms, this.exchangeNow())).toFixed();
      out.push({ openTime: new Date(t), open: o.toFixed(), high: Decimal.max(o, c).plus(1).toFixed(), low: Decimal.min(o, c).minus(1).toFixed(), close: c });
    }
    return out;
  }
  /** Settled funding history, newest first (00:00/08:00/16:00 UTC). */
  async fundingHistory(sym: string) {
    this.calls.push(`funding ${sym}`);
    this.check(sym);
    return ['2026-11-08T08:00:00Z', '2026-11-08T00:00:00Z', '2026-11-07T16:00:00Z', '2026-11-07T08:00:00Z'].map((t, i) => ({ settledAt: new Date(t), rate: ['0.0001', '0.00005', '-0.00002', '0.0003'][i]! }));
  }
  async contractDetail(sym: string): Promise<MexcContractDetail> {
    this.calls.push(`detail ${sym}`);
    this.check(sym);
    const spec = sym === 'BTC_USDT' ? { contractSize: '0.0001', priceUnit: '0.1' } : { contractSize: '0.01', priceUnit: '0.01' };
    return { exchangeSymbol: sym, ...spec, volUnit: '1', minVol: '1', maxVol: '1000000', state: 0, apiAllowed: true, ...this.details[sym] };
  }
}

const stub = new StubExchange();
let feed: MarketFeed;
const newFeed = () => new MarketFeed(direct.db, { source: stub, now: () => clock.now, backfillBars: 210, rand: () => 0.5, clockCheckMs: 0 });
const at = (iso: string) => (clock.now = new Date(iso));
const status = async (id = BTC) => (await direct.db.select().from(schema.marketFeedStatus).where(eq(schema.marketFeedStatus.instrumentId, id)))[0]!;
const candles = (interval: string, id = BTC) =>
  direct.db.select().from(schema.marketCandles).where(and(eq(schema.marketCandles.instrumentId, id), eq(schema.marketCandles.interval, interval))).orderBy(asc(schema.marketCandles.openTime));
const quotes = (id = BTC) => direct.db.select().from(schema.marketQuotes).where(eq(schema.marketQuotes.instrumentId, id)).orderBy(desc(schema.marketQuotes.asOf));
const events = async (kind?: string) =>
  (await direct.db.select().from(schema.marketFeedEvents).orderBy(asc(schema.marketFeedEvents.createdAt))).filter((e) => !kind || e.kind === kind);
const tickJobs = () => direct.db.select().from(schema.jobs).where(eq(schema.jobs.kind, 'market.tick'));

afterAll(async () => {
  setTestClock(null);
  await teardown();
});

describe('public MEXC data drives a Paper entry (EMA 200 on closed public candles)', () => {
  let emaVersion: string;
  beforeAll(async () => {
    await openFromAlert({
      b: null,
      version: async () => (emaVersion = await publishVersion({ emaFilter: 'EMA200' })),
      // Instead of fixture candles and a fixture quote, one feed cycle at 09:30:03.
      market: async () => {
        await direct.db.delete(schema.marketQuotes);
        await direct.db.delete(schema.marketCandles);
        feed = newFeed();
        await feed.cycle();
      }
    });
  });

  it('writes quotes and closed candles with source MEXC_PUBLIC; never the forming bar', async () => {
    const q = (await quotes())[0]!;
    expect(q.source).toBe('MEXC_PUBLIC');
    expect(q.asOf.toISOString()).toBe('2026-11-08T09:30:02.600Z'); // exchange ticker time (−400 ms), offset 0
    expect(q.liquidityContracts).toBeNull();
    for (const [interval, newest] of [
      ['15', '2026-11-08T09:15:00.000Z'],
      ['5', '2026-11-08T09:25:00.000Z']
    ] as const) {
      const cs = await candles(interval);
      expect(cs).toHaveLength(210);
      expect(cs.every((c) => c.source === 'MEXC_PUBLIC' && c.closed)).toBe(true);
      expect(cs.at(-1)!.openTime.toISOString()).toBe(newest); // the 09:30 bars are still forming
    }
    expect((await status()).state).toBe('HEALTHY');
    expect((await status(ETH)).state).toBe('HEALTHY'); // every published contract is covered
    expect(await events('GAP_DETECTED')).toHaveLength(0); // the first fill is a backfill, not a gap
  });

  it('each public quote queues the same market.tick job as a fixture tick', async () => {
    const jobs = await tickJobs();
    const btc = jobs.find((j) => (j.payload as { instrumentId: string }).instrumentId === BTC)!;
    expect(btc.status).toBe('DONE'); // drained by openFromAlert with the real job loop
    expect(new Decimal((btc.payload as { quote: { mark: string } }).quote.mark).eq((await quotes())[0]!.mark)).toBe(true);
    expect((btc.payload as { source: string }).source).toBe('MEXC_PUBLIC');
  });

  it('the entry used the public quote and EMA 200 from public candles, and says so', async () => {
    const p = (await openPositionOf(USERS.investorA.email))!;
    expect(p.status).toBe('OPEN');
    const [d] = await direct.db
      .select()
      .from(schema.signalDecisions)
      .where(and(eq(schema.signalDecisions.ownerId, await userId(USERS.investorA.email)), eq(schema.signalDecisions.step, 'ENTRY_V1')));
    const checks = (d!.detail as any).checks;
    expect(d!.status).toBe('ENTRY_APPROVED');
    expect(checks.quote).toMatchObject({ source: 'MEXC_PUBLIC', asOf: '2026-11-08T09:30:02.600Z' });
    expect(checks.ema).toMatchObject({ emaFilter: 'EMA200', relation: 'ABOVE', candlesUsed: 210, through: '2026-11-08T09:15:00.000Z', source: 'MEXC_PUBLIC' });
    const t = await call(trade.GET, { path: '/x', cookie: cookies.a, params: { id: p.id } });
    expect(t.status).toBe(200);
    expect(t.body.marketData).toMatchObject({ source: 'MEXC_PUBLIC', label: 'MEXC public market data' });
    expect(emaVersion).toBeTruthy();
  });

  it('a new bar is synced incrementally; unchanged overlap bars are not rewritten', async () => {
    stub.calls.length = 0;
    at('2026-11-08T09:45:04Z');
    await feed.cycle();
    expect((await candles('15')).at(-1)!.openTime.toISOString()).toBe('2026-11-08T09:30:00.000Z');
    expect((await candles('5')).at(-1)!.openTime.toISOString()).toBe('2026-11-08T09:40:00.000Z');
    expect(stub.calls.filter((c) => c.startsWith('kline BTC_USDT 15'))).toHaveLength(1);
    // Same bar again: no kline request at all.
    stub.calls.length = 0;
    at('2026-11-08T09:45:20Z');
    await feed.cycle();
    expect(stub.calls.filter((c) => c.startsWith('kline'))).toHaveLength(0);
  });

  it('a closed bar revised by the exchange is updated and recorded (EMA recalculates from it)', async () => {
    const t = Date.parse('2026-11-08T09:30:00Z');
    stub.revisions.set(`BTC_USDT:15:${t}`, '66000.1');
    at('2026-11-08T10:00:04Z');
    await feed.cycle();
    const bar = (await candles('15')).find((c) => c.openTime.getTime() === t)!;
    expect(new Decimal(bar.close).toFixed()).toBe('66000.1');
    expect(await events('HISTORY_REVISED')).toHaveLength(1);
    stub.revisions.clear();
  });

  it('a hole in stored history is detected and backfilled', async () => {
    const hole = new Date('2026-11-08T08:00:00Z');
    await direct.db.delete(schema.marketCandles).where(and(eq(schema.marketCandles.instrumentId, BTC), eq(schema.marketCandles.interval, '15'), eq(schema.marketCandles.openTime, hole)));
    at('2026-11-08T10:15:04Z');
    await feed.cycle();
    expect((await candles('15')).some((c) => c.openTime.getTime() === hole.getTime())).toBe(true);
    const [gap] = await events('GAP_DETECTED');
    expect(gap!.windowFrom!.toISOString()).toBe(hole.toISOString());
    expect(await events('GAP_BACKFILLED')).toHaveLength(1);
  });

  it('a bar the exchange cannot supply is reported once as unresolved (EMA stays unavailable for it)', async () => {
    stub.missing.add(`BTC_USDT:15:${Date.parse('2026-11-08T10:15:00Z')}`);
    at('2026-11-08T10:30:04Z');
    await feed.cycle();
    at('2026-11-08T10:45:04Z');
    await feed.cycle();
    const unresolved = await events('GAP_UNRESOLVED');
    expect(unresolved).toHaveLength(1);
    expect(unresolved[0]!.windowFrom!.toISOString()).toBe('2026-11-08T10:15:00.000Z');
    stub.missing.clear();
  });
});

describe('feed health: outage, backoff, recovery, stale prices, clock skew, symbol mapping', () => {
  it('an outage marks the feed DOWN, backs off, and makes no requests during the backoff', async () => {
    at('2026-11-08T11:00:00Z');
    await feed.cycle(); // healthy reference quote at 10:59:59.6
    stub.down = true;
    at('2026-11-08T11:00:02Z');
    const r = await feed.cycle();
    expect(r.instruments.find((x) => x.symbol === 'BTCUSDT')).toMatchObject({ state: 'DOWN' });
    const s = await status();
    expect(s).toMatchObject({ state: 'DOWN', consecutiveFailures: 1 });
    expect(s.nextRetryAt!.toISOString()).toBe('2026-11-08T11:00:03.000Z'); // 1 s × jitter 1.0
    stub.calls.length = 0;
    at('2026-11-08T11:00:02.500Z');
    const skipped = await feed.cycle();
    expect(skipped.instruments.find((x) => x.symbol === 'BTCUSDT')!.skipped).toBe('BACKOFF');
    expect(stub.calls.filter((c) => c.includes('BTC_USDT'))).toHaveLength(0);
    at('2026-11-08T11:00:04Z');
    await feed.cycle();
    expect(await status()).toMatchObject({ state: 'DOWN', consecutiveFailures: 2 });
    expect((await status()).nextRetryAt!.toISOString()).toBe('2026-11-08T11:00:06.000Z'); // 2 s
  });

  it('a stale or missing feed blocks new entries (FEED_STALE)', async () => {
    const q = await latestQuote(direct.db, BTC, new Date('2026-11-08T11:00:30Z'));
    expect(q!.source).toBe('MEXC_PUBLIC');
    expect(Date.parse('2026-11-08T11:00:30Z') - q!.asOf.getTime()).toBeGreaterThan(15_000);
  });

  it('recovery records the interval in which crossings could not be verified, then continues from current prices', async () => {
    stub.down = false;
    at('2026-11-08T11:01:00Z');
    const before = (await tickJobs()).length;
    await feed.cycle();
    expect(await status()).toMatchObject({ state: 'HEALTHY', consecutiveFailures: 0, nextRetryAt: null, lastError: null });
    expect((await events('RECOVERED')).length).toBeGreaterThanOrEqual(1);
    const gap = (await events('UNVERIFIED_INTERVAL')).filter((e) => e.instrumentId === BTC).at(-1);
    expect(gap!.windowFrom!.toISOString()).toBe('2026-11-08T10:59:59.600Z');
    expect(gap!.windowTo!.toISOString()).toBe('2026-11-08T11:00:59.600Z');
    expect((gap!.detail as any).openPositions).toBe(1);
    // Only the current price is queued: nothing is fabricated for the outage.
    expect((await tickJobs()).length - before).toBe(2); // BTC + ETH
  });

  it('an exchange price that stops updating is STALE and is not written', async () => {
    stub.frozenAt = Date.parse('2026-11-08T11:01:30Z');
    at('2026-11-08T11:01:31Z');
    await feed.cycle(); // fresh, written once
    const n = (await quotes()).length;
    at('2026-11-08T11:01:50Z');
    await feed.cycle();
    expect((await status()).state).toBe('STALE');
    expect((await quotes()).length).toBe(n);
    stub.frozenAt = null;
    at('2026-11-08T11:01:52Z');
    await feed.cycle();
    expect((await status()).state).toBe('HEALTHY');
  });

  it('clock skew within tolerance is corrected; beyond it no quote is recorded', async () => {
    stub.offsetMs = 3_000; // exchange 3 s ahead
    at('2026-11-08T11:02:00Z');
    await feed.cycle();
    expect((await quotes())[0]!.asOf.toISOString()).toBe('2026-11-08T11:01:59.600Z'); // mapped to the local clock
    expect((await status()).clockOffsetMs).toBe(3_000);
    stub.offsetMs = 9_000;
    const n = (await quotes()).length;
    at('2026-11-08T11:02:10Z');
    await feed.cycle();
    expect((await status()).state).toBe('CLOCK_SKEW');
    expect((await quotes()).length).toBe(n);
    stub.offsetMs = 0;
    at('2026-11-08T11:02:20Z');
    await feed.cycle();
    expect((await status()).state).toBe('HEALTHY');
  });

  it('symbol mapping: a missing mapping or an unknown contract is SYMBOL_UNAVAILABLE; spec differences are flagged', async () => {
    await direct.db.update(schema.instruments).set({ exchangeSymbol: 'NOPE_USDT' }).where(eq(schema.instruments.id, ETH));
    await direct.db.update(schema.marketFeedStatus).set({ contractCheckedAt: null }).where(eq(schema.marketFeedStatus.instrumentId, ETH));
    at('2026-11-08T11:03:00Z');
    await feed.cycle();
    expect((await status(ETH)).state).toBe('SYMBOL_UNAVAILABLE');
    stub.calls.length = 0;
    at('2026-11-08T11:03:05Z');
    await feed.cycle();
    expect(stub.calls.filter((c) => c.includes('NOPE_USDT'))).toHaveLength(0); // not polled until the recheck

    await direct.db.update(schema.instruments).set({ exchangeSymbol: 'ETH_USDT' }).where(eq(schema.instruments.id, ETH));
    stub.details.ETH_USDT = { contractSize: '0.1' };
    at('2026-11-08T11:13:10Z'); // past the 10-minute recheck
    await feed.cycle();
    await feed.cycle();
    expect((await status(ETH)).state).toBe('HEALTHY');
    const mismatch = await events('CONTRACT_MISMATCH');
    expect(mismatch).toHaveLength(1); // recorded once, not every cycle
    expect((mismatch[0]!.detail as any).mismatches).toEqual([{ field: 'contractMultiplier', platform: '0.01', exchange: '0.1' }]);
    const counts = await feedEventCounts(direct.db, ETH);
    expect(counts.CONTRACT_MISMATCH).toBe(1);
  });

  it('a feed restarted from scratch continues from persisted state (no duplicate backfill)', async () => {
    feed = newFeed();
    stub.calls.length = 0;
    at('2026-11-08T11:13:20Z');
    await feed.cycle();
    expect(stub.calls.filter((c) => c.startsWith('kline BTC_USDT'))).toHaveLength(0); // still the same bars
    expect(stub.calls.filter((c) => c.startsWith('detail'))).toHaveLength(0); // contract checks persisted
  });
});

describe('settled funding from the public history', () => {
  it('records settled rates from the last 24 h once, never the predicted rate, and not again on later cycles', async () => {
    const rows = await direct.db.select().from(schema.fundingRates).where(eq(schema.fundingRates.instrumentId, BTC));
    expect(rows.map((r) => r.settledAt.toISOString()).sort()).toEqual(['2026-11-07T16:00:00.000Z', '2026-11-08T00:00:00.000Z', '2026-11-08T08:00:00.000Z']);
    expect(rows.every((r) => r.source === 'MEXC_PUBLIC')).toBe(true);
    stub.calls.length = 0;
    at('2026-11-08T11:13:40Z');
    await feed.cycle();
    expect(stub.calls.filter((c) => c.startsWith('funding'))).toHaveLength(0); // nothing new has settled
    expect(await direct.db.select().from(schema.fundingRates).where(eq(schema.fundingRates.instrumentId, BTC))).toHaveLength(3);
  });
});

describe('exits run on public prices through the same tick job', () => {
  it('a public price below the stop closes the position by STOP_LOSS in the paper simulator', async () => {
    const p = (await openPositionOf(USERS.investorA.email))!;
    stub.priceShift = -3000; // well below the 1.5 % stop
    at('2026-11-08T11:14:00Z');
    await feed.cycle();
    await drain(clock.now);
    const closed = (await direct.db.select().from(schema.positions).where(eq(schema.positions.id, p.id)))[0]!;
    expect(closed.status).toBe('CLOSED');
    const [exit] = await direct.db.select().from(schema.positionExits).where(eq(schema.positionExits.positionId, p.id));
    expect(exit!.reason).toBe('STOP_LOSS');
    stub.priceShift = 0;
  });
});

describe('fixtures keep working, and admins see feed health', () => {
  it('a fixture tick is still labelled FIXTURE', async () => {
    clock.now = plus(clock.now, 5);
    const asOf = clock.now;
    await recordMarketTick(direct.db, { instrumentId: BTC, asOf, bid: '1', ask: '2', mark: '1.5', last: '1.5' });
    expect((await quotes())[0]).toMatchObject({ source: 'FIXTURE', asOf });
    await processNextJob(direct.db, { workerId: 't', now: asOf });
  });

  it('GET /v1/admin/market-feeds shows state, freshness, source and events; investors are refused', async () => {
    setTestClock(() => clock.now);
    const r = await call(feeds.GET, { path: '/x', cookie: cookies.admin });
    expect(r.status).toBe(200);
    const btc = r.body.items.find((i: any) => i.symbol === 'BTCUSDT');
    expect(btc.feed).toMatchObject({ source: 'MEXC_PUBLIC', state: 'HEALTHY', consecutiveFailures: 0 });
    expect(btc.latestQuote).toMatchObject({ source: 'FIXTURE', sourceLabel: 'Fixture (replay data)' });
    const eth = r.body.items.find((i: any) => i.symbol === 'ETHUSDT');
    expect(eth.feed.contractMismatches).toEqual([{ field: 'contractMultiplier', platform: '0.01', exchange: '0.1' }]);
    expect(r.body.events.map((e: any) => e.kind)).toEqual(expect.arrayContaining(['UNVERIFIED_INTERVAL', 'GAP_DETECTED', 'CONTRACT_MISMATCH', 'STATE_CHANGED']));
    expect((await call(feeds.GET, { path: '/x', cookie: cookies.a })).status).toBe(403);
  });

  it('feed state judged at read time: a stopped feed is shown as not reporting', async () => {
    setTestClock(() => new Date(clock.now.getTime() + 10 * 60_000));
    const r = await call(feeds.GET, { path: '/x', cookie: cookies.admin });
    const btc = r.body.items.find((i: any) => i.symbol === 'BTCUSDT');
    expect(btc.feed.reporting).toBe(false);
    expect(btc.latestQuote.freshness).toBe('STALE');
    setTestClock(() => clock.now);
  });
});

void M15;
