import { instrumentSpecs } from '../data/strategyCatalog';
import { round2 } from './accountMath';
import { computeOrderPreview } from './riskEngine';
import { formatNumber } from './format';
import type { ExitPlanConfig } from '../types/exitPlan';
import type { InstrumentSpec } from '../types/risk';
import type { Direction } from '../types/trading';

export interface ExitPreviewInput {
  config: ExitPlanConfig;
  pair: string;
  direction: Direction;
  entryPrice: number;
  atr: number;
  orderCost: number;
  leverage: number;
  feeRatePct: number;
  /** Used by the "partial exit below minimum" scenario to test a deliberately small hypothetical entry. */
  quantityOverride?: number;
}

export interface ExitPreview {
  spec: InstrumentSpec;
  direction: Direction;
  entryPrice: number;
  feeRate: number;
  quantity: number;
  notional: number;
  margin: number;
  entryFee: number;
  stopDistance: number | null;
  stopPrice: number | null;
  grossLossToStop: number | null;
  exitFeeAtStop: number | null;
  totalLossToStop: number | null;
  targetPrice: number | null;
  targetR: number | null;
  partial: {price: number;r: number;quantity: number;remaining: number;} | null;
  activationPrice: number | null;
  activationR: number | null;
  trailDistance: number | null;
  trailR: number | null;
  breakeven: number | null;
  errors: string[];
}

export const sideSign = (d: Direction): 1 | -1 => d === 'long' ? 1 : -1;

export function roundPrice(v: number, decimals: number): number {
  const f = 10 ** decimals;
  return Math.round(v * f) / f;
}

export function floorToStep(q: number, spec: InstrumentSpec): number {
  const steps = Math.floor(q / spec.quantityStep + 1e-9);
  return Number((steps * spec.quantityStep).toFixed(spec.quantityDecimals));
}

/** Absolute trailing distance. Percentage trails use the tracked best price; R trails use the original entry-to-stop distance. */
export function trailDistanceAt(c: ExitPlanConfig, bestPrice: number, rDistance: number): number | null {
  const v = c.trailValue;
  if (v === null || Number.isNaN(v) || v <= 0) return null;
  if (c.trailMethod === 'percent') return bestPrice * v / 100;
  if (c.trailMethod === 'price') return v;
  return rDistance * v;
}

/**
 * Estimated breakeven for the remaining quantity: covers the entry fee allocated to the
 * remainder, the estimated closing fee on the remainder and any reliably attributed funding.
 */
export function estimateBreakeven(direction: Direction, entry: number, remaining: number, allocatedEntryFee: number, feeRate: number, funding = 0): number {
  if (remaining <= 0) return entry;
  return direction === 'long' ?
  (entry * remaining + allocatedEntryFee + funding) / (remaining * (1 - feeRate)) :
  (entry * remaining - allocatedEntryFee - funding) / (remaining * (1 + feeRate));
}

