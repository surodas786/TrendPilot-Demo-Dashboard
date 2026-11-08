import { Decimal } from './decimal';
import type { PriceBasis } from './orderBlock';
import type { SignalAction } from './signals';
import type { OppositePolicy } from './strategy';

/**
 * EXT-01…07 and STR-04/05/06 exit rules for paper positions. Pure functions.
 */

export type ExitReason = 'STOP_LOSS' | 'TAKE_PROFIT' | 'TRAILING_STOP' | 'SIGNAL_CLOSE' | 'OPPOSITE_SIGNAL_CLOSE' | 'REVERSAL_CLOSE' | 'MANUAL_CLOSE';

export const EXIT_REASON_TEXT: Record<ExitReason, string> = {
  STOP_LOSS: 'The attached stop loss was triggered.',
  TAKE_PROFIT: 'A take-profit target was reached.',
  TRAILING_STOP: 'Price came back to the trailing stop level.',
  SIGNAL_CLOSE: 'A matching close signal was received.',
  OPPOSITE_SIGNAL_CLOSE: 'An opposite signal closed the position (policy: close position only).',
  REVERSAL_CLOSE: 'An opposite signal closed the position to reverse it (policy: close and reverse).',
  MANUAL_CLOSE: 'You closed the position at market.'
};

type Side = 'LONG' | 'SHORT';
const D = (v: Decimal.Value) => new Decimal(v);

/** Price on the requested basis from a quote. */
export const basisPrice = (q: { mark: string; last: string }, basis: PriceBasis) => (basis === 'MARK' ? q.mark : q.last);

/**
 * Fixed TP target from the confirmed average entry. Rounded toward entry to the tick so the
 * target is never further than configured.
 */
export function takeProfitPrice(side: Side, avgEntry: string, movePct: string, tick: string): string {
  const raw = side === 'LONG' ? D(avgEntry).times(D(1).plus(D(movePct).div(100))) : D(avgEntry).times(D(1).minus(D(movePct).div(100)));
  return raw.div(tick).toDecimalPlaces(0, side === 'LONG' ? Decimal.ROUND_DOWN : Decimal.ROUND_UP).times(tick).toFixed();
}

/** EXT-07: Long TP at or above target; Short TP at or below. */
export const takeProfitReached = (side: Side, price: string, target: string) => (side === 'LONG' ? D(price).gte(target) : D(price).lte(target));

/** A Long's stop sells when price falls to it; a Short's stop buys when price rises to it. */
export const stopReached = (positionSide: Side, price: string, stop: string) => (positionSide === 'LONG' ? D(price).lte(stop) : D(price).gte(stop));

/** Gross realized P&L of closing `contracts` at `exitPrice`. Fees are booked separately. */
export function realizedPnl(side: Side, avgEntry: string, exitPrice: string, contracts: string, multiplier: string): string {
  const qty = D(contracts).times(multiplier);
  const diff = side === 'LONG' ? D(exitPrice).minus(avgEntry) : D(avgEntry).minus(exitPrice);
  return diff.times(qty).toDecimalPlaces(8).toFixed();
}

/**
 * Margin released by a close, proportional to the closed share. The final close releases the
 * exact remainder so rounding can never leave margin behind or release more than was posted.
 */
export function marginRelease(marginRemaining: string, contractsBefore: string, contractsClosed: string): string {
  if (D(contractsClosed).gte(contractsBefore)) return D(marginRemaining).toFixed();
  return D(marginRemaining).times(contractsClosed).div(contractsBefore).toDecimalPlaces(8, Decimal.ROUND_DOWN).toFixed();
}

export type SignalExitDecision =
  | { kind: 'CLOSE'; reason: ExitReason }
  | { kind: 'HOLD'; reason: 'KEEP_OPEN' | 'SAME_DIRECTION' }
  | { kind: 'NONE'; reason: 'CLOSE_SIDE_MISMATCH' };

/**
 * STR-03/04/05 for an existing managed position, using the policy saved with the position.
 * Entry restrictions (pause, weekday, EMA) never apply here.
 */
export function decideSignalExit(action: SignalAction, positionSide: Side, savedPolicy: OppositePolicy): SignalExitDecision {
  if (action === 'CLOSE_LONG' || action === 'CLOSE_SHORT') {
    const matches = (action === 'CLOSE_LONG' && positionSide === 'LONG') || (action === 'CLOSE_SHORT' && positionSide === 'SHORT');
    return matches ? { kind: 'CLOSE', reason: 'SIGNAL_CLOSE' } : { kind: 'NONE', reason: 'CLOSE_SIDE_MISMATCH' };
  }
  const flipSide: Side = action === 'BULLISH_FLIP' ? 'LONG' : 'SHORT';
  if (flipSide === positionSide) return { kind: 'HOLD', reason: 'SAME_DIRECTION' };
  if (savedPolicy === 'KEEP_OPEN') return { kind: 'HOLD', reason: 'KEEP_OPEN' };
  return { kind: 'CLOSE', reason: savedPolicy === 'CLOSE_ONLY' ? 'OPPOSITE_SIGNAL_CLOSE' : 'REVERSAL_CLOSE' };
}

/* ───────────────────────── EXT-03 split take profit ───────────────────────── */

export interface PlannedTarget {
  levelId: string;
  ordinal: number;
  movePct: string;
  closePct: string;
  triggerPrice: string;
  plannedContracts: string;
}

/**
 * Targets from the saved plan and the confirmed fill. Each closes `closePct` of the base
 * (initially filled) quantity, rounded down to the contract step. A plan that allocates exactly
 * 100% gives the last target the exact remainder, so the targets add up to the whole position;
 * a smaller allocation leaves the remainder to the trailing stop (or the stop loss).
 */
