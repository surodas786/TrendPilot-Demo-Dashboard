import { lastFundingSlot, SIM_FUNDING_RATES } from '../data/financeConfig';
import { round2 } from './accountMath';
import type { Direction, Position } from '../types/trading';

export interface SettlementRequest {
  type: 'applySettlement';
  settlementId: string;
  accountId: string;
  pair: string;
  positionId: string | null;
  snapshot: {quantity: number;price: number;direction: Direction;};
  ratePct: number;
  effectiveAt: number;
}

/** Disclosed convention: positive rate → longs pay, shorts receive; negative → shorts pay, longs receive. */
export function fundingAmount(direction: Direction, notional: number, ratePct: number): number {
  const magnitude = round2(notional * Math.abs(ratePct) / 100);
  const pays = direction === 'long' ? ratePct > 0 : ratePct < 0;
  return pays ? -magnitude : magnitude;
}

/** Settlement for the most recent assumed slot. One ID per account, pair and slot. */
export function settlementFor(p: Position, now: number, ratePct = SIM_FUNDING_RATES[p.pair] ?? 0, slot = lastFundingSlot(now)): SettlementRequest {
  return {
    type: 'applySettlement',
    settlementId: `FS-${p.accountId}-${p.pair}-${new Date(slot).toISOString().slice(0, 13).replace(/[-T]/g, '')}${ratePct === (SIM_FUNDING_RATES[p.pair] ?? 0) ? '' : `-R${Math.round(ratePct * 10000)}`}`,
    accountId: p.accountId,
    pair: p.pair,
    positionId: p.id,
    snapshot: { quantity: p.quantity, price: p.markPrice, direction: p.direction },
    ratePct,
    effectiveAt: slot
  };
}