export function computeExitPreview(i: ExitPreviewInput): ExitPreview {
  const spec = instrumentSpecs[i.pair];
  const c = i.config;
  const s = sideSign(i.direction);
  const dec = spec.priceDecimals;
  const f = i.feeRatePct / 100;
  const errors: string[] = [];
  const entry = i.entryPrice;
  const dirWord = i.direction === 'long' ? 'long' : 'short';

  if (!(entry > 0)) errors.push('Enter a simulated entry price above 0.');

  const order = computeOrderPreview({
    pair: i.pair,
    direction: i.direction,
    orderCost: i.orderCost,
    leverage: i.leverage,
    feeRatePct: i.feeRatePct,
    price: entry > 0 ? entry : 0,
    availableMargin: Number.MAX_SAFE_INTEGER,
    pendingMargin: 0,
    reserve: 0
  });
  const quantity = i.quantityOverride ?? order.roundedQuantity;
  if (i.quantityOverride === undefined) errors.push(...order.errors);else
  if (quantity < spec.minQuantity) errors.push(`Quantity ${formatNumber(quantity, spec.quantityDecimals)} ${spec.baseAsset} is below the simulated minimum ${spec.minQuantity} ${spec.baseAsset}.`);
  const notional = round2(quantity * entry);
  const margin = i.leverage > 0 ? round2(notional / i.leverage) : 0;
  const entryFee = round2(notional * f);

  // Initial stop — required for all modes.
  let raw: number | null = null;
  if (c.stopValue !== null && c.stopValue > 0) {
    if (c.stopMethod === 'percent') raw = entry * c.stopValue / 100;else
    if (c.stopMethod === 'price') raw = c.stopValue;else
    if (!(i.atr > 0)) errors.push('Enter a simulated ATR above 0 for an ATR-based stop.');else
    raw = i.atr * c.stopValue;
  }
  let stopPrice: number | null = null;
  let stopDistance: number | null = null;
  if (raw !== null && entry > 0) {
    const candidate = roundPrice(entry - s * raw, dec);
    const dist = roundPrice(Math.abs(entry - candidate), dec);
    if (dist <= 0) errors.push('Initial stop distance rounds to zero at this price — widen the stop.');else
    if (candidate <= 0) errors.push(`Initial stop would be at or below 0 for this ${dirWord}.`);else
    {
      stopPrice = candidate;
      stopDistance = dist;
    }
  }

  const grossLossToStop = stopDistance !== null ? round2(stopDistance * quantity) : null;
  const exitFeeAtStop = stopPrice !== null ? round2(stopPrice * quantity * f) : null;
  const totalLossToStop = grossLossToStop !== null && exitFeeAtStop !== null ? round2(grossLossToStop + entryFee + exitFeeAtStop) : null;

  const atR = (r: number) => roundPrice(entry + s * r * (stopDistance ?? 0), dec);
  const atPct = (p: number) => roundPrice(entry * (1 + s * p / 100), dec);
  const rOf = (price: number) => stopDistance ? s * (price - entry) / stopDistance : 0;

  let targetPrice: number | null = null;
  let targetR: number | null = null;
  if (c.mode === 'fixed' && c.targetValue !== null && c.targetValue > 0 && stopDistance) {
    targetPrice = c.targetMethod === 'price' ? c.targetValue : c.targetMethod === 'percent' ? atPct(c.targetValue) : atR(c.targetValue);
    targetR = rOf(targetPrice);
    if (s * (targetPrice - entry) <= 0) {
      errors.push(
        `Target price ${formatNumber(targetPrice, dec)} is not ${i.direction === 'long' ? 'above' : 'below'} entry ${formatNumber(entry, dec)} for a ${dirWord} — it must be on the profitable side.`
      );
    }
  }

  let activationPrice: number | null = null;
  let activationR: number | null = null;
  if (c.mode === 'trailing' && c.activationValue !== null && c.activationValue > 0 && stopDistance) {
    activationPrice = c.activationMethod === 'percent' ? atPct(c.activationValue) : atR(c.activationValue);
    activationR = rOf(activationPrice);
  }

  let partial: ExitPreview['partial'] = null;
  let breakeven: number | null = null;
  if (c.mode === 'partial-trailing' && c.partialValue !== null && c.partialValue > 0 && stopDistance) {
    const price = c.partialMethod === 'percent' ? atPct(c.partialValue) : atR(c.partialValue);
    if (c.closePct !== null && c.closePct > 0 && c.closePct < 100 && quantity > 0) {
      const pq = floorToStep(quantity * c.closePct / 100, spec);
      const rem = Number((quantity - pq).toFixed(spec.quantityDecimals));
      const q = (v: number) => `${formatNumber(v, spec.quantityDecimals)} ${spec.baseAsset}`;
      if (pq < spec.minQuantity) {
        errors.push(
          `Partial exit ${q(pq)} (${c.closePct}% of ${q(quantity)}, rounded down) is below the simulated minimum ${spec.minQuantity} ${spec.baseAsset}. The close percentage is not changed and the full position is not closed instead — this entry configuration is rejected.`
        );
      } else if (rem < spec.minQuantity) {
        errors.push(`Remaining quantity ${q(rem)} after the partial exit is below the simulated minimum ${spec.minQuantity} ${spec.baseAsset} — this entry configuration is rejected.`);
      }
      breakeven = roundPrice(estimateBreakeven(i.direction, entry, rem, quantity > 0 ? entryFee * rem / quantity : 0, f), dec);
      partial = { price, r: rOf(price), quantity: pq, remaining: rem };
    }
  }

  const trailDistance = stopDistance ? trailDistanceAt(c, entry, stopDistance) : null;
  const trailR = trailDistance !== null && stopDistance ? trailDistance / stopDistance : null;

  return {
    spec,
    direction: i.direction,
    entryPrice: entry,
    feeRate: f,
    quantity,
    notional,
    margin,
    entryFee,
    stopDistance,
    stopPrice,
    grossLossToStop,
    exitFeeAtStop,
    totalLossToStop,
    targetPrice,
    targetR,
    partial,
    activationPrice,
    activationR,
    trailDistance: c.mode === 'fixed' ? null : trailDistance,
    trailR: c.mode === 'fixed' ? null : trailR,
    breakeven,
    errors
  };
}