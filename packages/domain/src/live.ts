import { Decimal } from './decimal';

/**
 * Live mode rules (OPS-01/02, EXE-02). Pure; no I/O.
 *
 * Paper and Live run the same strategy rules on the same public market feed. Live adds these
 * gates, checked for every OPENING order (new entry, and the opening leg of a reversal) both when
 * the entry is evaluated and again in the worker right before the order is sent:
 *  1. the deployment's live order transport is enabled (LIVE_ORDER_TRANSPORT=enabled);
 *  2. the platform Live switch is on and platform entries are not halted (admin, audited);
 *  3. the investor owns a VERIFIED MEXC connection in One-way position mode that an
 *     administrator approved, with limits (Hedge mode is not supported for new entries: MEXC
 *     documents reduce-only closes for One-way mode only);
 *  4. the investor activated Live (default Off) and their Live entries are not halted;
 *  5. the contract is on the Live allowlist;
 *  6. the order carries its stop, and stays within the per-order contracts, per-order notional,
 *     leverage and total exposure limits.
 * Protective and closing actions (stop resize, take profit, trailing take profit, close on signal,
 * manual and emergency closes) are never gated by these rules.
 */

export interface LiveLimits {
  maxOrderContracts: string;
  maxOrderNotionalUsdt: string;
  maxLeverage: number;
  maxExposureUsdt: string;
}

export interface LiveControlState {
  transportEnabled: boolean;
  platformEnabled: boolean;
  platformEntriesHalted: boolean;
  platformHaltReason?: string | null;
}

export interface LiveConnectionState {
  ownerId: string;
  status: 'PENDING' | 'VERIFIED' | 'FAILED' | 'REVOKED' | string;
  /** MEXC position mode read at the last check: 'ONE_WAY' is required for new entries. */
  positionMode: 'ONE_WAY' | 'HEDGE' | string | null;
  approved: boolean;
  liveEnabled: boolean;
  entriesHalted: boolean;
  haltReason?: string | null;
  limits: LiveLimits | null;
}

export interface LiveEntryRequest {
  ownerId: string;
  contractLiveAllowed: boolean;
  contracts: string;
  price: string;
  multiplier: string;
  leverage: number;
  hasStop: boolean;
  /** Contracts already open on this contract at the venue (or on the platform, before sending). */
  openContracts: string;
}

export type LiveRefusal =
  | 'LIVE_TRANSPORT_DISABLED'
  | 'LIVE_PLATFORM_DISABLED'
  | 'LIVE_PLATFORM_HALTED'
  | 'LIVE_CONNECTION_MISSING'
  | 'LIVE_OWNERSHIP_MISMATCH'
  | 'LIVE_CONNECTION_NOT_VERIFIED'
  | 'LIVE_POSITION_MODE'
  | 'LIVE_ACCOUNT_NOT_APPROVED'
  | 'LIVE_NOT_ACTIVATED'
  | 'LIVE_ACCOUNT_HALTED'
  | 'LIVE_CONTRACT_NOT_ALLOWED'
  | 'LIVE_STOP_REQUIRED'
  | 'LIVE_ORDER_SIZE'
  | 'LIVE_ORDER_NOTIONAL'
  | 'LIVE_LEVERAGE'
  | 'LIVE_EXPOSURE';

export const LIVE_REFUSAL_TEXT: Record<LiveRefusal, string> = {
  LIVE_TRANSPORT_DISABLED: 'Live order submission is turned off for this deployment.',
  LIVE_PLATFORM_DISABLED: 'Live trading is not switched on by the platform.',
  LIVE_PLATFORM_HALTED: 'New Live entries are halted by the operator. Protection and closing remain available.',
  LIVE_CONNECTION_MISSING: 'No MEXC exchange connection is set up for this account.',
  LIVE_OWNERSHIP_MISMATCH: 'The exchange connection does not belong to this investor.',
  LIVE_CONNECTION_NOT_VERIFIED: 'The MEXC exchange connection has not been verified.',
  LIVE_POSITION_MODE:
    'One-way position mode required: the MEXC account is not in One-way mode (Hedge mode is not supported for Live entries). Switch the MEXC Futures account to One-way, then press Save and check on the Live Trading page. Closing and protection are not affected.',
  LIVE_ACCOUNT_NOT_APPROVED: 'The MEXC account has not been approved for Live trading by an administrator.',
  LIVE_NOT_ACTIVATED: 'Live trading is not activated on this account.',
  LIVE_ACCOUNT_HALTED: 'New Live entries are halted on this account. Protection and closing remain available.',
  LIVE_CONTRACT_NOT_ALLOWED: 'This contract is not on the Live allowlist.',
  LIVE_STOP_REQUIRED: 'An opening order must carry its stop loss.',
  LIVE_ORDER_SIZE: 'The order exceeds the approved maximum contracts per order.',
  LIVE_ORDER_NOTIONAL: 'The order exceeds the approved maximum notional per order.',
  LIVE_LEVERAGE: 'The leverage exceeds the approved maximum.',
  LIVE_EXPOSURE: 'The order would exceed the approved maximum total exposure.'
};

export type LiveVerdict = { ok: true } | { ok: false; reason: LiveRefusal; detail?: Record<string, string | number> };

