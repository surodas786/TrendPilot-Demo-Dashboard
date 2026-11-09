import { Decimal } from './decimal';
import type { Candle } from './market';

/**
 * MKT-01/02 public market-data rules, independent of any exchange client. Pure; no I/O.
 *
 * Sources: `FIXTURE` rows come from deterministic replays and tests; `MEXC_PUBLIC` rows come from
 * MEXC Futures public endpoints (no keys, no private endpoints). Order execution is unaffected:
 * Paper mode always fills in the paper simulator.
 */

export const MARKET_SOURCES = ['FIXTURE', 'MEXC_PUBLIC'] as const;
export type MarketSource = (typeof MARKET_SOURCES)[number];

export const MARKET_SOURCE_LABEL: Record<MarketSource, string> = {
  FIXTURE: 'Fixture (replay data)',
  MEXC_PUBLIC: 'MEXC public market data'
};

export const marketSourceLabel = (s: string | null | undefined): string => (s && s in MARKET_SOURCE_LABEL ? MARKET_SOURCE_LABEL[s as MarketSource] : 'Unknown source');

export const FEED_POLICY = {
  /** A quote older than this is stale (same limit the entry check uses). */
  maxQuoteAgeMs: 15_000,
  /** Largest exchange-vs-local clock offset accepted. Beyond it no quote is written. */
  maxClockSkewMs: 5_000,
  /** A candle counts as closed only this long after its close, so the exchange has finalised it. */
  closeGraceMs: 3_000,
  /** Closed candles kept per interval (EMA 200 needs 200 consecutive closes). */
  backfillBars: 300,
  /** Re-read this many recent closed bars each sync to pick up late revisions. */
  overlapBars: 2,
  /** Retry backoff after consecutive failures. */
  backoffBaseMs: 1_000,
  backoffMaxMs: 60_000
} as const;

export type FeedState = 'STARTING' | 'HEALTHY' | 'STALE' | 'DOWN' | 'CLOCK_SKEW' | 'SYMBOL_UNAVAILABLE';

export const FEED_STATE_TEXT: Record<FeedState, string> = {
  STARTING: 'Starting: no quote received yet.',
  HEALTHY: 'Receiving fresh public prices.',
  STALE: 'The exchange price has not updated recently. Entries on this pair are blocked.',
  DOWN: 'Public endpoint unreachable. Retrying with backoff. Entries on this pair are blocked.',
  CLOCK_SKEW: 'The local clock differs too much from the exchange clock. Quotes are not recorded.',
  SYMBOL_UNAVAILABLE: 'The mapped exchange symbol is not available on MEXC Futures.'
};

export const INTERVAL_MS = { '5': 300_000, '15': 900_000 } as const;
export type CandleInterval = keyof typeof INTERVAL_MS;

/** Exponential backoff with ±20% jitter (rand in [0,1)). failures ≥ 1. */
export function backoffMs(failures: number, rand = Math.random()): number {
  const base = Math.min(FEED_POLICY.backoffMaxMs, FEED_POLICY.backoffBaseMs * 2 ** Math.max(0, failures - 1));
  return Math.round(base * (0.8 + 0.4 * rand));
}

/**
 * Exchange clock offset from a round trip: serverTime − midpoint of local send/receive.
 * Positive means the exchange clock is ahead.
 */
export function clockOffsetMs(localSentMs: number, serverTimeMs: number, localReceivedMs: number): number {
  return Math.round(serverTimeMs - (localSentMs + localReceivedMs) / 2);
}

/** Converts an exchange timestamp into the local clock domain. */
export const toLocalTime = (exchangeMs: number, offsetMs: number) => new Date(exchangeMs - offsetMs);

/**
 * Closed-candle rule: a bar is closed once its close time plus the grace period has passed on
 * the exchange clock. The forming bar is never returned, whatever the exchange labels it.
 */
export function isClosedBar(openTime: Date, interval: CandleInterval, exchangeNowMs: number, graceMs: number = FEED_POLICY.closeGraceMs): boolean {
  return openTime.getTime() + INTERVAL_MS[interval] + graceMs <= exchangeNowMs;
}

/** Open time of the newest bar that `isClosedBar` accepts at exchangeNowMs. */
export function newestClosedBarOpen(interval: CandleInterval, exchangeNowMs: number, graceMs: number = FEED_POLICY.closeGraceMs): Date {
  const ms = INTERVAL_MS[interval];
  return new Date(Math.floor((exchangeNowMs - graceMs) / ms) * ms - ms);
}

export interface BarRange {
  /** First missing bar open (inclusive). */
  from: Date;
  /** Last missing bar open (inclusive). */
  to: Date;
  bars: number;
}

/**
 * Gap detection: every bar open in [from, to] (aligned to the interval) that is not in `have`,
 * merged into contiguous ranges, oldest first.
 */
export function missingBarRanges(have: Iterable<number>, interval: CandleInterval, from: Date, to: Date): BarRange[] {
  const ms = INTERVAL_MS[interval];
  const set = new Set(have);
  const start = Math.ceil(from.getTime() / ms) * ms;
  const end = Math.floor(to.getTime() / ms) * ms;
  const out: BarRange[] = [];
  let cur: { from: number; to: number } | null = null;
  for (let t = start; t <= end; t += ms) {
    if (set.has(t)) {
      if (cur) out.push(toRange(cur, ms));
      cur = null;
    } else if (cur) cur.to = t;
    else cur = { from: t, to: t };
  }
  if (cur) out.push(toRange(cur, ms));
  return out;
}

const toRange = (r: { from: number; to: number }, ms: number): BarRange => ({ from: new Date(r.from), to: new Date(r.to), bars: (r.to - r.from) / ms + 1 });

/** True when two candles differ in any price (a late exchange revision of a closed bar). */
export function candleRevised(a: Pick<Candle, 'open' | 'high' | 'low' | 'close'>, b: Pick<Candle, 'open' | 'high' | 'low' | 'close'>): boolean {
  return (['open', 'high', 'low', 'close'] as const).some((k) => !new Decimal(a[k]).eq(b[k]));
}

/** Book sanity: positive prices and a non-crossed book. */
export function quoteProblem(q: { bid: string; ask: string; mark: string; last: string }): string | null {
  for (const k of ['bid', 'ask', 'mark', 'last'] as const) {
    let d: Decimal;
    try {
      d = new Decimal(q[k]);
    } catch {
      return `${k} is not a number`;
    }
    if (!d.isFinite() || d.lte(0)) return `${k} must be positive`;
  }
  if (new Decimal(q.ask).lt(q.bid)) return 'crossed book (ask below bid)';
  return null;
}

/**
 * Freshness at read time. The stored feed state can lag (a stopped feed process keeps its last
 * state), so readers also judge the newest quote's age directly.
 */
export function quoteAgeState(lastQuoteAt: Date | null, now: Date, maxAgeMs: number = FEED_POLICY.maxQuoteAgeMs): 'FRESH' | 'STALE' | 'NONE' {
  if (!lastQuoteAt) return 'NONE';
  return now.getTime() - lastQuoteAt.getTime() > maxAgeMs ? 'STALE' : 'FRESH';
}
