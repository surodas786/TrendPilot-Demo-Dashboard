import { DEFAULT_RISK_SETTINGS, instrumentSpecs } from '../data/strategyCatalog';
import { entryNotional, round2 } from './accountMath';
import type { InstrumentSpec, PendingEntry, RiskSettings } from '../types/risk';
import type { AccountSummary, Direction, Position } from '../types/trading';

export function riskSettingsFor(map: Record<string, RiskSettings>, accountId: string): RiskSettings {
  return map[accountId] ?? DEFAULT_RISK_SETTINGS;
}

/** Initial stop risk from the position's exit snapshot. Unknown is never treated as zero. */
export function positionStopRisk(p: Position): number | null {
  if (p.initialStop === null) return null;
  return round2(Math.abs(p.entryPrice - p.initialStop) * p.quantity);
}

export interface RiskBlocker {
  id: 'positions' | 'notional' | 'stop-risk' | 'stop-risk-incomplete' | 'daily-loss' | 'margin';
  reason: string;
  /** True when existing exposure is already above a (possibly newly lowered) limit. */
  exceeds: boolean;
}

export interface RiskUsage {
  openPositions: {used: number;pending: number;limit: number;};
  notional: {used: number;pending: number;limit: number;};
  stopRisk: {used: number;pending: number;limit: number;incomplete: boolean;unknownPairs: string[];};
  dailyLoss: {netRealized: number;unrealized: number;pnl: number;used: number;limit: number;basis: RiskSettings['dailyLossBasis'];};
  margin: {available: number;pendingMargin: number;reserve: number;afterReserve: number;};
  blockers: RiskBlocker[];
}

/**
 * Current usage and remaining capacity for an account.
 * Daily P&L uses Asia/Dhaka day boundaries (all demo records belong to the reporting day)
 * and never includes virtual fund transfers.
 */
export function computeRiskUsage(
summary: AccountSummary,
positions: Position[],
pending: PendingEntry[],
settings: RiskSettings)
: RiskUsage {
  const stopRisks = positions.map((p) => ({ p, risk: positionStopRisk(p) }));
  const unknownPairs = stopRisks.filter((s) => s.risk === null).map((s) => s.p.pair);
  const pendingStopUnknown = pending.some((e) => e.stopRisk === null);
  const stopUsed = round2(stopRisks.reduce((acc, s) => acc + (s.risk ?? 0), 0));
  const stopPending = round2(pending.reduce((acc, e) => acc + (e.stopRisk ?? 0), 0));

  const notionalUsed = round2(positions.reduce((acc, p) => acc + entryNotional(p), 0));
  const notionalPending = round2(pending.reduce((acc, e) => acc + e.notional, 0));
  // Working entry orders are already deducted from available margin (marginReserved); never count them twice.
  const pendingMargin = round2(pending.reduce((acc, e) => acc + (e.marginReserved ? 0 : e.orderCost), 0));

  const pnl = round2(summary.netRealized + (settings.dailyLossBasis === 'net-plus-unrealized' ? summary.unrealized : 0));
  const dailyUsed = round2(Math.max(0, -pnl));
  const afterReserve = round2(summary.availableMargin - pendingMargin - settings.freeMarginReserve);

  const usage: RiskUsage = {
    openPositions: { used: positions.length, pending: pending.length, limit: settings.maxOpenPositions },
    notional: { used: notionalUsed, pending: notionalPending, limit: settings.maxAggregateNotional },
    stopRisk: {
      used: stopUsed,
      pending: stopPending,
      limit: settings.maxAggregateStopRisk,
      incomplete: unknownPairs.length > 0 || pendingStopUnknown,
      unknownPairs
    },
    dailyLoss: { netRealized: summary.netRealized, unrealized: summary.unrealized, pnl, used: dailyUsed, limit: settings.dailyLossLimit, basis: settings.dailyLossBasis },
    margin: { available: summary.availableMargin, pendingMargin, reserve: settings.freeMarginReserve, afterReserve },
    blockers: []
  };

  const blockers: RiskBlocker[] = [];
  const posTotal = usage.openPositions.used + usage.openPositions.pending;
  if (posTotal > settings.maxOpenPositions) {
    blockers.push({ id: 'positions', exceeds: true, reason: `Current exposure exceeds the new limit — ${posTotal} open or pending vs maximum ${settings.maxOpenPositions}` });
  } else if (posTotal === settings.maxOpenPositions) {
    blockers.push({ id: 'positions', exceeds: false, reason: `Maximum open positions reached (${settings.maxOpenPositions})` });
  }
  const notionalTotal = round2(notionalUsed + notionalPending);
  if (notionalTotal > settings.maxAggregateNotional) {
    blockers.push({ id: 'notional', exceeds: true, reason: `Current exposure exceeds the new limit — aggregate notional ${fmt(notionalTotal)} vs ${fmt(settings.maxAggregateNotional)} USDT` });
  }
  if (usage.stopRisk.incomplete) {
    blockers.push({
      id: 'stop-risk-incomplete',
      exceeds: false,
      reason: `Risk data incomplete — initial stop unknown for ${unknownPairs.length ? unknownPairs.join(', ') : 'a pending entry'}`
    });
  } else if (stopUsed + stopPending > settings.maxAggregateStopRisk) {
    blockers.push({ id: 'stop-risk', exceeds: true, reason: `Current exposure exceeds the new limit — initial stop risk ${fmt(stopUsed + stopPending)} vs ${fmt(settings.maxAggregateStopRisk)} USDT` });
  }
  if (dailyUsed >= settings.dailyLossLimit) {
    blockers.push({ id: 'daily-loss', exceeds: false, reason: `Daily loss limit reached — ${fmt(dailyUsed)} of ${fmt(settings.dailyLossLimit)} USDT used` });
  }
  if (summary.currentEquity > 0 && afterReserve <= 0) {
    blockers.push({ id: 'margin', exceeds: false, reason: 'Available margin is at or below the free-margin reserve' });
  }
  usage.blockers = blockers;
  return usage;
}

