/** Stable error codes returned in `{code, message, correlationId}` bodies (SRS §10.1). */
export const ErrorCode = {
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  INVALID_CREDENTIALS: 'INVALID_CREDENTIALS',
  RATE_LIMITED: 'RATE_LIMITED',
  EXCHANGE_UNAVAILABLE: 'EXCHANGE_UNAVAILABLE',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  DUPLICATE_BLOCK: 'DUPLICATE_BLOCK',
  REVISION_CONFLICT: 'REVISION_CONFLICT',
  REVISION_REQUIRED: 'REVISION_REQUIRED',
  LIVE_DISABLED: 'LIVE_DISABLED',
  RESUME_BLOCKED: 'RESUME_BLOCKED',
  PAYLOAD_TOO_LARGE: 'PAYLOAD_TOO_LARGE',
  MFA_REQUIRED: 'MFA_REQUIRED',
  INVALID_MFA_CODE: 'INVALID_MFA_CODE',
  LINK_INVALID: 'LINK_INVALID',
  DUPLICATE: 'DUPLICATE',
  CONFLICT: 'CONFLICT',
  IMMUTABLE: 'IMMUTABLE',
  IDEMPOTENCY_KEY_REQUIRED: 'IDEMPOTENCY_KEY_REQUIRED',
  IDEMPOTENCY_KEY_REUSED: 'IDEMPOTENCY_KEY_REUSED',
  POSITION_NOT_OPEN: 'POSITION_NOT_OPEN',
  EXIT_IN_PROGRESS: 'EXIT_IN_PROGRESS',
  INTERNAL: 'INTERNAL'
} as const;
export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

export interface Issue {
  /** Dotted field path, e.g. "takeProfit.levels.1.movePct". Empty for form-level issues. */
  path: string;
  message: string;
}

export class DomainError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string,
    readonly issues?: Issue[]
  ) {
    super(message);
    this.name = 'DomainError';
  }
}

/** One response for unknown and unowned IDs so ownership is never disclosed (§10.1). */
export const notFound = () => new DomainError(404, ErrorCode.NOT_FOUND, 'Not found.');
