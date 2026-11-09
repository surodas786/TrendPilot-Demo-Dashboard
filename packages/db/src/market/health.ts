import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { Decimal, FEED_POLICY, FEED_STATE_TEXT, quoteAgeState, quoteSourceLabel, type FeedState } from '@trendpilot/domain';
import type { Executor } from '../client';
import { instruments, marketFeedEvents, marketFeedStatus, marketQuotes, serviceHeartbeats } from '../schema';
import type { TickerStreamStatus } from './mexcWs';

/** Admin read model for MKT-02 feed health. Contract-level only; no investor data. */

export interface ContractMismatch {
  field: string;
  platform: string;
  exchange: string;
}

export interface FeedHealthDto {
  instrumentId: string;
  symbol: string;
  exchangeSymbol: string;
  instrumentStatus: string;
  /** Source of the newest stored quote for this contract (whatever wrote it). */
  latestQuote: { source: string; channel: string | null; sourceLabel: string; asOf: string; ageSeconds: number; bid: string; ask: string; mark: string; last: string; freshness: 'FRESH' | 'STALE' } | null;
  feed: {
    source: 'MEXC_PUBLIC';
    state: FeedState;
    stateText: string;
    /** The stored state can lag when the feed process is stopped; this flags that case. */
    reporting: boolean;
    stateSince: string | null;
    lastQuoteAt: string | null;
    lastSuccessAt: string | null;
    consecutiveFailures: number;
    nextRetryAt: string | null;
    lastError: string | null;
    clockOffsetMs: number | null;
    /** Channel of the newest written quote (WS, REST_FALLBACK, REST_POLL). */
    quoteChannel: string | null;
    /** Newest WebSocket ticker receipt for this contract (repeats included). */
    lastStreamAt: string | null;
    lastCandleOpen: Record<string, string>;
    contractMismatches: ContractMismatch[];
    contractCheckedAt: string | null;
    updatedAt: string;
  } | null;
}

export interface FeedEventDto {
  id: string;
  symbol: string;
  kind: string;
  message: string;
  windowFrom: string | null;
  windowTo: string | null;
  createdAt: string;
}

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

export async function listFeedHealth(db: Executor, now = new Date()): Promise<FeedHealthDto[]> {
  const rows = await db
    .select({ i: instruments, f: marketFeedStatus })
    .from(instruments)
    .leftJoin(marketFeedStatus, eq(marketFeedStatus.instrumentId, instruments.id))
    .orderBy(instruments.symbol);
  const byInst = await latestQuoteRows(db, now);
  return rows.map(({ i, f }) => {
    const q = byInst.get(i.id);
    const asOf = q ? new Date(q.as_of) : null;
    const reporting = f ? now.getTime() - f.updatedAt.getTime() <= Math.max(FEED_POLICY.maxQuoteAgeMs, 30_000) : false;
    return {
      instrumentId: i.id,
      symbol: i.symbol,
      exchangeSymbol: i.exchangeSymbol,
      instrumentStatus: i.status,
      latestQuote:
        q && asOf
          ? {
              source: q.source,
              channel: q.channel,
              sourceLabel: quoteSourceLabel(q.source, q.channel),
              asOf: asOf.toISOString(),
              ageSeconds: Math.max(0, Math.round((now.getTime() - asOf.getTime()) / 1000)),
              bid: q.bid,
              ask: q.ask,
              mark: q.mark,
              last: q.last,
              freshness: quoteAgeState(asOf, now) === 'FRESH' ? 'FRESH' : 'STALE'
            }
          : null,
      feed: f
        ? {
            source: 'MEXC_PUBLIC',
            state: f.state as FeedState,
            stateText: FEED_STATE_TEXT[f.state as FeedState] ?? f.state,
            reporting,
            stateSince: iso(f.stateSince),
            lastQuoteAt: iso(f.lastQuoteAt),
            lastSuccessAt: iso(f.lastSuccessAt),
            consecutiveFailures: f.consecutiveFailures,
            nextRetryAt: iso(f.nextRetryAt),
            lastError: f.lastError,
            clockOffsetMs: f.clockOffsetMs,
            quoteChannel: f.quoteChannel,
            lastStreamAt: iso(f.lastStreamAt),
            lastCandleOpen: (f.lastCandleOpen as Record<string, string> | null) ?? {},
            contractMismatches: (f.contractCheck as { mismatches?: ContractMismatch[] } | null)?.mismatches ?? [],
            contractCheckedAt: iso(f.contractCheckedAt),
            updatedAt: f.updatedAt.toISOString()
          }
        : null
    };
  });
}

