import { and, eq, sql } from 'drizzle-orm';
import { DomainError, ErrorCode, keyFingerprint, validateAccountRef } from '@trendpilot/domain';
import type { Db } from '../client';
import { recordAudit } from '../repos/audit';
import { exchangeConnections, exchangePositions, users } from '../schema';
import { open as unseal, seal } from '../security/secretBox';
import { BITUNIX_PRIVATE_DEFAULT_BASE_URL, bitunixReadOnlyCheck, BitunixPrivateError, BitunixReadOnlyTransport, type BitunixCredentials, type BitunixRequester } from './bitunixPrivate';
import { connectionFor, type ConnectionRow } from './liveMode';

/**
 * Bitunix exchange connection (Step 1: read-only). An investor's Bitunix key lives in its own
 * `exchange_connections` row (exchange = 'BITUNIX'), next to and independent of their MEXC row:
 * saving, verifying or removing one never touches the other, and every query is scoped by
 * (owner, exchange).
 *
 * Verification is read-only: the futures position mode and the USDT futures account, through a
 * transport that can only send allowlisted GETs. The result is stored on the connection only. It
 * is NOT applied to the investor's Live account (that account and its ledger belong to the MEXC
 * order path), and a Bitunix connection cannot be approved or activated for Live in this step.
 * The position mode is reported as Bitunix states it; changing it is an explicit account action
 * outside this step.
 */

export interface BitunixTestSeam {
  requesterFor: (conn: ConnectionRow) => BitunixRequester;
}
let seam: BitunixTestSeam | null = null;
/** Tests only: replace the Bitunix HTTP transport. Refused in production. */
export function installBitunixTestSeam(s: BitunixTestSeam | null, env: Record<string, string | undefined> = process.env): void {
  if (s && env.NODE_ENV === 'production') throw new Error('The Bitunix test seam is not allowed in production.');
  seam = s;
}

/** The connection's own key, unsealed server-side. Never logged, never returned by an API. */
export function bitunixCredentialsOf(c: ConnectionRow): BitunixCredentials {
  if (c.exchange !== 'BITUNIX' || !c.apiKeySealed || !c.secretSealed) throw new Error('not an active Bitunix connection');
  return { apiKey: unseal(c.apiKeySealed), secretKey: unseal(c.secretSealed) };
}

/** Read-only REST access with THIS connection's key (the test seam replaces it outside production). */
export function bitunixRequesterFor(c: ConnectionRow, env: Record<string, string | undefined> = process.env): BitunixRequester {
  if (seam) return seam.requesterFor(c);
  return new BitunixReadOnlyTransport({ credentials: bitunixCredentialsOf(c), baseUrl: env.BITUNIX_PRIVATE_BASE_URL || BITUNIX_PRIVATE_DEFAULT_BASE_URL });
}
const requesterFor = bitunixRequesterFor;

const describeError = (e: unknown): string =>
  e instanceof BitunixPrivateError ? `${e.kind}${e.code !== undefined ? ` ${e.code}` : ''}: ${e.message}`.slice(0, 300) : 'Verification failed.';

/** Read-only verification of the investor's Bitunix connection. */
export async function verifyBitunixConnection(db: Db, ownerId: string, correlationId = 'live', env: Record<string, string | undefined> = process.env): Promise<ConnectionRow> {
  const conn = await connectionFor(db, ownerId, 'BITUNIX');
  if (!conn || conn.status === 'REVOKED') throw new DomainError(404, ErrorCode.NOT_FOUND, 'No Bitunix connection is set up.');
  const checkedAt = new Date();
  let verification: Record<string, unknown>;
  let status: 'VERIFIED' | 'FAILED';
  let positionMode: 'ONE_WAY' | 'HEDGE' | null = null;
  try {
    const r = await bitunixReadOnlyCheck(requesterFor(conn, env), () => checkedAt);
    positionMode = r.positionMode;
    verification = {
      ...r,
      exchange: 'BITUNIX',
      positionModeAction: 'TrendPilot does not change the position mode; change it in Bitunix if needed, then check again.',
      orderPermission: 'Not checked: this step is read-only. Order placement is verified in a later step.',
      liveTrading: 'Bitunix Live trading is not available yet; this connection is read-only.'
    };
    status = 'VERIFIED';
  } catch (e) {
    verification = { checkedAt: checkedAt.toISOString(), exchange: 'BITUNIX', error: describeError(e) };
    status = 'FAILED';
  }
  const [u] = await db
    .update(exchangeConnections)
    .set({ status, verification, positionMode, verifiedAt: status === 'VERIFIED' ? checkedAt : null, liveEnabled: false, revision: sql`${exchangeConnections.revision} + 1`, updatedAt: sql`now()` })
    .where(eq(exchangeConnections.id, conn.id))
    .returning();
  await recordAudit(db, { actorUserId: ownerId, action: 'LIVE_CONNECTION_VERIFY', targetType: 'exchange_connection', targetId: conn.id, result: status === 'VERIFIED' ? 'SUCCESS' : 'FAILED', metadata: { exchange: 'BITUNIX', status, positionMode }, correlationId });
  return u!;
}