export function planTargets(
  side: Side,
  avgEntry: string,
  baseContracts: string,
  tp: { mode: 'FIXED' | 'SPLIT' | 'OFF'; levels: { id: string; movePct: string; closePct: string }[] },
  spec: { priceTick: string; qtyStep: string }
): PlannedTarget[] {
  if (tp.mode === 'OFF' || tp.levels.length === 0) return [];
  const levels = tp.mode === 'FIXED' ? [{ ...tp.levels[0]!, closePct: '100' }] : tp.levels;
  const full = levels.reduce((sum, l) => sum.plus(l.closePct), D(0)).eq(100);
  let allocated = D(0);
  return levels.map((l, i) => {
    const last = i === levels.length - 1;
    const share = full && last ? D(baseContracts).minus(allocated) : D(baseContracts).times(l.closePct).div(100).div(spec.qtyStep).floor().times(spec.qtyStep);
    allocated = allocated.plus(share);
    return { levelId: l.id, ordinal: i + 1, movePct: l.movePct, closePct: l.closePct, triggerPrice: takeProfitPrice(side, avgEntry, l.movePct, spec.priceTick), plannedContracts: share.toFixed() };
  });
}

export type TargetStatus = 'PENDING' | 'REQUESTED' | 'PARTIAL' | 'DONE' | 'CANCELLED';

/** Target status from confirmed fills only — a touched target is not a fill (EXT-06). */
export function targetStatusAfter(planned: string, filled: string, inFlight: boolean): TargetStatus {
  if (D(filled).gte(planned)) return 'DONE';
  if (inFlight) return 'REQUESTED';
  return D(filled).gt(0) ? 'PARTIAL' : 'PENDING';
}

/* ───────────────────────── EXT-04 trailing stop ───────────────────────── */

const toTick = (v: Decimal, tick: string, mode: Decimal.Rounding) => v.div(tick).toDecimalPlaces(0, mode).times(tick);

/** Price at which trailing activates: a favourable move from entry. Null = active from entry. */
export function trailingActivationPrice(side: Side, avgEntry: string, activationPct: string | null, tick: string): string | null {
  if (activationPct === null) return null;
  const raw = side === 'LONG' ? D(avgEntry).times(D(1).plus(D(activationPct).div(100))) : D(avgEntry).times(D(1).minus(D(activationPct).div(100)));
  return toTick(raw, tick, side === 'LONG' ? Decimal.ROUND_UP : Decimal.ROUND_DOWN).toFixed();
}

/** Long: high less distance (rounded down). Short: low plus distance (rounded up). Never closer than configured. */
export function trailingLevelFrom(side: Side, watermark: string, distancePct: string, tick: string): string {
  const raw = side === 'LONG' ? D(watermark).times(D(1).minus(D(distancePct).div(100))) : D(watermark).times(D(1).plus(D(distancePct).div(100)));
  return toTick(raw, tick, side === 'LONG' ? Decimal.ROUND_DOWN : Decimal.ROUND_UP).toFixed();
}

export interface TrailingState {
  status: 'WAITING' | 'ACTIVE';
  activationPrice: string | null;
  watermark: string | null;
  level: string | null;
}

export interface TrailingStep {
  state: TrailingState;
  activated: boolean;
  /** The level moved (only ever tighter). */
  tightened: boolean;
  triggered: boolean;
}

/**
 * One price on the trailing stop's saved basis. The trigger is checked against the level held
 * before this price, then the watermark (highest for a Long, lowest for a Short) and the level
 * move — tighten-only.
 */
export function advanceTrailing(side: Side, s: TrailingState, price: string, cfg: { distancePct: string; tick: string }): TrailingStep {
  const long = side === 'LONG';
  if (s.status === 'WAITING') {
    const reached = s.activationPrice === null || (long ? D(price).gte(s.activationPrice) : D(price).lte(s.activationPrice));
    if (!reached) return { state: s, activated: false, tightened: false, triggered: false };
    const level = trailingLevelFrom(side, price, cfg.distancePct, cfg.tick);
    return { state: { ...s, status: 'ACTIVE', watermark: D(price).toFixed(), level }, activated: true, tightened: true, triggered: false };
  }
  const level = s.level!;
  if (long ? D(price).lte(level) : D(price).gte(level)) return { state: s, activated: false, tightened: false, triggered: true };
  const better = long ? D(price).gt(s.watermark!) : D(price).lt(s.watermark!);
  if (!better) return { state: s, activated: false, tightened: false, triggered: false };
  const candidate = trailingLevelFrom(side, price, cfg.distancePct, cfg.tick);
  const tighter = long ? D(candidate).gt(level) : D(candidate).lt(level);
  return { state: { ...s, watermark: D(price).toFixed(), level: tighter ? candidate : level }, activated: false, tightened: tighter, triggered: false };
}

/* ───────────────────────── STR-06 close and reverse ───────────────────────── */

export type ReversalWithheldReason = 'REVERSAL_CLOSE_INCOMPLETE' | 'REVERSAL_NOT_FLAT' | 'REVERSAL_PROTECTION_UNRECONCILED' | 'REVERSAL_ORDERS_UNRESOLVED';

export const REVERSAL_REASON_TEXT: Record<ReversalWithheldReason, string> = {
  REVERSAL_CLOSE_INCOMPLETE: 'The closing order did not confirm a flat position, so the opposite entry was withheld. The remainder stays protected by its stop.',
  REVERSAL_NOT_FLAT: 'The venue still reports exposure, so the opposite entry was withheld.',
  REVERSAL_PROTECTION_UNRECONCILED: 'The old stop is still active at the venue, so the opposite entry was withheld.',
  REVERSAL_ORDERS_UNRESOLVED: 'Another order is still unresolved for this contract, so the opposite entry was withheld.'
};
