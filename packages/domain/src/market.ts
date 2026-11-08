import { Decimal } from './decimal';

/**
 * STR-09 EMA 200 on closed exchange candles, plus deterministic candle/quote fixtures.
 * Pure functions: the same candles always give the same result.
 */

export const EMA_PERIOD = 200;
/** Longest consecutive history used per evaluation (fixed window keeps results reproducible). */
export const EMA_MAX_WINDOW = 1000;

export interface Candle {
  /** Bar open (UTC). */
  openTime: Date;
  open: string;
  high: string;
  low: string;
  close: string;
  /** Only closed candles may feed EMA; a forming candle never does. */
  closed: boolean;
}

export type EmaResult =
  | { ok: true; ema: string; close: string; candlesUsed: number; seedFrom: string; through: string }
  | { ok: false; reason: 'EMA_UNAVAILABLE'; detail: 'NO_ALIGNED_CANDLE' | 'ALIGNED_CANDLE_NOT_CLOSED' | 'INSUFFICIENT_HISTORY'; candlesAvailable: number };

/**
 * EMA through the signal bar. The aligned candle is the one whose open equals the signal bar
 * open; it must be closed. History must be consecutive (no gaps) back from that bar for at least
 * 200 closes. Seed = arithmetic mean of the first 200 closes of the window; then
 * EMA = prev + (2/201) × (close − prev) for each later close, through the signal bar.
 */
export function emaAtSignalBar(candles: Candle[], signalBarOpen: Date, intervalMs: number, period = EMA_PERIOD, maxWindow = EMA_MAX_WINDOW): EmaResult {
  const byOpen = new Map(candles.map((c) => [c.openTime.getTime(), c]));
  const aligned = byOpen.get(signalBarOpen.getTime());
  if (!aligned) return { ok: false, reason: 'EMA_UNAVAILABLE', detail: 'NO_ALIGNED_CANDLE', candlesAvailable: 0 };
  if (!aligned.closed) return { ok: false, reason: 'EMA_UNAVAILABLE', detail: 'ALIGNED_CANDLE_NOT_CLOSED', candlesAvailable: 0 };

  // Walk back over consecutive closed candles, newest first.
  const run: Candle[] = [];
  for (let t = signalBarOpen.getTime(); run.length < maxWindow; t -= intervalMs) {
    const c = byOpen.get(t);
    if (!c || !c.closed) break;
    run.push(c);
  }
  if (run.length < period) return { ok: false, reason: 'EMA_UNAVAILABLE', detail: 'INSUFFICIENT_HISTORY', candlesAvailable: run.length };
  run.reverse(); // oldest first

  const D = Decimal.clone({ precision: 50 });
  const k = new D(2).div(period + 1);
  let ema = run.slice(0, period).reduce((s, c) => s.plus(c.close), new D(0)).div(period);
  for (const c of run.slice(period)) ema = ema.plus(k.times(new D(c.close).minus(ema)));

  return {
    ok: true,
    ema: ema.toDecimalPlaces(12).toFixed(),
    close: new D(aligned.close).toFixed(),
    candlesUsed: run.length,
    seedFrom: run[0]!.openTime.toISOString(),
    through: aligned.openTime.toISOString()
  };
}

export type EmaFilterResult = { pass: true; detail: Record<string, unknown> } | { pass: false; reason: 'EMA_UNAVAILABLE' | 'EMA_FILTERED'; detail: Record<string, unknown> };

/** Long passes above EMA, short below. Equality, missing data or misalignment block. Off bypasses. */
export function applyEmaFilter(filter: 'OFF' | 'EMA200', side: 'LONG' | 'SHORT', ema: EmaResult | null): EmaFilterResult {
  if (filter === 'OFF') return { pass: true, detail: { emaFilter: 'OFF' } };
  if (!ema || !ema.ok) return { pass: false, reason: 'EMA_UNAVAILABLE', detail: { emaFilter: 'EMA200', ...(ema && !ema.ok ? { cause: ema.detail, candlesAvailable: ema.candlesAvailable } : { cause: 'NO_CANDLES' }) } };
  const cmp = new Decimal(ema.close).comparedTo(ema.ema);
  const pass = side === 'LONG' ? cmp > 0 : cmp < 0;
  const detail = { emaFilter: 'EMA200', close: ema.close, ema: ema.ema, candlesUsed: ema.candlesUsed, through: ema.through, relation: cmp > 0 ? 'ABOVE' : cmp < 0 ? 'BELOW' : 'EQUAL' };
  return pass ? { pass: true, detail } : { pass: false, reason: 'EMA_FILTERED', detail };
}

/* ───────────────────────── Deterministic fixtures ───────────────────────── */

export type FixtureTrend = 'UP' | 'DOWN' | 'FLAT';

/**
 * `count` closed candles ending at `endBarOpen` (inclusive). The last close equals `endClose`.
 * UP/DOWN move `step` per bar with a small deterministic wiggle; FLAT is constant, so the
 * close equals EMA exactly. No randomness: the same arguments always give the same candles.
 */
export function fixtureCandles(o: { endBarOpen: Date; intervalMs: number; count: number; endClose: string; trend: FixtureTrend; step?: string; tick?: string }): Candle[] {
  const step = new Decimal(o.step ?? '10');
  const tick = new Decimal(o.tick ?? '0.1');
  const out: Candle[] = [];
  for (let i = 0; i < o.count; i++) {
    const barsFromEnd = o.count - 1 - i;
    const drift = o.trend === 'UP' ? step.times(-barsFromEnd) : o.trend === 'DOWN' ? step.times(barsFromEnd) : new Decimal(0);
    const wiggle = o.trend === 'FLAT' || barsFromEnd === 0 ? new Decimal(0) : new Decimal(((i * 7919) % 13) - 6).times(tick);
    const close = new Decimal(o.endClose).plus(drift).plus(wiggle);
    const open = o.trend === 'FLAT' ? close : close.minus(o.trend === 'UP' ? step : step.neg());
    const high = Decimal.max(open, close).plus(o.trend === 'FLAT' ? 0 : tick.times(5));
    const low = Decimal.min(open, close).minus(o.trend === 'FLAT' ? 0 : tick.times(5));
    out.push({ openTime: new Date(o.endBarOpen.getTime() - barsFromEnd * o.intervalMs), open: open.toFixed(), high: high.toFixed(), low: low.toFixed(), close: close.toFixed(), closed: true });
  }
  return out;
}

/** A quote centred on `mid` with a fixed half-spread, as of `asOf`. */
export function syntheticQuote(mid: string, asOf: Date, halfSpread = '0.5') {
  const m = new Decimal(mid);
  return { bid: m.minus(halfSpread).toFixed(), ask: m.plus(halfSpread).toFixed(), mark: m.toFixed(), last: m.toFixed(), asOf };
}
