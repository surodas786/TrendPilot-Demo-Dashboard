import { randomUUID } from 'node:crypto';

/**
 * MEXC Futures rejects an `externalOid` longer than 32 characters with error 2030 (seen in
 * production on 13 Nov 2026 with the 39-character `tp-<uuid>`).
 */
export const MEXC_EXTERNAL_OID_MAX = 32;

/**
 * Client order ID for a new order intent (entry or exit, Paper or Live): a random UUID without
 * hyphens and without a prefix, exactly 32 lowercase hex characters, so it is a valid MEXC
 * `externalOid`. It is generated once, stored on the intent, and reused for submission, lookup
 * and every retry; it is never derived again.
 *
 * Intents created earlier keep their stored IDs (`tp-<decisionId>` for entries, `tpx-<uuid>` for
 * exits), so existing orders stay traceable.
 */
export const newClientOrderId = (): string => randomUUID().replace(/-/g, '');
