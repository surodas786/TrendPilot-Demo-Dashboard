import { CLOSE_SLIPPAGE_PCT } from '../data/mockData';
import { instrumentSpecs } from '../data/strategyCatalog';
import { closingFee, positionMargin, round2 } from './accountMath';
import { connectionHealth } from './connectionHealth';
import { roundQty } from './orders';
import { formatNumber } from './format';
import type { TradeRecord } from '../types/execution';
import type { ClosedTrade, DemoAccount, Position } from '../types/trading';

export interface QtyRules {
  step: number;
  min: number;
  decimals: number;
}

/** Shared fictional instrument rules for a position (not actual exchange specifications). */
export function qtyRules(p: Position): QtyRules {
  const spec = instrumentSpecs[p.pair];
  const fallback = 10 ** -p.quantityDecimals;
  return { step: spec?.quantityStep ?? fallback, min: spec?.minQuantity ?? fallback, decimals: Math.max(p.quantityDecimals, spec?.quantityDecimals ?? 0) };
}

export function floorToRules(value: number, rules: QtyRules): number {
  const steps = Math.floor(value / rules.step + 1e-9);
  return roundQty(steps * rules.step, rules.decimals);
}

const sideSign = (p: Position) => p.direction === 'long' ? 1 : -1;

/** Simulated closing fill: reference (mark) price moved against the position by the slippage assumption. */
export function assumedFillPrice(p: Position): number {
  const raw = p.markPrice * (1 - sideSign(p) * CLOSE_SLIPPAGE_PCT / 100);
  return Number(raw.toFixed(p.priceDecimals));
}

/** Long: (exit − entry) × qty. Short: (entry − exit) × qty. */
export function grossFor(p: Position, qty: number, exitPrice: number): number {
  return round2(sideSign(p) * (exitPrice - p.entryPrice) * qty);
}

export interface CloseEstimate {
  qty: number;
  reference: number;
  fill: number;
  gross: number;
  fee: number;
  remaining: number;
  marginReleased: number;
}

export function estimateClose(p: Position, qty: number, feeRatePct: number): CloseEstimate {
  const fill = assumedFillPrice(p);
  const remaining = roundQty(Math.max(0, p.quantity - qty), p.quantityDecimals);
  return {
    qty,
    reference: p.markPrice,
    fill,
    gross: grossFor(p, qty, fill),
    fee: closingFee(fill, qty, feeRatePct),
    remaining,
    marginReleased: round2(positionMargin(p) - positionMargin({ ...p, quantity: remaining }))
  };
}

export interface PartialCheck {
  qty: number;
  remainder: number;
  error: string | null;
  /** True when the request only works as an explicit full close. */
  needsFull: boolean;
}

/** Validates a partial close. Never converts it into a full close. */
export function checkPartialClose(p: Position, mode: 'percent' | 'quantity', raw: number): PartialCheck {
  const rules = qtyRules(p);
  const unit = p.baseAsset;
  if (!Number.isFinite(raw) || raw <= 0) return { qty: 0, remainder: p.quantity, error: mode === 'percent' ? 'Enter a percentage above 0.' : 'Enter a quantity above 0.', needsFull: false };
  if (mode === 'percent' && raw >= 100) return { qty: p.quantity, remainder: 0, error: '100% closes the whole position. Choose Full close explicitly.', needsFull: true };
  const requested = mode === 'percent' ? p.quantity * raw / 100 : raw;
  const qty = floorToRules(requested, rules);
  const remainder = roundQty(p.quantity - qty, rules.decimals);
  const fmt = (v: number) => `${formatNumber(v, rules.decimals)} ${unit}`;
  if (qty <= 0 || qty < rules.min) return { qty, remainder, error: `Rounded closing quantity ${fmt(qty)} is below the simulated minimum ${fmt(rules.min)}.`, needsFull: false };
  if (remainder <= 0) return { qty, remainder: 0, error: 'This closes the whole position. Choose Full close explicitly.', needsFull: true };
  if (remainder < rules.min) {
    return { qty, remainder, error: `The remaining ${fmt(remainder)} would be below the simulated minimum ${fmt(rules.min)}. Choose an explicit full close or close less.`, needsFull: true };
  }
  return { qty, remainder, error: null, needsFull: false };
}

/** Reason a closing or cancel request cannot be submitted for this account, if any. */
export function submissionBlockReason(account: DemoAccount | undefined): string | null {
  if (!account) return 'Account not found';
  if (account.disconnected) return 'Connection disconnected — reconnect before submitting orders';
  const h = connectionHealth(account);
  if (account.scenario === 'exchange-unavailable') return 'Exchange unavailable (simulated) — request not submitted';
  if (h.credentials === 'failed') return 'Demo credentials rejected — request not submitted';
  if (h.tradePermission === 'failed') return 'Trade permission missing — request not submitted';
  if (h.privateFeed === 'failed') return 'Private account feed unavailable — request not submitted';
  if (h.publicFeed === 'failed') return 'Public market feed unavailable — no simulated reference price';
  return null;
}

/** Builds the single lifecycle trade record from every realized entry linked to a position. */
export function buildTradeRecord(position: Position, ledger: ClosedTrade[], exitAt: number, exitReason: string, exchangeId: string): TradeRecord {
  const linked = ledger.filter((l) => l.positionId === position.id);
  const exits = linked.filter((l) => (l.kind === 'partial' || l.kind === 'final') && l.quantity && l.fillPrice !== undefined);
  const exitQty = exits.reduce((a, l) => a + (l.quantity ?? 0), 0);
  const avgExit = exitQty > 0 ? exits.reduce((a, l) => a + (l.fillPrice ?? 0) * (l.quantity ?? 0), 0) / exitQty : 0;
  const sum = (f: (l: ClosedTrade) => number) => round2(linked.reduce((a, l) => a + f(l), 0));
  const gross = sum((l) => l.grossPnl);
  const commissions = sum((l) => l.commission);
  const fundingReceived = sum((l) => l.fundingReceived);
  const fundingPaid = sum((l) => l.fundingPaid);
  return {
    id: `TRD-${position.id.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(-8)}-${exitAt.toString(36).slice(-4).toUpperCase()}`,
    accountId: position.accountId,
    exchangeId,
    positionId: position.id,
    pair: position.pair,
    baseAsset: position.baseAsset,
    direction: position.direction,
    strategyId: position.strategyId,
    strategyVersion: position.strategyVersion ?? null,
    entryTime: position.openedAt,
    exitAt,
    avgEntry: position.entryPrice,
    avgExit: Number(avgExit.toFixed(position.priceDecimals + 2)),
    originalQty: roundQty(exitQty, position.quantityDecimals),
    gross,
    commissions,
    fundingReceived,
    fundingPaid,
    net: round2(gross - commissions + fundingReceived - fundingPaid),
    exitReason,
    priceDecimals: position.priceDecimals,
    quantityDecimals: position.quantityDecimals,
    snapshot: position
  };
}