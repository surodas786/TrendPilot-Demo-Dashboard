import { and, count, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import {
  backoffMs,
  candleRevised,
  clockOffsetMs,
  Decimal,
  FEED_POLICY,
  FUNDING_CYCLE_HOURS,
  INTERVAL_MS,
  isClosedBar,
  isRateLimitCode,
  missingBarRanges,
  newestClosedBarOpen,
  quoteProblem,
  toLocalTime,
  type CandleInterval,
  type FeedState,
  type QuoteChannel
} from '@trendpilot/domain';
import type { Db } from '../client';
import { recordMarketTick } from '../paper/exits';
import { recordFundingRate } from '../paper/funding';
import { fundingRates, instruments, marketCandles, marketFeedEvents, marketFeedStatus } from '../schema';
import { isMexcFuturesSymbol, MexcPublicError, type MexcKline, type MexcTicker, type PublicMarketSource } from './mexcPublic';
import type { StreamTicker, TickerStreamView } from './mexcWs';

/**
 * MKT-01/02 public price feed for Paper mode. Each cycle, for every approved (published) contract
 * and every contract with an open position:
 *  - checks the symbol mapping against the public contract detail;
 *  - reads the public ticker, converts its exchange timestamp to the local clock, and writes it to
 *    `market_quotes` with `source = 'MEXC_PUBLIC'` plus the same `market.tick` job a fixture tick
 *    queues (so stops, TP targets and trailing run on it);
 *  - keeps closed 5m/15m candles in `market_candles`: never the forming bar, gaps backfilled,
 *    late revisions of a closed bar recorded.
 * Failures back off per contract. State is persisted in `market_feed_status`, notable transitions
 * in `market_feed_events`. Order execution is untouched: fills stay in the paper simulator.
 *
 * Ticker transport. With a `stream` (the public WebSocket, the default in production) quotes arrive
 * through `ingestStreamTicker` and the cycle makes NO REST ticker call: it judges each contract's
 * quote freshness from what the stream delivered, separately from socket connectivity, and keeps
 * REST for contract detail, closed-candle backfill and settled funding. REST errors then only back
 * off the REST work; they never mark a contract DOWN while fresh WebSocket quotes arrive. A REST
 * ticker read happens only as an explicitly enabled, rate-limited fallback (`restFallback`), and
 * such quotes are labelled REST_FALLBACK. Without a stream the legacy REST polling path is used.
 * A MEXC 510 / HTTP 429 (IP rate limit) pauses every REST call of this process for a cooldown.
 */

export const FEED_SOURCE = 'MEXC_PUBLIC';

export interface FeedOptions {
  source: PublicMarketSource;
  /** Local wall clock. */
  now?: () => Date;
  log?: (m: string) => void;
  intervals?: CandleInterval[];
  backfillBars?: number;
  rand?: () => number;
  /** Re-measure the clock offset at most this often. */
  clockCheckMs?: number;
  /** Re-check a contract's public detail this often (and after it was unavailable). */
  detailCheckMs?: number;
  /** WebSocket ticker stream (primary quote source). Absent: legacy REST ticker polling. */
  stream?: TickerStreamView;
  /** Stream mode only: REST ticker reads while the stream has no fresh quote. Off unless enabled. */
  restFallback?: { enabled: boolean; minIntervalMs?: number };
}

export interface InstrumentCycleResult {
  symbol: string;
  exchangeSymbol: string;
  state: FeedState;
  quoteWritten: boolean;
  candlesWritten: number;
  gapsBackfilled: number;
  fundingRecorded?: number;
  /** REST work skipped: per-contract backoff, or the process-wide rate-limit cooldown. */
  skipped?: 'BACKOFF' | 'RATE_LIMIT';
  /** Channel of the quote written this cycle (REST_POLL or REST_FALLBACK); WS quotes arrive via ingest. */
  quoteChannel?: QuoteChannel;
  error?: string;
}

export type IngestOutcome = 'WRITTEN' | 'REPEAT' | 'STALE' | 'CLOCK_SKEW' | 'IGNORED';

export interface CycleSummary {
  at: string;
  clockOffsetMs: number | null;
  instruments: InstrumentCycleResult[];
}

type StatusRow = typeof marketFeedStatus.$inferSelect;
type EventKind =
  | 'STATE_CHANGED'
  | 'RECOVERED'
  | 'UNVERIFIED_INTERVAL'
  | 'GAP_DETECTED'
  | 'GAP_BACKFILLED'
  | 'GAP_UNRESOLVED'
  | 'HISTORY_REVISED'
  | 'CONTRACT_MISMATCH';

interface Covered {
  id: string;
  symbol: string;
  exchangeSymbol: string;
  contractMultiplier: string;
  priceTick: string;
  qtyStep: string;
  minQty: string;
  openPositions: number;
}

const MAX_KLINES_PER_REQUEST = 1000;

export class MarketFeed {
  private readonly now: () => Date;
  private readonly log: (m: string) => void;
  private readonly intervals: CandleInterval[];
  private readonly backfillBars: number;
  private readonly rand: () => number;
  private readonly clockCheckMs: number;
  private readonly detailCheckMs: number;
  private offsetMs: number | null = null;
  private offsetCheckedAt = 0;
  /** Gap ranges already reported as unresolved in this process (avoids an event every cycle). */
  private readonly reportedGaps = new Set<string>();
  /** No REST call before this time (local ms) after a rate-limit answer. */
  private restCooldownUntil = 0;
  private lastCovered: Covered[] = [];
  private readonly lastFallbackAt = new Map<string, number>();
  /** Per-contract serialisation of quote-state writes (stream ingest vs. cycle evaluation). */
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(
    private readonly db: Db,
    private readonly o: FeedOptions
  ) {
    this.now = o.now ?? (() => new Date());
    this.log = o.log ?? (() => {});
    this.intervals = o.intervals ?? ['5', '15'];
    this.backfillBars = o.backfillBars ?? FEED_POLICY.backfillBars;
    this.rand = o.rand ?? Math.random;
    this.clockCheckMs = o.clockCheckMs ?? 60_000;
    this.detailCheckMs = o.detailCheckMs ?? 6 * 3_600_000;
  }

  get clockOffset(): number | null {
    return this.offsetMs;
  }

  /** Clock sample from another channel (WebSocket pong). Keeps REST pings unnecessary. */
  setClockOffset(offsetMs: number): void {
    this.offsetMs = offsetMs;
    this.offsetCheckedAt = this.now().getTime();
  }

  /** Exchange symbols the stream should carry (from the last cycle's coverage). */
  get coveredExchangeSymbols(): string[] {
    return this.lastCovered.map((c) => c.exchangeSymbol).filter(isMexcFuturesSymbol);
  }

  /** Local ms until which REST is paused after a rate-limit answer (0 = not paused). */
  get restPausedUntil(): number {
    return this.restCooldownUntil > this.now().getTime() ? this.restCooldownUntil : 0;
  }

  private restCooling(): boolean {
    return this.restCooldownUntil > this.now().getTime();
  }

  private noteRateLimit(e: unknown): void {
    if (!(e instanceof MexcPublicError) || !isRateLimitCode(e.kind, e.code)) return;
    const until = this.now().getTime() + Math.round(FEED_POLICY.restRateLimitCooldownMs * (0.8 + 0.4 * this.rand()));
    if (until > this.restCooldownUntil) {
      this.restCooldownUntil = until;
      this.log(`REST rate limited by MEXC (${e.message}); pausing all REST calls until ${new Date(until).toISOString()}`);
    }
  }

  private async withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(key) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    const tail = run.catch(() => undefined);
    this.locks.set(key, tail);
    try {
      return await run;
    } finally {
      if (this.locks.get(key) === tail) this.locks.delete(key);
    }
  }

  /** Contracts the feed must cover: published ones plus any with an open position (MKT-01). */
  async covered(): Promise<Covered[]> {
    const rows = await this.db
      .select({
        id: instruments.id,
        symbol: instruments.symbol,
        exchangeSymbol: instruments.exchangeSymbol,
        status: instruments.status,
        contractMultiplier: instruments.contractMultiplier,
        priceTick: instruments.priceTick,
        qtyStep: instruments.qtyStep,
        minQty: instruments.minQty,
        // Table-qualified on purpose: inside a subquery an unqualified "id" would bind to positions.
        openPositions: sql<number>`(select count(*) from positions p where p.instrument_id = "instruments"."id" and p.status = 'OPEN')`.mapWith(Number)
      })
      .from(instruments)
      .orderBy(instruments.symbol);
    return rows.filter((r) => r.status === 'PUBLISHED' || r.openPositions > 0);
  }

  /** Reloads the covered contracts (what the stream subscribes to) without any exchange call. */
  async refreshCoverage(): Promise<string[]> {
    this.lastCovered = await this.covered();
    return this.coveredExchangeSymbols;
  }

  async cycle(): Promise<CycleSummary> {
    const started = this.now();
    await this.measureClock();
    const results: InstrumentCycleResult[] = [];
    this.lastCovered = await this.covered();
    for (const inst of this.lastCovered) results.push(this.o.stream ? await this.runStreamInstrument(inst) : await this.runInstrument(inst));
    return { at: started.toISOString(), clockOffsetMs: this.offsetMs, instruments: results };
  }

  private async measureClock(): Promise<void> {
    const t = this.now().getTime();
    if (this.offsetMs !== null && t - this.offsetCheckedAt < this.clockCheckMs) return;
    if (this.restCooling()) return;
    try {
      const sent = this.now().getTime();
      const server = await this.o.source.serverTimeMs();
      const received = this.now().getTime();
      this.offsetMs = clockOffsetMs(sent, server, received);
      this.offsetCheckedAt = received;
    } catch (e) {
      // Keep the last measurement; with none, ticker and candle reads below fail and back off.
      this.noteRateLimit(e);
      this.log(`clock check failed: ${(e as Error).message}`);
    }
  }

  private exchangeNow(): number {
    return this.now().getTime() + (this.offsetMs ?? 0);
  }

  private async status(instrumentId: string): Promise<StatusRow | null> {
    const [row] = await this.db
      .select()
      .from(marketFeedStatus)
      .where(and(eq(marketFeedStatus.instrumentId, instrumentId), eq(marketFeedStatus.source, FEED_SOURCE)));
    return row ?? null;
  }

  private async event(instrumentId: string, kind: EventKind, message: string, detail: Record<string, unknown> = {}, window?: { from: Date; to: Date }): Promise<void> {
    await this.db.insert(marketFeedEvents).values({ instrumentId, source: FEED_SOURCE, kind, message, detail, windowFrom: window?.from ?? null, windowTo: window?.to ?? null });
    this.log(`${kind}: ${message}`);
  }

  private async save(instrumentId: string, exchangeSymbol: string, patch: Partial<typeof marketFeedStatus.$inferInsert>): Promise<void> {
    const values = { instrumentId, source: FEED_SOURCE, exchangeSymbol, ...patch, updatedAt: this.now() };
    await this.db
      .insert(marketFeedStatus)
      .values(values)
      .onConflictDoUpdate({ target: [marketFeedStatus.instrumentId, marketFeedStatus.source], set: { ...patch, exchangeSymbol, updatedAt: this.now() } });
  }

  /** Moves to `next`, recording the transition once. */
  private async transition(inst: Covered, prev: StatusRow | null, next: FeedState, reason: string, patch: Partial<typeof marketFeedStatus.$inferInsert> = {}): Promise<void> {
    const changed = (prev?.state ?? 'STARTING') !== next;
    if (changed) await this.event(inst.id, 'STATE_CHANGED', `${inst.symbol} ${prev?.state ?? 'STARTING'} → ${next}: ${reason}`, { from: prev?.state ?? 'STARTING', to: next, reason });
    await this.save(inst.id, inst.exchangeSymbol, { ...patch, state: next, ...(changed ? { stateSince: this.now() } : {}) });
  }

  async runInstrument(inst: Covered): Promise<InstrumentCycleResult> {
    const base: InstrumentCycleResult = { symbol: inst.symbol, exchangeSymbol: inst.exchangeSymbol, state: 'STARTING', quoteWritten: false, candlesWritten: 0, gapsBackfilled: 0 };
    const prev = await this.status(inst.id);
    const now = this.now();

    if (!isMexcFuturesSymbol(inst.exchangeSymbol)) {
      await this.transition(inst, prev, 'SYMBOL_UNAVAILABLE', `no MEXC Futures symbol mapped (got "${inst.exchangeSymbol}")`, { lastError: 'Symbol mapping missing' });
      return { ...base, state: 'SYMBOL_UNAVAILABLE', error: 'Symbol mapping missing' };
    }
    if (prev?.nextRetryAt && prev.nextRetryAt > now) return { ...base, state: prev.state as FeedState, skipped: 'BACKOFF' };
    if (this.restCooling()) return { ...base, state: (prev?.state ?? 'STARTING') as FeedState, skipped: 'RATE_LIMIT' };

    try {
      // 1. Symbol mapping and contract spec (public detail).
      const due = !prev?.contractCheckedAt || now.getTime() - prev.contractCheckedAt.getTime() >= (prev.state === 'SYMBOL_UNAVAILABLE' ? 600_000 : this.detailCheckMs);
      if (due) {
        const ok = await this.checkContract(inst, prev);
        if (!ok) return { ...base, state: 'SYMBOL_UNAVAILABLE', error: 'Symbol not available on MEXC Futures' };
      } else if (prev?.state === 'SYMBOL_UNAVAILABLE') {
        return { ...base, state: 'SYMBOL_UNAVAILABLE' };
      }
      if (this.offsetMs === null) throw new MexcPublicError('exchange clock unknown (ping failed)', 'NETWORK');

      // 2. Quote (legacy REST polling).
      const quote = await this.syncQuote(inst, prev);
      // 3. Closed candles.
      let candlesWritten = 0;
      let gapsBackfilled = 0;
      for (const interval of this.intervals) {
        const r = await this.syncCandles(inst, interval);
        candlesWritten += r.written;
        gapsBackfilled += r.backfilled;
      }
      // 4. Settled funding (REP-02), once per settlement.
      const fundingRecorded = await this.syncFunding(inst);
      return { ...base, state: quote.state, quoteWritten: quote.written, quoteChannel: quote.written ? 'REST_POLL' : undefined, candlesWritten, gapsBackfilled, fundingRecorded };
    } catch (e) {
      return { ...base, ...(await this.fail(inst, prev, e)) };
    }
  }

  /**
   * Stream mode. REST work (detail, candles, funding) runs under its own backoff and the shared
   * rate-limit cooldown; its errors are recorded but never change the quote state. The quote state
   * comes from the stream's per-contract freshness (plus the optional REST fallback).
   */
  private async runStreamInstrument(inst: Covered): Promise<InstrumentCycleResult> {
    const base: InstrumentCycleResult = { symbol: inst.symbol, exchangeSymbol: inst.exchangeSymbol, state: 'STARTING', quoteWritten: false, candlesWritten: 0, gapsBackfilled: 0 };
    const prev = await this.status(inst.id);
    const now = this.now();

    if (!isMexcFuturesSymbol(inst.exchangeSymbol)) {
      await this.withLock(inst.id, () => this.transition(inst, prev, 'SYMBOL_UNAVAILABLE', `no MEXC Futures symbol mapped (got "${inst.exchangeSymbol}")`, { lastError: 'Symbol mapping missing' }));
      return { ...base, state: 'SYMBOL_UNAVAILABLE', error: 'Symbol mapping missing' };
    }

    const out: InstrumentCycleResult = { ...base };
    if (prev?.nextRetryAt && prev.nextRetryAt > now) out.skipped = 'BACKOFF';
    else if (this.restCooling()) out.skipped = 'RATE_LIMIT';
    else {
      try {
        const due = !prev?.contractCheckedAt || now.getTime() - prev.contractCheckedAt.getTime() >= (prev.state === 'SYMBOL_UNAVAILABLE' ? 600_000 : this.detailCheckMs);
        if (due) {
          const ok = await this.withLock(inst.id, () => this.checkContract(inst, prev));
          if (!ok) return { ...base, state: 'SYMBOL_UNAVAILABLE', error: 'Symbol not available on MEXC Futures' };
        }
        if (prev?.state !== 'SYMBOL_UNAVAILABLE' || due) {
          if (this.offsetMs !== null) {
            for (const interval of this.intervals) {
              const r = await this.syncCandles(inst, interval);
              out.candlesWritten += r.written;
              out.gapsBackfilled += r.backfilled;
            }
            out.fundingRecorded = await this.syncFunding(inst);
          }
          if (prev?.consecutiveFailures || prev?.lastError?.startsWith('REST')) await this.save(inst.id, inst.exchangeSymbol, { consecutiveFailures: 0, nextRetryAt: null, lastError: null });
        }
      } catch (e) {
        const unavailable = await this.restFailed(inst, e);
        if (unavailable) return { ...base, state: 'SYMBOL_UNAVAILABLE', error: unavailable };
        out.error = `REST: ${(e instanceof Error ? e.message : String(e)).slice(0, 300)}`;
      }
    }

    const cur = await this.status(inst.id);
    if (cur?.state === 'SYMBOL_UNAVAILABLE') return { ...out, state: 'SYMBOL_UNAVAILABLE' };
    const q = await this.withLock(inst.id, () => this.evaluateStreamQuote(inst));
    return { ...out, state: q.state, quoteWritten: q.written, quoteChannel: q.written ? 'REST_FALLBACK' : undefined, error: out.error ?? q.error };
  }

  /** Records a REST failure in stream mode: backoff + lastError only. Returns a message if the symbol is unavailable. */
  private async restFailed(inst: Covered, e: unknown): Promise<string | null> {
    const message = (e instanceof Error ? e.message : String(e)).slice(0, 500);
    this.noteRateLimit(e);
    if (e instanceof MexcPublicError && e.kind === 'API' && e.code === 1001) {
      await this.withLock(inst.id, async () => this.transition(inst, await this.status(inst.id), 'SYMBOL_UNAVAILABLE', message, { lastError: message, contractCheckedAt: this.now() }));
      return message;
    }
    const prev = await this.status(inst.id);
    const failures = (prev?.consecutiveFailures ?? 0) + 1;
    const retryAt = new Date(this.now().getTime() + backoffMs(failures, this.rand()));
    await this.save(inst.id, inst.exchangeSymbol, { consecutiveFailures: failures, nextRetryAt: retryAt, lastError: `REST: ${message}` });
    this.log(`${inst.symbol}: REST ${message} (failure ${failures}, REST retry at ${retryAt.toISOString()}; quote state unaffected)`);
    return null;
  }

  /** Quote state from stream freshness; optionally one rate-limited REST fallback read. */
  private async evaluateStreamQuote(inst: Covered): Promise<{ state: FeedState; written: boolean; error?: string }> {
    const prev = await this.status(inst.id);
    const now = this.now();
    const quiet = { lastSuccessAt: prev?.lastSuccessAt ?? null, clockOffsetMs: this.offsetMs };
    if (this.offsetMs !== null && Math.abs(this.offsetMs) > FEED_POLICY.maxClockSkewMs) {
      await this.transition(inst, prev, 'CLOCK_SKEW', `exchange clock differs from local by ${this.offsetMs} ms (limit ${FEED_POLICY.maxClockSkewMs} ms)`, quiet);
      return { state: 'CLOCK_SKEW', written: false };
    }
    const lastQuoteAt = prev?.lastQuoteAt ?? null;
    const age = lastQuoteAt ? now.getTime() - lastQuoteAt.getTime() : Infinity;
    if (age <= FEED_POLICY.maxQuoteAgeMs) {
      await this.transition(inst, prev, 'HEALTHY', `receiving prices (${prev?.quoteChannel === 'REST_FALLBACK' ? 'REST fallback' : 'WebSocket'})`, quiet);
      return { state: 'HEALTHY', written: false };
    }

    // No fresh quote. Optional, explicitly enabled REST fallback, at most once per interval.
    let error: string | undefined;
    const fb = this.o.restFallback;
    if (fb?.enabled && this.offsetMs !== null && !this.restCooling()) {
      const last = this.lastFallbackAt.get(inst.id) ?? 0;
      if (now.getTime() - last >= (fb.minIntervalMs ?? FEED_POLICY.restFallbackMinIntervalMs)) {
        this.lastFallbackAt.set(inst.id, now.getTime());
        try {
          const t = await this.o.source.ticker(inst.exchangeSymbol);
          const r = await this.acceptQuote(inst, prev, t, 'REST_FALLBACK', { clockOffsetMs: this.offsetMs, lastSuccessAt: now });
          if (r === 'WRITTEN' || r === 'REPEAT') return { state: 'HEALTHY', written: r === 'WRITTEN' };
        } catch (e) {
          this.noteRateLimit(e);
          error = `REST fallback: ${(e as Error).message}`.slice(0, 500);
          this.log(`${inst.symbol}: ${error}`);
        }
      }
    }

    const stream = this.o.stream!;
    const since = stream.connectedSince();
    const ageText = lastQuoteAt ? `${Math.round(age / 1000)} s` : 'ever';
    let next: FeedState;
    let reason: string;
    if (!stream.connected()) {
      next = 'DOWN';
      reason = `WebSocket disconnected; reconnecting (no quote for ${ageText})`;
    } else if (!lastQuoteAt && since && now.getTime() - since.getTime() < FEED_POLICY.maxQuoteAgeMs) {
      next = 'STARTING';
      reason = 'subscribed; waiting for the first ticker';
    } else {
      next = 'STALE';
      reason = `WebSocket connected but no fresh ${inst.exchangeSymbol} ticker (none for ${ageText})`;
    }
    const cur = await this.status(inst.id);
    await this.transition(inst, cur, next, reason, { ...quiet, ...(error ? { lastError: error } : {}) });
    return { state: next, written: false, error };
  }

  /**
   * A `push.ticker` from the WebSocket. Writes the quote (source MEXC_PUBLIC, channel WS) and its
   * market.tick job unless it is a repeat, stale, skewed or for a contract we do not cover.
   */
  async ingestStreamTicker(t: StreamTicker): Promise<IngestOutcome> {
    const inst = this.lastCovered.find((c) => c.exchangeSymbol === t.exchangeSymbol);
    if (!inst || this.offsetMs === null) return 'IGNORED';
    return this.withLock(inst.id, async () => {
      const prev = await this.status(inst.id);
      if (prev?.state === 'SYMBOL_UNAVAILABLE') return 'IGNORED';
      try {
        return await this.acceptQuote(inst, prev, t, 'WS', { lastSuccessAt: t.receivedAt, clockOffsetMs: this.offsetMs, lastStreamAt: t.receivedAt }, t.receivedAt);
      } catch (e) {
        this.log(`${inst.symbol}: WebSocket ticker rejected: ${(e as Error).message}`);
        return 'IGNORED';
      }
    });
  }

  private async fail(inst: Covered, prev: StatusRow | null, e: unknown): Promise<{ state: FeedState; error: string }> {
    const message = (e instanceof Error ? e.message : String(e)).slice(0, 500);
    this.noteRateLimit(e);
    if (e instanceof MexcPublicError && e.kind === 'API' && e.code === 1001) {
      await this.transition(inst, prev, 'SYMBOL_UNAVAILABLE', message, { lastError: message, contractCheckedAt: this.now() });
      return { state: 'SYMBOL_UNAVAILABLE', error: message };
    }
    const failures = (prev?.consecutiveFailures ?? 0) + 1;
    const retryAt = new Date(this.now().getTime() + backoffMs(failures, this.rand()));
    await this.transition(inst, prev, 'DOWN', message, { consecutiveFailures: failures, nextRetryAt: retryAt, lastError: message });
    this.log(`${inst.symbol}: ${message} (failure ${failures}, retry at ${retryAt.toISOString()})`);
    return { state: 'DOWN', error: message };
  }

  private async checkContract(inst: Covered, prev: StatusRow | null): Promise<boolean> {
    let detail;
    try {
      detail = await this.o.source.contractDetail(inst.exchangeSymbol);
    } catch (e) {
      if (e instanceof MexcPublicError && e.kind === 'API') {
        await this.transition(inst, prev, 'SYMBOL_UNAVAILABLE', e.message, { lastError: e.message, contractCheckedAt: this.now(), nextRetryAt: null, consecutiveFailures: 0 });
        return false;
      }
      throw e;
    }
    const pairs: [string, string, string][] = [
      ['contractMultiplier', inst.contractMultiplier, detail.contractSize],
      ['priceTick', inst.priceTick, detail.priceUnit],
      ['qtyStep', inst.qtyStep, detail.volUnit],
      ['minQty', inst.minQty, detail.minVol]
    ];
    const mismatches = pairs.filter(([, ours, theirs]) => !new Decimal(ours).eq(theirs)).map(([field, ours, theirs]) => ({ field, platform: new Decimal(ours).toFixed(), exchange: theirs }));
    if (detail.state !== 0) mismatches.push({ field: 'state', platform: 'enabled', exchange: `state ${detail.state}` });
    const check = { checkedAt: this.now().toISOString(), mismatches, exchange: detail };
    const before = JSON.stringify((prev?.contractCheck as { mismatches?: unknown } | null)?.mismatches ?? []);
    if (mismatches.length && before !== JSON.stringify(mismatches)) {
      await this.event(inst.id, 'CONTRACT_MISMATCH', `${inst.symbol}: platform contract spec differs from MEXC public detail (${mismatches.map((m) => m.field).join(', ')})`, { mismatches });
    }
    const wasUnavailable = prev?.state === 'SYMBOL_UNAVAILABLE';
    await this.save(inst.id, inst.exchangeSymbol, { contractCheck: check, contractCheckedAt: this.now() });
    if (wasUnavailable) await this.transition(inst, { ...prev!, contractCheck: check }, 'STARTING', 'symbol available again');
    return true;
  }

  private async syncQuote(inst: Covered, prevRow: StatusRow | null): Promise<{ state: FeedState; written: boolean }> {
    const prev = (await this.status(inst.id)) ?? prevRow;
    const t = await this.o.source.ticker(inst.exchangeSymbol);
    const ok = { consecutiveFailures: 0, nextRetryAt: null, lastError: null, lastSuccessAt: this.now(), clockOffsetMs: this.offsetMs };
    const r = await this.acceptQuote(inst, prev, t, 'REST_POLL', ok);
    return { state: r === 'CLOCK_SKEW' ? 'CLOCK_SKEW' : r === 'STALE' ? 'STALE' : 'HEALTHY', written: r === 'WRITTEN' };
  }

  /** Validates one ticker and records it. Shared by REST polling, REST fallback and the WebSocket. */
  private async acceptQuote(
    inst: Covered,
    prev: StatusRow | null,
    t: MexcTicker,
    channel: QuoteChannel,
    ok: Partial<typeof marketFeedStatus.$inferInsert>,
    receivedAt?: Date
  ): Promise<Exclude<IngestOutcome, 'IGNORED'>> {
    const now = this.now();
    if (Math.abs(this.offsetMs!) > FEED_POLICY.maxClockSkewMs) {
      await this.transition(inst, prev, 'CLOCK_SKEW', `exchange clock differs from local by ${this.offsetMs} ms (limit ${FEED_POLICY.maxClockSkewMs} ms)`, ok);
      return 'CLOCK_SKEW';
    }
    const problem = quoteProblem(t);
    if (problem) throw new MexcPublicError(`ticker ${inst.exchangeSymbol}: ${problem}`, 'PARSE');

    const asOf = toLocalTime(t.exchangeTimeMs, this.offsetMs!);
    const ageMs = now.getTime() - asOf.getTime();
    const repeated = prev?.lastExchangeTime && prev.lastExchangeTime.getTime() === t.exchangeTimeMs;
    if (ageMs > FEED_POLICY.maxQuoteAgeMs) {
      await this.transition(inst, prev, 'STALE', `newest exchange price is ${Math.round(ageMs / 1000)} s old`, ok);
      return 'STALE';
    }
    if (repeated) {
      // Nothing new from the exchange; the previous quote is still fresh.
      await this.transition(inst, prev, 'HEALTHY', 'receiving prices', ok);
      return 'REPEAT';
    }

    await recordMarketTick(this.db, { instrumentId: inst.id, asOf, bid: t.bid, ask: t.ask, mark: t.mark, last: t.last, liquidityContracts: null, source: FEED_SOURCE, channel, receivedAt: receivedAt ?? now });

    // Recovery after an outage or a stale stretch: record the interval where price crossings could
    // not be observed. Exits continue from the current price; nothing is filled retroactively.
    const lastQuoteAt = prev?.lastQuoteAt ?? null;
    if (prev && prev.state !== 'HEALTHY' && prev.state !== 'STARTING') {
      const via = channel === 'WS' ? 'WebSocket' : channel === 'REST_FALLBACK' ? 'REST fallback' : 'REST';
      await this.event(inst.id, 'RECOVERED', `${inst.symbol} recovered from ${prev.state} (${via})`, { from: prev.state, channel });
    }
    if (lastQuoteAt && asOf.getTime() - lastQuoteAt.getTime() > FEED_POLICY.maxQuoteAgeMs) {
      await this.event(
        inst.id,
        'UNVERIFIED_INTERVAL',
        `${inst.symbol}: no public price between ${lastQuoteAt.toISOString()} and ${asOf.toISOString()}; stop, target and trailing crossings in that window could not be verified (${inst.openPositions} open position(s))`,
        { openPositions: inst.openPositions, seconds: Math.round((asOf.getTime() - lastQuoteAt.getTime()) / 1000) },
        { from: lastQuoteAt, to: asOf }
      );
    }
    await this.transition(inst, prev, 'HEALTHY', 'receiving prices', { ...ok, lastQuoteAt: asOf, lastExchangeTime: new Date(t.exchangeTimeMs), quoteChannel: channel });
    return 'WRITTEN';
  }

  /** After each funding settlement (with a 60 s settle delay), records the newly settled rates. */
  private async syncFunding(inst: Covered): Promise<number> {
    if (!this.o.source.fundingHistory) return 0;
    const cycle = FUNDING_CYCLE_HOURS * 3_600_000;
    const exNow = this.exchangeNow();
    const latestSettlement = Math.floor((exNow - 60_000) / cycle) * cycle;
    const [have] = await this.db
      .select({ t: sql<Date | string | null>`max(${fundingRates.settledAt})` })
      .from(fundingRates)
      .where(eq(fundingRates.instrumentId, inst.id));
    const newest = have?.t ? new Date(have.t).getTime() : null;
    if (newest !== null && newest >= latestSettlement) return 0;
    const rows = await this.o.source.fundingHistory(inst.exchangeSymbol, 10);
    // First run: only the last 24 h, never older history.
    const floor = newest ?? exNow - 24 * 3_600_000;
    let n = 0;
    for (const r of rows) {
      if (r.settledAt.getTime() <= floor || r.settledAt.getTime() > exNow) continue;
      if ((await recordFundingRate(this.db, { instrumentId: inst.id, settledAt: r.settledAt, rate: r.rate, source: FEED_SOURCE })).created) n += 1;
    }
    if (n) this.log(`${inst.symbol}: recorded ${n} settled funding rate(s)`);
    return n;
  }

  private async fetchRange(inst: Covered, interval: CandleInterval, from: Date, to: Date): Promise<MexcKline[]> {
    const ms = INTERVAL_MS[interval];
    const out: MexcKline[] = [];
    for (let start = from.getTime(); start <= to.getTime(); start += MAX_KLINES_PER_REQUEST * ms) {
      const end = Math.min(to.getTime(), start + (MAX_KLINES_PER_REQUEST - 1) * ms);
      out.push(...(await this.o.source.klines(inst.exchangeSymbol, interval, new Date(start), new Date(end))));
    }
    return out;
  }

  /** Upserts closed bars only. Returns rows written and revisions of already stored closed bars. */
  private async storeClosed(inst: Covered, interval: CandleInterval, bars: MexcKline[], from: Date, to: Date): Promise<number> {
    const exNow = this.exchangeNow();
    const closed = bars.filter((b) => b.openTime >= from && b.openTime <= to && isClosedBar(b.openTime, interval, exNow));
    if (!closed.length) return 0;
    const existing = await this.db
      .select()
      .from(marketCandles)
      .where(
        and(
          eq(marketCandles.instrumentId, inst.id),
          eq(marketCandles.interval, interval),
          eq(marketCandles.source, FEED_SOURCE),
          inArray(
            marketCandles.openTime,
            closed.map((c) => c.openTime)
          )
        )
      );
    const byOpen = new Map(existing.map((r) => [r.openTime.getTime(), r]));
    const revised = closed.filter((c) => {
      const old = byOpen.get(c.openTime.getTime());
      return old && candleRevised(old, c);
    });
    const fresh = closed.filter((c) => {
      const old = byOpen.get(c.openTime.getTime());
      return !old || candleRevised(old, c);
    });
    for (let i = 0; i < fresh.length; i += 500) {
      await this.db
        .insert(marketCandles)
        .values(fresh.slice(i, i + 500).map((c) => ({ instrumentId: inst.id, interval, openTime: c.openTime, open: c.open, high: c.high, low: c.low, close: c.close, closed: true, source: FEED_SOURCE })))
        .onConflictDoUpdate({
          target: [marketCandles.instrumentId, marketCandles.interval, marketCandles.openTime],
          set: { open: sql`excluded.open`, high: sql`excluded.high`, low: sql`excluded.low`, close: sql`excluded.close`, closed: sql`excluded.closed`, source: sql`excluded.source` }
        });
    }
    if (revised.length) {
      await this.event(inst.id, 'HISTORY_REVISED', `${inst.symbol} ${interval}m: exchange revised ${revised.length} closed bar(s); EMA is recalculated from the corrected history`, {
        interval,
        bars: revised.map((r) => ({ openTime: r.openTime.toISOString(), before: byOpen.get(r.openTime.getTime())!.close, after: r.close }))
      });
    }
    return fresh.length;
  }

  private async syncCandles(inst: Covered, interval: CandleInterval): Promise<{ written: number; backfilled: number }> {
    const ms = INTERVAL_MS[interval];
    const newest = newestClosedBarOpen(interval, this.exchangeNow());
    const windowStart = new Date(newest.getTime() - (this.backfillBars - 1) * ms);
    const status = await this.status(inst.id);
    const stored = (status?.lastCandleOpen as Record<string, string> | null)?.[interval];
    const storedAt = stored ? new Date(stored) : null;
    if (storedAt && storedAt.getTime() >= newest.getTime()) return { written: 0, backfilled: 0 };

    // Incremental read with a small overlap (late revisions), or a full backfill on first run.
    const from = storedAt && storedAt >= windowStart ? new Date(Math.max(windowStart.getTime(), storedAt.getTime() - FEED_POLICY.overlapBars * ms)) : windowStart;
    let written = await this.storeClosed(inst, interval, await this.fetchRange(inst, interval, from, newest), windowStart, newest);

    // Gap detection over the whole window, then a targeted backfill of each missing range.
    let backfilled = 0;
    const have = async () =>
      (
        await this.db
          .select({ t: marketCandles.openTime })
          .from(marketCandles)
          .where(and(eq(marketCandles.instrumentId, inst.id), eq(marketCandles.interval, interval), eq(marketCandles.source, FEED_SOURCE), gte(marketCandles.openTime, windowStart), lte(marketCandles.openTime, newest)))
      ).map((r) => r.t.getTime());
    const gaps = missingBarRanges(await have(), interval, windowStart, newest);
    // A first run's whole window is a backfill, not a gap.
    const isFirstFill = !storedAt;
    for (const g of gaps) {
      if (!isFirstFill) await this.event(inst.id, 'GAP_DETECTED', `${inst.symbol} ${interval}m: ${g.bars} missing closed bar(s)`, { interval, bars: g.bars }, { from: g.from, to: g.to });
      const n = await this.storeClosed(inst, interval, await this.fetchRange(inst, interval, g.from, g.to), g.from, g.to);
      written += n;
      backfilled += n;
    }
    const remaining = gaps.length ? missingBarRanges(await have(), interval, windowStart, newest) : [];
    for (const g of remaining) {
      const key = `${inst.id}:${interval}:${g.from.getTime()}:${g.to.getTime()}`;
      if (this.reportedGaps.has(key)) continue;
      this.reportedGaps.add(key);
      await this.event(
        inst.id,
        'GAP_UNRESOLVED',
        `${inst.symbol} ${interval}m: ${g.bars} closed bar(s) still missing after backfill; EMA 200 is unavailable for signal bars that need them`,
        { interval, bars: g.bars },
        { from: g.from, to: g.to }
      );
    }
    if (backfilled && !isFirstFill) await this.event(inst.id, 'GAP_BACKFILLED', `${inst.symbol} ${interval}m: backfilled ${backfilled} closed bar(s)`, { interval, bars: backfilled });

    const lastCandleOpen = { ...((status?.lastCandleOpen as Record<string, string> | null) ?? {}), [interval]: newest.toISOString() };
    await this.save(inst.id, inst.exchangeSymbol, { lastCandleOpen });
    return { written, backfilled };
  }
}

/** Counts for tests and the admin view. */
export async function feedEventCounts(db: Db, instrumentId: string): Promise<Record<string, number>> {
  const rows = await db
    .select({ kind: marketFeedEvents.kind, n: count() })
    .from(marketFeedEvents)
    .where(and(eq(marketFeedEvents.instrumentId, instrumentId), eq(marketFeedEvents.source, FEED_SOURCE)))
    .groupBy(marketFeedEvents.kind);
  return Object.fromEntries(rows.map((r) => [r.kind, Number(r.n)]));
}
