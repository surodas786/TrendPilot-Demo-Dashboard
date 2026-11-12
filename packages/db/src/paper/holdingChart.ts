import { and, asc, desc, eq, gte } from 'drizzle-orm';
import { Decimal } from '@trendpilot/domain';
import type { Executor } from '../client';
import { instruments, marketCandles, marketQuotes, positions } from '../schema';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const n = (v: string) => new Decimal(v).toFixed();

export interface ChartCandle {
  /** Bar open, epoch seconds (UTC). */
  time: number;
  open: string;
  high: string;
  low: string;
  close: string;
}

export interface HoldingChartDto {
  positionId: string;
  status: string;
  side: string;
  /** The exact contract the candles and lines belong to. */
  exchange: string;
  exchangeSymbol: string;
  symbol: string;
  interval: '5' | '15';
  candles: ChartCandle[];
  /** Used when no exchange candles are stored yet: TrendPilot's recorded mark prices. */
  quoteLine: { time: number; value: string }[];
  source: string | null;
  /** Labelled horizontal lines. The stop is the current effective stop, or the last recorded one once closed. */
  lines: { kind: 'ENTRY' | 'STOP'; price: string; label: string; historical: boolean }[];
}

/**
 * Chart data for one of the owner's positions: TrendPilot's stored exchange candles for that
 * position's own contract around its life, and the entry and stop price lines. Owner-scoped:
 * another investor's position ID behaves like a missing one. Never calls the exchange.
 */
export async function getMyHoldingChart(db: Executor, ownerId: string, positionId: string, o: { now: Date; bars?: number }): Promise<HoldingChartDto | undefined> {
  if (!UUID.test(positionId)) return undefined;
  const [row] = await db
    .select({ p: positions, inst: instruments })
    .from(positions)
    .innerJoin(instruments, eq(instruments.id, positions.instrumentId))
    .where(and(eq(positions.id, positionId), eq(positions.ownerId, ownerId)));
  if (!row) return undefined;
  const { p, inst } = row;
  const bars = Math.min(Math.max(o.bars ?? 300, 50), 1000);

  // Prefer 15m candles; use 5m if that is what the feed stores for this contract.
  let interval: '5' | '15' = '15';
  let rows: (typeof marketCandles.$inferSelect)[] = [];
  for (const iv of ['15', '5'] as const) {
    const end = p.closedAt ?? o.now;
    rows = await db
      .select()
      .from(marketCandles)
      .where(and(eq(marketCandles.instrumentId, p.instrumentId), eq(marketCandles.interval, iv), gte(marketCandles.openTime, new Date(p.openedAt.getTime() - bars * Number(iv) * 60_000))))
      .orderBy(desc(marketCandles.openTime))
      .limit(bars + Math.ceil((end.getTime() - p.openedAt.getTime()) / (Number(iv) * 60_000)) + 4);
    if (rows.length) {
      interval = iv;
      break;
    }
  }
  rows.reverse();
  const candles = rows.map((c) => ({ time: Math.floor(c.openTime.getTime() / 1000), open: n(c.open), high: n(c.high), low: n(c.low), close: n(c.close) }));

  const quotes = candles.length
    ? []
    : await db
        .select({ asOf: marketQuotes.asOf, mark: marketQuotes.mark, source: marketQuotes.source })
        .from(marketQuotes)
        .where(and(eq(marketQuotes.instrumentId, p.instrumentId), gte(marketQuotes.asOf, new Date(p.openedAt.getTime() - 6 * 3600_000))))
        .orderBy(asc(marketQuotes.asOf))
        .limit(2000);
  const quoteLine: HoldingChartDto['quoteLine'] = [];
  for (const q of quotes) {
    const time = Math.floor(q.asOf.getTime() / 1000);
    if (quoteLine.length && quoteLine[quoteLine.length - 1]!.time >= time) continue; // one point per second, ascending
    quoteLine.push({ time, value: n(q.mark) });
  }

  const closed = p.status === 'CLOSED';
  return {
    positionId: p.id,
    status: p.status,
    side: p.side,
    exchange: inst.exchange,
    exchangeSymbol: inst.exchangeSymbol || inst.symbol,
    symbol: inst.symbol,
    interval,
    candles,
    quoteLine,
    source: rows[rows.length - 1]?.source ?? quotes[quotes.length - 1]?.source ?? null,
    lines: [
      { kind: 'ENTRY', price: n(p.avgEntryPrice), label: 'Avg entry', historical: false },
      { kind: 'STOP', price: n(p.stopPrice), label: closed ? 'Stop loss (historical)' : 'Stop loss', historical: closed }
    ]
  };
}
