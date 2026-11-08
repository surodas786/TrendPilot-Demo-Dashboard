import { formatNumber } from './format';
import type { DistanceMethod, ExitMode, ExitPlan, ExitPlanConfig, StopMethod, TargetMethod, ThresholdMethod, TriggerBasis } from '../types/exitPlan';

export const MODE_LABELS: Record<ExitMode, string> = {
  fixed: 'A · Fixed target',
  trailing: 'B · Trailing',
  'partial-trailing': 'C · Partial profit and trailing'
};

export const TRIGGER_LABELS: Record<TriggerBasis, string> = {
  mark: 'Mark price',
  last: 'Last price'
};

export const STOP_METHOD_LABELS: Record<StopMethod, string> = {
  percent: '% from entry',
  price: 'Price distance',
  atr: 'ATR multiple'
};

export const TARGET_METHOD_LABELS: Record<TargetMethod, string> = {
  percent: '% price move',
  price: 'Target price',
  r: 'Risk multiple (R)'
};

export const THRESHOLD_LABELS: Record<ThresholdMethod, string> = {
  percent: '% price move',
  r: 'R multiple'
};

export const DISTANCE_LABELS: Record<DistanceMethod, string> = {
  percent: '% of best price',
  price: 'Price distance',
  r: 'R multiple'
};

function num(v: number | null, decimals = 2): string {
  return v === null || Number.isNaN(v) ? '—' : formatNumber(v, decimals).replace(/\.?0+$/, '') || '0';
}

export function amountText(method: 'percent' | 'price' | 'r' | 'atr', v: number | null): string {
  if (v === null || Number.isNaN(v)) return '—';
  if (method === 'percent') return `${num(v)}%`;
  if (method === 'price') return `${num(v)} USDT`;
  if (method === 'atr') return `${num(v)} × ATR`;
  return `${num(v)}R`;
}

export function stopRuleText(c: ExitPlanConfig): string {
  if (c.stopValue === null) return 'Not set';
  if (c.stopMethod === 'percent') return `${num(c.stopValue)}% from average entry`;
  if (c.stopMethod === 'price') return `${num(c.stopValue)} USDT per unit from entry`;
  return `${num(c.stopValue)} × ATR at entry`;
}

export function exitSummaryText(c: ExitPlanConfig): string {
  if (c.mode === 'fixed') {
    return c.targetMethod === 'price' ? `Close 100% at target price ${num(c.targetValue)}` : `Close 100% at ${amountText(c.targetMethod, c.targetValue)}`;
  }
  if (c.mode === 'trailing') {
    return `Trail ${amountText(c.trailMethod, c.trailValue)} after ${amountText(c.activationMethod, c.activationValue)} activation`;
  }
  return `Close ${c.closePct === null ? '—' : `${num(c.closePct)}%`} at ${amountText(c.partialMethod, c.partialValue)}${
  c.moveToBreakeven ? ', tighten toward est. breakeven' : ''}, trail rest ${
  amountText(c.trailMethod, c.trailValue)}`;
}

export function planLabel(p: Pick<ExitPlan, 'name' | 'version'>): string {
  return `${p.name} · v${p.version}`;
}