export type LiveBlocker = { reason: LiveRefusal; detail?: Record<string, string | number> };

/**
 * Every account-level gate (1–5) that currently blocks new Live entries, in gate order. Lets the
 * UI and decision records show, for example, both an operator halt and the position mode, rather
 * than only the first.
 */
export function liveAccountBlockers(control: LiveControlState, conn: LiveConnectionState | null, ownerId: string, contractLiveAllowed: boolean): LiveBlocker[] {
  const out: LiveBlocker[] = [];
  if (!control.transportEnabled) out.push({ reason: 'LIVE_TRANSPORT_DISABLED' });
  if (!control.platformEnabled) out.push({ reason: 'LIVE_PLATFORM_DISABLED' });
  if (control.platformEntriesHalted) out.push({ reason: 'LIVE_PLATFORM_HALTED', detail: { haltReason: control.platformHaltReason ?? 'operator' } });
  if (!conn) out.push({ reason: 'LIVE_CONNECTION_MISSING' });
  else if (conn.ownerId !== ownerId) out.push({ reason: 'LIVE_OWNERSHIP_MISMATCH' });
  else {
    if (conn.status !== 'VERIFIED') out.push({ reason: 'LIVE_CONNECTION_NOT_VERIFIED' });
    else if (conn.positionMode !== 'ONE_WAY') out.push({ reason: 'LIVE_POSITION_MODE', detail: { positionMode: conn.positionMode ?? 'unknown' } });
    if (!conn.approved || !conn.limits) out.push({ reason: 'LIVE_ACCOUNT_NOT_APPROVED' });
    if (!conn.liveEnabled) out.push({ reason: 'LIVE_NOT_ACTIVATED' });
    if (conn.entriesHalted) out.push({ reason: 'LIVE_ACCOUNT_HALTED', detail: { haltReason: conn.haltReason ?? 'halted' } });
  }
  if (!contractLiveAllowed) out.push({ reason: 'LIVE_CONTRACT_NOT_ALLOWED' });
  return out;
}

/** Account-level gates only (1–5): whether this investor may open Live exposure at all (first blocker). */
export function liveAccountGate(control: LiveControlState, conn: LiveConnectionState | null, ownerId: string, contractLiveAllowed: boolean): LiveVerdict {
  const [first] = liveAccountBlockers(control, conn, ownerId, contractLiveAllowed);
  return first ? { ok: false, ...first } : { ok: true };
}

/** Every Live opening order passes here, at evaluation and again right before submission. */
export function checkLiveEntry(control: LiveControlState, conn: LiveConnectionState | null, r: LiveEntryRequest): LiveVerdict {
  const gate = liveAccountGate(control, conn, r.ownerId, r.contractLiveAllowed);
  if (!gate.ok) return gate;
  const l = conn!.limits!;
  if (!r.hasStop) return { ok: false, reason: 'LIVE_STOP_REQUIRED' };
  if (new Decimal(r.contracts).gt(l.maxOrderContracts)) return { ok: false, reason: 'LIVE_ORDER_SIZE', detail: { contracts: r.contracts, max: l.maxOrderContracts } };
  const notional = new Decimal(r.contracts).times(r.multiplier).times(r.price);
  if (notional.gt(l.maxOrderNotionalUsdt)) return { ok: false, reason: 'LIVE_ORDER_NOTIONAL', detail: { notional: notional.toFixed(2), max: l.maxOrderNotionalUsdt } };
  if (r.leverage > l.maxLeverage) return { ok: false, reason: 'LIVE_LEVERAGE', detail: { leverage: r.leverage, max: l.maxLeverage } };
  const exposure = new Decimal(r.openContracts).plus(r.contracts).times(r.multiplier).times(r.price);
  if (exposure.gt(l.maxExposureUsdt)) return { ok: false, reason: 'LIVE_EXPOSURE', detail: { exposure: exposure.toFixed(2), max: l.maxExposureUsdt } };
  return { ok: true };
}

export const LIVE_MAX_LEVERAGE = 125;

export function validateLiveLimits(l: LiveLimits): string[] {
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
  if (!Number.isInteger(l.maxLeverage) || l.maxLeverage < 1 || l.maxLeverage > LIVE_MAX_LEVERAGE) issues.push(`maxLeverage must be a whole number from 1 to ${LIVE_MAX_LEVERAGE}`);
  if (!issues.length && new Decimal(l.maxExposureUsdt).lt(l.maxOrderNotionalUsdt)) issues.push('maxExposureUsdt must be at least maxOrderNotionalUsdt');
  return issues;
}

/** A non-secret reference for the exchange account (e.g. a UID suffix). Never a key. */
export function validateAccountRef(ref: string): string | null {
  const t = ref.trim();
  if (!t) return 'Enter a reference for the MEXC account (for example the last digits of the UID).';
  if (t.length > 60) return 'Keep the account reference under 60 characters.';
  if (/key|secret|mx0/i.test(t) || /^[A-Za-z0-9]{24,}$/.test(t)) return 'The account reference must not be an API key or secret.';
  return null;
}

/** Shows only the last 4 characters of an API key. */
export const keyFingerprint = (apiKey: string) => (apiKey.length > 4 ? `…${apiKey.slice(-4)}` : '…');
