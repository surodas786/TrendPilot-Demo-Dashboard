import { desc, eq, sql } from 'drizzle-orm';
import { FEED_POLICY, FEED_STATE_TEXT, marketSourceLabel, quoteAgeState, type FeedState } from '@trendpilot/domain';
import type { Executor } from '../client';
import { instruments, marketFeedEvents, marketFeedStatus, marketQuotes } from '../schema';

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
  latestQuote: { source: string; sourceLabel: string; asOf: string; ageSeconds: number; bid: string; ask: string; mark: string; last: string; freshness: 'FRESH' | 'STALE' } | null;
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
  const latest = await db.execute<{ instrument_id: string; as_of: Date | string; bid: string; ask: string; mark: string; last: string; source: string }>(sql`
    SELECT DISTINCT ON (instrument_id) instrument_id, as_of, bid, ask, mark, last, source
    FROM ${marketQuotes}
    WHERE as_of <= ${new Date(now.getTime() + 2_000).toISOString()}::timestamptz
    ORDER BY instrument_id, as_of DESC`);
  const byInst = new Map(latest.rows.map((r) => [r.instrument_id, r]));
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
              sourceLabel: marketSourceLabel(q.source),
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
