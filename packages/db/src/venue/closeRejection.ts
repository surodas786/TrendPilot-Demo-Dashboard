/**
 * Classification of a rejected close (exit intent) so the execution flow knows whether the same
 * request can ever succeed by retrying it.
 *
 *  - DETERMINISTIC: the venue refused the request itself (direction, position type, parameters,
 *    precision, client ID, credentials, an unverified capability, or a local mismatch with the
 *    exchange position). Resending the same intent gives the same answer, so automatic exits for
 *    the position are halted until an operator resolves the cause (MEXC 13 Nov 2026: 2001).
 *  - POSITION_GONE: the venue holds nothing (more) to close. The Live sync reconciles the
 *    position from exchange state; nothing is resent.
 *  - TRANSIENT: anything else (rate limit, venue unavailable). Automatic retries are spaced and
 *    capped (see `AUTO_CLOSE_RETRY`).
 *
 * Codes: https://www.mexc.com/api-docs/futures/error-code (read 2026-11-14).
 */
export type CloseRejectionClass = 'DETERMINISTIC' | 'POSITION_GONE' | 'TRANSIENT';

const DETERMINISTIC_MEXC = new Set([
  401, 402, 403, 406, // authentication / permission / IP allowlist
  600, 602, // parameter error
  1001, 1002, 1004, // contract missing / not enabled, amount error
  2001, // order direction error
  2002, 2022, // position type error
  2011, // order quantity error
  2015, // price or quantity precision error
  2027, // cross and isolated position of the same direction
  2029, // order type error
  2030 // external order ID too long
]);
const GONE_MEXC = new Set([2008, 2009]);

export function classifyCloseRejection(reason: string | null | undefined): CloseRejectionClass {
  const r = reason ?? '';
  const m = /^MEXC_(\d+)$/.exec(r);
  if (m) {
    const code = Number(m[1]);
    if (DETERMINISTIC_MEXC.has(code)) return 'DETERMINISTIC';
    if (GONE_MEXC.has(code)) return 'POSITION_GONE';
    return 'TRANSIENT';
  }
  if (r === 'CLIENT_ORDER_ID_TOO_LONG' || r.startsWith('CAPABILITY_UNVERIFIED') || r.startsWith('CLOSE_POSITION_MISMATCH') || r === 'CLOSE_QTY_RESERVED') return 'DETERMINISTIC';
  if (r === 'REDUCE_ONLY_NO_POSITION' || r === 'POSITION_ALREADY_FLAT') return 'POSITION_GONE';
  return 'TRANSIENT';
}

/** Automatic retries of the same exit trigger after a non-deterministic rejection. */
export const AUTO_CLOSE_RETRY = {
  /** Rejected automatic attempts for one trigger before automatic exits are halted. */
  maxAttempts: 3,
  /** Minimum spacing between automatic attempts after a rejection. */
  backoffMs: 30_000
} as const;

/** Investor- and operator-facing text for a halt. */
export function exitHaltText(reason: string): string {
  if (/^MEXC_2001\b/.test(reason))
    return 'MEXC rejected the closing order with error 2001 (order direction). Automatic exits for this position are paused so the same order is not resent. The exchange stop loss is still in place. Close the position on MEXC or contact support; an operator clears the pause once the cause is fixed.';
  if (reason.startsWith('CLOSE_QTY_RESERVED'))
    return 'MEXC reports the whole position as frozen by other orders, so no closing order was sent. Automatic exits for this position are paused; the exchange stop loss is still in place. Cancel the other open orders for this contract on MEXC or contact support.';
  if (reason.startsWith('EXIT_RETRY_LIMIT')) return `The closing order was rejected ${AUTO_CLOSE_RETRY.maxAttempts} times. Automatic exits for this position are paused; the exchange stop loss is still in place. Close the position on MEXC or contact support.`;
  return `The exchange rejected the closing order (${reason}). Automatic exits for this position are paused so it is not resent; the exchange stop loss is still in place. Close the position on MEXC or contact support.`;
}