/** Saves (or replaces) the investor's Bitunix API key, sealed, and verifies it read-only. */
export async function saveBitunixConnection(
  db: Db,
  ownerId: string,
  input: { accountRef: string; apiKey: string; secretKey: string },
  correlationId = 'live',
  env: Record<string, string | undefined> = process.env
): Promise<ConnectionRow> {
  const refIssue = validateAccountRef(input.accountRef ?? '');
  const apiKey = (input.apiKey ?? '').trim();
  const secretKey = (input.secretKey ?? '').trim();
  const issues = [refIssue, apiKey.length < 8 ? 'Enter the Bitunix API key.' : null, secretKey.length < 8 ? 'Enter the Bitunix secret key.' : null].filter((x): x is string => !!x);
  if (issues.length) throw new DomainError(400, ErrorCode.VALIDATION_FAILED, issues.join(' '));
  const [u] = await db.select({ role: users.role, status: users.status }).from(users).where(eq(users.id, ownerId));
  if (!u || u.role !== 'INVESTOR' || u.status !== 'ACTIVE') throw new DomainError(403, ErrorCode.FORBIDDEN, 'Only an active investor can connect an exchange account.');
  // A replaced key may belong to another Bitunix account: positions mirrored under the old key are
  // DETACHED (no longer read; never reported as closed) and the account state starts over.
  const [prior] = await db.select({ id: exchangeConnections.id }).from(exchangeConnections).where(and(eq(exchangeConnections.ownerId, ownerId), eq(exchangeConnections.exchange, 'BITUNIX')));
  if (prior) {
    const detached = await db
      .update(exchangePositions)
      .set({ status: 'DETACHED', closeCheck: 'NONE', closeCheckSince: null, closeCheckReason: 'API key replaced', updatedAt: sql`now()`, revision: sql`${exchangePositions.revision} + 1` })
      .where(and(eq(exchangePositions.connectionId, prior.id), eq(exchangePositions.status, 'OPEN')))
      .returning({ id: exchangePositions.id });
    if (detached.length) await recordAudit(db, { actorUserId: ownerId, action: 'LIVE_CONNECTION_POSITIONS_DETACHED', targetType: 'exchange_connection', targetId: prior.id, result: 'SUCCESS', metadata: { exchange: 'BITUNIX', positions: detached.length }, correlationId });
  }
  const values = {
    accountRef: input.accountRef.trim(),
    apiKeySealed: seal(apiKey),
    secretSealed: seal(secretKey),
    keyFingerprint: keyFingerprint(apiKey),
    status: 'PENDING',
    verification: {},
    verifiedAt: null,
    positionMode: null,
    approvedAt: null,
    approvedBy: null,
    maxOrderContracts: null,
    maxOrderNotionalUsdt: null,
    maxLeverage: null,
    maxExposureUsdt: null,
    liveEnabled: false,
    activatedAt: null,
    drift: [],
    accountState: {},
    streamState: {},
    lastSyncAt: null,
    lastSyncOkAt: null,
    lastSyncError: null
  };
  const [row] = await db
    .insert(exchangeConnections)
    .values({ ownerId, exchange: 'BITUNIX', ...values })
    .onConflictDoUpdate({ target: [exchangeConnections.ownerId, exchangeConnections.exchange], set: { ...values, revision: sql`${exchangeConnections.revision} + 1`, updatedAt: sql`now()` } })
    .returning();
  await recordAudit(db, { actorUserId: ownerId, action: 'LIVE_CONNECTION_SAVE', targetType: 'exchange_connection', targetId: row!.id, result: 'SUCCESS', metadata: { exchange: 'BITUNIX', accountRef: values.accountRef, keyFingerprint: values.keyFingerprint }, correlationId });
  return verifyBitunixConnection(db, ownerId, correlationId, env);
}