export async function listFeedEvents(db: Executor, limit = 50): Promise<FeedEventDto[]> {
  const rows = await db
    .select({ e: marketFeedEvents, symbol: instruments.symbol })
    .from(marketFeedEvents)
    .innerJoin(instruments, eq(instruments.id, marketFeedEvents.instrumentId))
    .orderBy(desc(marketFeedEvents.createdAt), desc(marketFeedEvents.id))
    .limit(Math.min(Math.max(limit, 1), 200));
  return rows.map(({ e, symbol }) => ({ id: e.id, symbol, kind: e.kind, message: e.message, windowFrom: iso(e.windowFrom), windowTo: iso(e.windowTo), createdAt: e.createdAt.toISOString() }));
}

type QuoteRow = { instrument_id: string; as_of: Date | string; bid: string; ask: string; mark: string; last: string; source: string; channel: string | null };

/** Newest quote per instrument stamped at or before now (+2 s skew), like `latestQuote`. */
async function latestQuoteRows(db: Executor, now: Date): Promise<Map<string, QuoteRow>> {
  const latest = await db.execute<QuoteRow>(sql`
    SELECT DISTINCT ON (instrument_id) instrument_id, as_of, bid, ask, mark, last, source, channel
    FROM ${marketQuotes}
    WHERE as_of <= ${new Date(now.getTime() + 2_000).toISOString()}::timestamptz
    ORDER BY instrument_id, as_of DESC`);
  return new Map(latest.rows.map((r) => [r.instrument_id, r]));
}

/** "74651.000000000000" → "74651" (the form the live stream pushes). */
const num = (v: string) => new Decimal(v).toFixed();

/** One contract's newest stored quote, as shown to investors and admins (live via the quote stream). */
export interface LiveQuoteDto {
  instrumentId: string;
  symbol: string;
  exchangeSymbol: string;
  quote: { bid: string; ask: string; mark: string; last: string; source: string; channel: string | null; sourceLabel: string; asOf: string } | null;
}

/**
 * TrendPilot's latest stored quote per contract. Reads the database only: refreshing a page never
 * calls MEXC. Investors see published contracts; admins see every contract.
 */
export async function listLatestQuotes(db: Executor, now = new Date(), o: { publishedOnly?: boolean } = {}): Promise<LiveQuoteDto[]> {
  const rows = await db
    .select({ id: instruments.id, symbol: instruments.symbol, exchangeSymbol: instruments.exchangeSymbol, status: instruments.status })
    .from(instruments)
    .orderBy(instruments.symbol);
  const byInst = await latestQuoteRows(db, now);
  return rows
    .filter((r) => !o.publishedOnly || r.status === 'PUBLISHED')
    .map((r) => {
      const q = byInst.get(r.id);
      return {
        instrumentId: r.id,
        symbol: r.symbol,
        exchangeSymbol: r.exchangeSymbol,
        quote: q ? { bid: num(q.bid), ask: num(q.ask), mark: num(q.mark), last: num(q.last), source: q.source, channel: q.channel, sourceLabel: quoteSourceLabel(q.source, q.channel), asOf: new Date(q.as_of).toISOString() } : null
      };
    });
}

/** What the running feed process reports about its ticker transport (from its heartbeat). */
export interface FeedTransportDto {
  instance: string;
  lastSeenAt: string;
  reporting: boolean;
  /** `ws` (WebSocket primary) or `rest` (legacy polling). */
  tickerSource: string | null;
  restFallback: boolean | null;
  stream: TickerStreamStatus | null;
  /** REST requests since the process started, by endpoint. */
  restCalls: Record<string, number>;
  restPausedUntil: string | null;
  /** Other feed instances reporting at the same time (should be none: one feed per deployment). */
  otherInstances: string[];
}

export async function getFeedTransport(db: Executor, now = new Date()): Promise<FeedTransportDto | null> {
  const rows = await db
    .select()
    .from(serviceHeartbeats)
    .where(and(eq(serviceHeartbeats.service, 'market-feed'), isNull(serviceHeartbeats.stoppedAt)))
    .orderBy(desc(serviceHeartbeats.lastSeenAt));
  const live = rows.filter((r) => now.getTime() - r.lastSeenAt.getTime() <= 45_000);
  const h = live[0] ?? rows[0];
  if (!h) return null;
  const d = (h.detail ?? {}) as { tickerSource?: string; restFallback?: boolean; stream?: TickerStreamStatus; restCalls?: Record<string, number>; restPausedUntil?: string | null };
  return {
    instance: h.instance,
    lastSeenAt: h.lastSeenAt.toISOString(),
    reporting: now.getTime() - h.lastSeenAt.getTime() <= 45_000,
    tickerSource: d.tickerSource ?? null,
    restFallback: d.restFallback ?? null,
    stream: d.stream ?? null,
    restCalls: d.restCalls ?? {},
    restPausedUntil: d.restPausedUntil ?? null,
    otherInstances: live.filter((r) => r.instance !== h.instance && (r.detail as { role?: string })?.role !== 'standby').map((r) => r.instance)
  };
}
