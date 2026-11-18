import { and, asc, desc, eq, gte } from 'drizzle-orm';
import { Decimal, isForeignPublicSource } from '@trendpilot/domain';
import type { Executor } from '../client';
import { exchangeConnections, instruments, marketCandles, marketQuotes, orderIntents, positions, signalEvents } from '../schema';

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
  /** The TradingView chart (source symbol and interval) whose signal opened this position, if any. */
  tradingView: { source: string; interval: '5' | '15' } | null;
  /**
   * Live protection as the exchange confirms it. CONFIRMED: the stop line is the exchange's own
   * stop for this leg; UNCONFIRMED / MISSING: the line is TrendPilot's planned stop and the exchange
   * did not confirm it. Paper: SIMULATED.
   */
  protection: { status: 'CONFIRMED' | 'UNCONFIRMED' | 'MISSING' | 'SIMULATED' | 'CLOSED'; text: string; kind: 'WHOLE_LEG' | 'FIXED_QTY' | null; exchangeStopPrice: string | null };
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

  // The TradingView chart that opened this position (its source symbol and timeframe).
  const [ev] = await db
    .select({ exchange: signalEvents.sourceExchange, symbol: signalEvents.sourceSymbol, interval: signalEvents.interval })
    .from(orderIntents)
    .innerJoin(signalEvents, eq(signalEvents.id, orderIntents.eventId))
    .where(eq(orderIntents.id, p.openIntentId));
  const tradingView = ev ? { source: `${ev.exchange}:${ev.symbol}`, interval: (ev.interval === '5' ? '5' : '15') as '5' | '15' } : null;

  // Prefer the mapped chart's timeframe, then 15m, then 5m: whatever the feed stores for this contract.
  let interval: '5' | '15' = '15';
  let rows: (typeof marketCandles.$inferSelect)[] = [];
  for (const iv of tradingView?.interval === '5' ? (['5', '15'] as const) : (['15', '5'] as const)) {
    const end = p.closedAt ?? o.now;
    rows = await db
      .select()
      .from(marketCandles)
      .where(and(eq(marketCandles.instrumentId, p.instrumentId), eq(marketCandles.interval, iv), gte(marketCandles.openTime, new Date(p.openedAt.getTime() - bars * Number(iv) * 60_000))))
      .orderBy(desc(marketCandles.openTime))
      .limit(bars + Math.ceil((end.getTime() - p.openedAt.getTime()) / (Number(iv) * 60_000)) + 4);
    // Only this contract's own exchange history: a candle from another exchange's feed is never drawn.
    rows = rows.filter((r) => !isForeignPublicSource(inst.exchange, r.source));
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
  const ownQuotes = quotes.filter((q) => !isForeignPublicSource(inst.exchange, q.source));
  for (const q of ownQuotes) {
    const time = Math.floor(q.asOf.getTime() / 1000);
    if (quoteLine.length && quoteLine[quoteLine.length - 1]!.time >= time) continue; // one point per second, ascending
    quoteLine.push({ time, value: n(q.mark) });
  }

  const closed = p.status === 'CLOSED';
  // Live on Bitunix: the stop Bitunix lists for this leg (pending TP/SL from the last account sync).
  let protection: HoldingChartDto['protection'];
  if (p.mode !== 'LIVE') protection = { status: closed ? 'CLOSED' : 'SIMULATED', text: closed ? 'Position closed.' : 'Paper: the simulator holds the stop.', kind: null, exchangeStopPrice: null };
  else if (closed) protection = { status: 'CLOSED', text: 'Position closed; the stop line is the last recorded stop.', kind: null, exchangeStopPrice: null };
  else if (inst.exchange === 'BITUNIX') {
    const [c] = await db.select({ s: exchangeConnections.accountState }).from(exchangeConnections).where(and(eq(exchangeConnections.ownerId, ownerId), eq(exchangeConnections.exchange, 'BITUNIX')));
    const listed = ((c?.s as { tpsl?: { positionId: string | null; slPrice: string | null; slQty: string | null }[] } | null)?.tpsl ?? []).find((t) => t.positionId === p.exchangePositionRef && t.slPrice !== null);
    protection = listed && p.protectionStatus === 'PROTECTED'
      ? { status: 'CONFIRMED', text: `Bitunix lists a ${listed.slQty === null ? 'whole-position' : `fixed-quantity (${n(listed.slQty)})`} stop at ${n(listed.slPrice!)} for this leg.`, kind: listed.slQty === null ? 'WHOLE_LEG' : 'FIXED_QTY', exchangeStopPrice: n(listed.slPrice!) }
      : listed
        ? { status: 'UNCONFIRMED', text: `Bitunix lists a stop at ${n(listed.slPrice!)}, but it does not cover the open quantity (${p.protectionStatus}).`, kind: listed.slQty === null ? 'WHOLE_LEG' : 'FIXED_QTY', exchangeStopPrice: n(listed.slPrice!) }
        : { status: 'MISSING', text: 'Bitunix lists no stop for this leg in the last sync: the position is not confirmed protected.', kind: null, exchangeStopPrice: null };
  } else {
    protection = p.protectionStatus === 'PROTECTED' ? { status: 'CONFIRMED', text: 'The exchange stop covers the open quantity (verified).', kind: null, exchangeStopPrice: n(p.stopPrice) } : { status: 'UNCONFIRMED', text: `Protection is ${p.protectionStatus}.`, kind: null, exchangeStopPrice: null };
  }
  const stopPrice = protection.exchangeStopPrice ?? n(p.stopPrice);
  const stopLabel = closed ? 'Stop loss (historical)' : protection.status === 'CONFIRMED' ? 'Exchange stop (confirmed)' : protection.status === 'SIMULATED' ? 'Stop loss' : 'Planned stop (not confirmed)';
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
    source: rows[rows.length - 1]?.source ?? ownQuotes[ownQuotes.length - 1]?.source ?? null,
    lines: [
      { kind: 'ENTRY', price: n(p.avgEntryPrice), label: 'Avg entry', historical: false },
      { kind: 'STOP', price: stopPrice, label: stopLabel, historical: closed }
    ],
    tradingView,
    protection
  };
}