export interface OrderPreviewInput {
  pair: string;
  direction: Direction;
  orderCost: number;
  leverage: number;
  feeRatePct: number;
  price: number;
  availableMargin: number;
  pendingMargin: number;
  reserve: number;
}

export interface OrderPreview {
  spec: InstrumentSpec;
  input: OrderPreviewInput;
  targetNotional: number;
  rawQuantity: number;
  roundedQuantity: number;
  contracts: number;
  resultNotional: number;
  margin: number;
  entryFee: number;
  required: number;
  remainingAfter: number;
  valid: boolean;
  errors: string[];
}

/**
 * Target notional = order cost × leverage. Quantity = notional ÷ price, rounded DOWN to the
 * fictional quantity step. Resulting notional and margin derive from the rounded quantity.
 * The requested cost is never increased to meet a minimum.
 */
export function computeOrderPreview(input: OrderPreviewInput): OrderPreview {
  const spec = instrumentSpecs[input.pair];
  const errors: string[] = [];
  const cost = Number.isFinite(input.orderCost) ? input.orderCost : 0;
  const targetNotional = round2(cost * input.leverage);
  const rawQuantity = input.price > 0 ? targetNotional / input.price : 0;
  const steps = Math.floor(rawQuantity / spec.quantityStep + 1e-9);
  const roundedQuantity = Number((steps * spec.quantityStep).toFixed(spec.quantityDecimals));
  const contracts = Math.round(roundedQuantity / spec.contractSize);
  const resultNotional = round2(roundedQuantity * input.price);
  const margin = round2(resultNotional / input.leverage);
  const entryFee = round2(resultNotional * (input.feeRatePct / 100));
  const required = round2(margin + entryFee);
  const remainingAfter = round2(input.availableMargin - input.pendingMargin - required);

  if (cost <= 0) errors.push('Enter an order cost above 0 USDT.');else
  if (roundedQuantity < spec.minQuantity) {
    errors.push(
      `Rounded quantity ${roundedQuantity.toFixed(spec.quantityDecimals)} ${spec.baseAsset} is below the simulated minimum of ${spec.minQuantity} ${spec.baseAsset}. Order cost is not increased to meet the minimum.`
    );
  }
  if (cost > 0 && remainingAfter < input.reserve) {
    errors.push(`Remaining available margin (${fmt(remainingAfter)} USDT) would fall below the free-margin reserve of ${fmt(input.reserve)} USDT.`);
  }

  return { spec, input, targetNotional, rawQuantity, roundedQuantity, contracts, resultNotional, margin, entryFee, required, remainingAfter, valid: errors.length === 0, errors };
}

function fmt(v: number): string {
  return v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}