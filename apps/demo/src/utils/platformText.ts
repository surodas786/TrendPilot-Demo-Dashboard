import type { AlertMessage, EntryDirection, OppositeBehavior, SignalSide, SignalTimeframe, StrategyPackage, TrendFilter } from '../types/platform';

export const DIRECTION_LABELS: Record<EntryDirection, string> = { long: 'Long only', short: 'Short only', both: 'Long and short' };

/** Display order: Keep position open first. Stored values are unchanged. */
export const OPPOSITE_ORDER: OppositeBehavior[] = ['ignore', 'close', 'reverse'];

export const OPPOSITE_LABELS: Record<OppositeBehavior, string> = {
  ignore: 'Keep position open',
  close: 'Close position only',
  reverse: 'Close and reverse'
};

/** Same short labels everywhere (package list, subscriber summary). */
export const OPPOSITE_SHORT = OPPOSITE_LABELS;

export const OPPOSITE_DESCRIPTIONS: Record<OppositeBehavior, string> = {
  ignore: 'If a signal comes in the opposite direction, keep the current trade open.',
  close: 'Close the current trade. Wait for another eligible signal before opening a new trade.',
  reverse: 'Close the current trade first. Open a trade in the opposite direction once the close is confirmed and the settings allow it.'
};

/** One example: an open LONG receives a SHORT signal. */
export const OPPOSITE_EXAMPLES: Record<OppositeBehavior, string> = {
  ignore: 'You’re in a LONG trade. A SHORT signal arrives. The LONG stays open and no SHORT opens.',
  close: 'You’re in a LONG trade. A SHORT signal arrives. The LONG closes. No SHORT opens until another eligible signal arrives.',
  reverse: 'You’re in a LONG trade. A SHORT signal arrives. The LONG closes first. A SHORT opens only if your settings allow it.'
};

export const TIMEFRAME_LABELS: Record<SignalTimeframe, string> = { '5m': '5 minutes (5m)', '15m': '15 minutes (15m)' };
export const TIMEFRAMES: SignalTimeframe[] = ['5m', '15m'];

export const TREND_FILTER_LABELS: Record<TrendFilter, string> = { off: 'Off', ema200: 'EMA 200' };
export const trendFilterShort = (f: TrendFilter | undefined) => `Trend filter: ${TREND_FILTER_LABELS[f ?? 'off']}`;

/** Short label for lists and summaries. */
export function timeframeShort(tf: SignalTimeframe | undefined): string {
  return tf ?? 'Timeframe not set';
}

/** Normalizes a TradingView interval: 5 / 5m → 5m, 15 / 15m → 15m. Null when missing; the raw value otherwise. */
export function normalizeInterval(raw: unknown): {timeframe: SignalTimeframe | null;raw: string | null;} {
  if (raw === undefined || raw === null || String(raw).trim() === '') return { timeframe: null, raw: null };
  const v = String(raw).trim().toLowerCase();
  if (v === '5' || v === '5m') return { timeframe: '5m', raw: v };
  if (v === '15' || v === '15m') return { timeframe: '15m', raw: v };
  return { timeframe: null, raw: v };
}

/** Reversal can't open the blocked side when the package allows only one direction. */
export function reversalLimited(p: Pick<StrategyPackage, 'direction' | 'opposite'>): boolean {
  return p.opposite === 'reverse' && p.direction !== 'both';
}

let seq = 0;
export function makeDemoSignalId(symbol: string, side: SignalSide, at: number): string {
  seq += 1;
  return `TP-${symbol.replace('USDT', '')}-${side[0]}-${at.toString(36).toUpperCase()}${seq}`;
}

export function buildAlert(symbol: string, side: SignalSide, at: number, interval: SignalTimeframe = '15m', extra: Partial<AlertMessage> = {}): AlertMessage {
  const minutes = interval === '5m' ? 5 : 15;
  const ms = minutes * 60000;
  const close = Math.floor(at / ms) * ms; // last completed candle's close
  const barOpen = close - ms; // TradingView {{time}} = candle opening time
  const routePart = extra.route_id ? `${extra.route_id}-` : '';
  return {
    signal_id: `${routePart}${makeDemoSignalId(symbol, side, at)}`,
    symbol,
    exchange: 'MEXC',
    action: side,
    interval,
    // The alert fires just after the candle closes.
    timestamp: new Date(close + 1200).toISOString(),
    bar_time: new Date(barOpen).toISOString(),
    ...extra
  };
}

/** EMA 200 trend check for a new entry. Returns the block reason, or null when it passes. */
export function emaBlocker(side: 'long' | 'short', close: number | null | undefined, ema: number | null | undefined): string | null {
  if (close === null || close === undefined || ema === null || ema === undefined || !Number.isFinite(close) || !Number.isFinite(ema)) return 'EMA 200 data missing for the signal candle — new entry blocked.';
  if (close === ema) return `Close ${close} equals EMA 200 — new entry blocked.`;
  if (side === 'long' && close < ema) return `Close ${close} is below EMA 200 (${ema}) — LONG entry blocked.`;
  if (side === 'short' && close > ema) return `Close ${close} is above EMA 200 (${ema}) — SHORT entry blocked.`;
  return null;
}

export function formatPrice(v: number): string {
  const d = v >= 1000 ? 1 : v >= 10 ? 2 : v >= 1 ? 3 : 4;
  return v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
}