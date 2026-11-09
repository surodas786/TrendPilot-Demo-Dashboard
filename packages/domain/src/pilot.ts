import { Decimal } from './decimal';

/**
 * Step 12 live pilot scope (OPS-02). Pure rules; no I/O.
 *
 * A pilot allowlists exactly one investor, one verified MEXC Futures account and one contract,
 * with operator-approved limits. It needs BOTH platform authorization (an administrator approves
 * it) AND explicit investor activation. Adds and automatic reversals are disabled for the first
 * pilot. New entries can be halted at any time; protection and closing stay available always.
 */

export type PilotStatus = 'DRAFT' | 'APPROVED' | 'ACTIVE' | 'ENDED';

export interface PilotLimits {
  /** Maximum contracts per opening order. */
  maxOrderContracts: string;
  /** Maximum notional per opening order, USDT. */
  maxOrderNotionalUsdt: string;
  maxLeverage: number;
  /** Maximum total open notional on the pilot contract, USDT. */
  maxExposureUsdt: string;
}

export interface PilotScope {
  status: PilotStatus;
  investorId: string;
  instrumentId: string;
  exchangeAccountRef: string;
  limits: PilotLimits;
  allowAdds: false;
  allowReversal: false;
  approvedAt: Date | null;
  investorActivatedAt: Date | null;
  entriesHalted: boolean;
  haltReason: string | null;
}

export type PilotEntryRefusal =
  | 'PILOT_NOT_ACTIVE'
  | 'PILOT_NOT_APPROVED'
  | 'PILOT_INVESTOR_NOT_ACTIVATED'
  | 'PILOT_ENTRIES_HALTED'
  | 'PILOT_INVESTOR_NOT_ALLOWLISTED'
  | 'PILOT_CONTRACT_NOT_ALLOWLISTED'
  | 'PILOT_ORDER_SIZE'
  | 'PILOT_ORDER_NOTIONAL'
  | 'PILOT_LEVERAGE'
  | 'PILOT_EXPOSURE'
  | 'PILOT_ADDS_DISABLED'
  | 'PILOT_STOP_REQUIRED';

export const PILOT_REFUSAL_TEXT: Record<PilotEntryRefusal, string> = {
  PILOT_NOT_ACTIVE: 'The live pilot is not active.',
  PILOT_NOT_APPROVED: 'The live pilot has not been approved by the platform.',
  PILOT_INVESTOR_NOT_ACTIVATED: 'The investor has not activated the live pilot.',
  PILOT_ENTRIES_HALTED: 'New live entries are halted. Protection and closing remain available.',
  PILOT_INVESTOR_NOT_ALLOWLISTED: 'This investor is not on the live pilot allowlist.',
  PILOT_CONTRACT_NOT_ALLOWLISTED: 'This contract is not approved for the live pilot.',
  PILOT_ORDER_SIZE: 'The order exceeds the approved maximum contracts.',
  PILOT_ORDER_NOTIONAL: 'The order exceeds the approved maximum notional.',
  PILOT_LEVERAGE: 'The leverage exceeds the approved maximum.',
  PILOT_EXPOSURE: 'The order would exceed the approved total exposure.',
  PILOT_ADDS_DISABLED: 'Adding to an open position is disabled for the pilot.',
  PILOT_STOP_REQUIRED: 'An opening order must carry its stop loss.'
};

export interface PilotEntryRequest {
  investorId: string;
  instrumentId: string;
  contracts: string;
  price: string;
  multiplier: string;
  leverage: number;
  hasStop: boolean;
  /** Contracts already open at the venue on this contract (any side). */
  openContracts: string;
}

