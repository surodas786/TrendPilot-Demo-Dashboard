import { and, desc, eq, lte, sql } from 'drizzle-orm';
import { fixtureCandles, syntheticQuote, type Candle, type FixtureTrend, type PaperQuote } from '@trendpilot/domain';
import type { Executor } from '../client';
import { marketCandles, marketQuotes } from '../schema';

/** MKT-01 reads used by entry evaluation. Fixture-sourced in this slice. */

export async function loadClosedCandles(db: Executor, instrumentId: string, interval: string, upToOpen: Date, limit = 1000): Promise<Candle[]> {
  const rows = await db
    .select()
    .from(marketCandles)
    .where(and(eq(marketCandles.instrumentId, instrumentId), eq(marketCandles.interval, interval), lte(marketCandles.openTime, upToOpen)))
    .orderBy(desc(marketCandles.openTime))
    .limit(limit);
  return rows.reverse().map((r) => ({ openTime: r.openTime, open: r.open, high: r.high, low: r.low, close: r.close, closed: r.closed }));
}

/** Newest quote stamped at or before `now` (plus a small skew allowance). */
export async function latestQuote(db: Executor, instrumentId: string, now: Date, skewSeconds = 2): Promise<(PaperQuote & { source: string }) | null> {
  const [q] = await db
    .select()
    .from(marketQuotes)
    .where(and(eq(marketQuotes.instrumentId, instrumentId), lte(marketQuotes.asOf, new Date(now.getTime() + skewSeconds * 1000))))
    .orderBy(desc(marketQuotes.asOf))
    .limit(1);
  return q ? { bid: q.bid, ask: q.ask, mark: q.mark, asOf: q.asOf, source: q.source } : null;
}

export interface MarketFixtureOptions {
  instrumentId: string;
  interval: '5' | '15';
  /** Open of the newest closed candle (normally the signal bar). */
  endBarOpen: Date;
  count: number;
  endClose: string;
  trend: FixtureTrend;
  /** Open times to leave out (simulates missing history). */
  omit?: Date[];
  /** Write a quote centred on endClose at this time (null = no quote). */
  quoteAt: Date | null;
}

/** Writes deterministic fixture candles and a quote. Idempotent (upsert). */
export async function writeMarketFixture(db: Executor, o: MarketFixtureOptions): Promise<{ candles: number; quote: boolean }> {
  const intervalMs = Number(o.interval) * 60_000;
  const omit = new Set((o.omit ?? []).map((d) => d.getTime()));
  const cs = fixtureCandles({ endBarOpen: o.endBarOpen, intervalMs, count: o.count, endClose: o.endClose, trend: o.trend }).filter((c) => !omit.has(c.openTime.getTime()));
  for (let i = 0; i < cs.length; i += 500) {
    await db
      .insert(marketCandles)
      .values(cs.slice(i, i + 500).map((c) => ({ instrumentId: o.instrumentId, interval: o.interval, openTime: c.openTime, open: c.open, high: c.high, low: c.low, close: c.close, closed: c.closed, source: 'FIXTURE' })))
      .onConflictDoUpdate({
        target: [marketCandles.instrumentId, marketCandles.interval, marketCandles.openTime],
        set: { open: sql`excluded.open`, high: sql`excluded.high`, low: sql`excluded.low`, close: sql`excluded.close`, closed: sql`excluded.closed`, source: sql`excluded.source` }
      });
  }
  if (omit.size) {
    for (const t of omit) await db.delete(marketCandles).where(and(eq(marketCandles.instrumentId, o.instrumentId), eq(marketCandles.interval, o.interval), eq(marketCandles.openTime, new Date(t))));
  }
  if (o.quoteAt) {
    const q = syntheticQuote(o.endClose, o.quoteAt);
    await db
      .insert(marketQuotes)
      .values({ instrumentId: o.instrumentId, asOf: q.asOf, bid: q.bid, ask: q.ask, mark: q.mark, last: q.last, source: 'FIXTURE' })
      .onConflictDoUpdate({ target: [marketQuotes.instrumentId, marketQuotes.asOf], set: { bid: q.bid, ask: q.ask, mark: q.mark, last: q.last } });
  }
  return { candles: cs.length, quote: Boolean(o.quoteAt) };
}

export async function clearMarketData(db: Executor, instrumentId: string): Promise<void> {
  await db.delete(marketCandles).where(eq(marketCandles.instrumentId, instrumentId));
  await db.delete(marketQuotes).where(eq(marketQuotes.instrumentId, instrumentId));
}