/** Every opening order passes here. Closes never do: protection and exits are never gated. */
export function checkPilotEntry(p: PilotScope | null, r: PilotEntryRequest): { ok: true } | { ok: false; reason: PilotEntryRefusal; detail?: Record<string, string | number> } {
  if (!p || p.status === 'ENDED' || p.status === 'DRAFT') return { ok: false, reason: p?.status === 'DRAFT' ? 'PILOT_NOT_APPROVED' : 'PILOT_NOT_ACTIVE' };
  if (!p.approvedAt) return { ok: false, reason: 'PILOT_NOT_APPROVED' };
  if (!p.investorActivatedAt || p.status !== 'ACTIVE') return { ok: false, reason: 'PILOT_INVESTOR_NOT_ACTIVATED' };
  if (p.entriesHalted) return { ok: false, reason: 'PILOT_ENTRIES_HALTED', detail: { haltReason: p.haltReason ?? 'operator' } };
  if (r.investorId !== p.investorId) return { ok: false, reason: 'PILOT_INVESTOR_NOT_ALLOWLISTED' };
  if (r.instrumentId !== p.instrumentId) return { ok: false, reason: 'PILOT_CONTRACT_NOT_ALLOWLISTED' };
  if (!r.hasStop) return { ok: false, reason: 'PILOT_STOP_REQUIRED' };
  if (new Decimal(r.openContracts).gt(0)) return { ok: false, reason: 'PILOT_ADDS_DISABLED', detail: { openContracts: r.openContracts } };
  if (new Decimal(r.contracts).gt(p.limits.maxOrderContracts)) return { ok: false, reason: 'PILOT_ORDER_SIZE', detail: { contracts: r.contracts, max: p.limits.maxOrderContracts } };
  const notional = new Decimal(r.contracts).times(r.multiplier).times(r.price);
  if (notional.gt(p.limits.maxOrderNotionalUsdt)) return { ok: false, reason: 'PILOT_ORDER_NOTIONAL', detail: { notional: notional.toFixed(2), max: p.limits.maxOrderNotionalUsdt } };
  if (r.leverage > p.limits.maxLeverage) return { ok: false, reason: 'PILOT_LEVERAGE', detail: { leverage: r.leverage, max: p.limits.maxLeverage } };
  const exposure = new Decimal(r.openContracts).plus(r.contracts).times(r.multiplier).times(r.price);
  if (exposure.gt(p.limits.maxExposureUsdt)) return { ok: false, reason: 'PILOT_EXPOSURE', detail: { exposure: exposure.toFixed(2), max: p.limits.maxExposureUsdt } };
  return { ok: true };
}

export function validatePilotLimits(l: PilotLimits): string[] {
  const issues: string[] = [];
  const pos = (v: string, n: string) => {
    let d: Decimal;
    try {
      d = new Decimal(v);
    } catch {
      issues.push(`${n} must be a number`);
      return;
    }
    if (!d.isFinite() || d.lte(0)) issues.push(`${n} must be positive`);
  };
  pos(l.maxOrderContracts, 'maxOrderContracts');
  pos(l.maxOrderNotionalUsdt, 'maxOrderNotionalUsdt');
  pos(l.maxExposureUsdt, 'maxExposureUsdt');
  if (!Number.isInteger(l.maxLeverage) || l.maxLeverage < 1 || l.maxLeverage > 20) issues.push('maxLeverage must be an integer from 1 to 20 for the pilot');
  if (!issues.length && new Decimal(l.maxExposureUsdt).lt(l.maxOrderNotionalUsdt)) issues.push('maxExposureUsdt must be at least maxOrderNotionalUsdt');
  return issues;
}

/** Block settings the pilot refuses at activation: adds and automatic reversal must be off. */
export function pilotBlockIssues(block: { allowAdds: boolean; leverage: number; instrumentId: string }, version: { oppositePolicy: string }, p: Pick<PilotScope, 'limits' | 'instrumentId'>): string[] {
  const out: string[] = [];
  if (block.allowAdds) out.push('Adds are enabled on the order block; the pilot requires them off.');
  if (version.oppositePolicy === 'CLOSE_AND_REVERSE') out.push('The strategy version reverses automatically (CLOSE_AND_REVERSE); the pilot requires KEEP_OPEN or CLOSE_ONLY.');
  if (block.leverage > p.limits.maxLeverage) out.push(`Block leverage ${block.leverage}x exceeds the approved ${p.limits.maxLeverage}x.`);
  if (block.instrumentId !== p.instrumentId) out.push('The order block is not on the approved contract.');
  return out;
}
