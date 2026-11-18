import { and, eq, inArray, ne, sql } from 'drizzle-orm';
import { DomainError, ErrorCode, LIGHTER_ENVIRONMENTS, lighterAccountRef, missingLiveInputs, validateLighterConnection, type LighterConnectionInput, type LighterEnvironment, type LighterLiveInputs } from '@trendpilot/domain';
import type { Db, Executor } from '../client';
import { recordAudit } from '../repos/audit';
import { exchangeConnections, lighterTxs, orderIntents, paperAccounts, positions, users } from '../schema';
import { open as unseal, seal } from '../security/secretBox';
import { LIGHTER_CAPABILITIES, livePilotVerified, type CapabilityState } from './capabilities';
import { LighterHttpApi, LighterPrivateError, LighterSignerUnavailable, lighterTestnetEnabled, type LighterApi, type LighterSigner } from './lighterPrivate';
import { LighterSignerError, scrubLighterSignerAccount, wasmLighterSigner } from './lighterWasmSigner';
import type { LighterScope } from './lighterOrders';
import { lighterLiveRefusal, lighterLiveScope } from './lighterLiveScope';
import { connectionFor, type ConnectionRow } from './liveMode';

/**
 * The investor's Lighter connection (Lighter plan Step 4). One `exchange_connections` row with
 * exchange = 'LIGHTER', next to (and independent of) MEXC and Bitunix: a Lighter-only investor
 * needs no other exchange. What is stored:
 *  - environment, account index and API key index (not secret, queryable);
 *  - the API PRIVATE key, sealed (`apiKeySealed`); `secretSealed` holds a sealed marker. Never a
 *    wallet key or seed phrase; no deposits, withdrawals or transfers exist in TrendPilot.
 *
 * Verification (no order is sent): the account exists, the API key index is registered on it, and
 * the saved key is THAT key (its public key equals Lighter's registered public key). The last part
 * needs the signer; without it the connection stays PENDING ("key not proven"). Only a VERIFIED
 * connection claims its Lighter account (one investor per account) and can be synced.
 *
 * Permission to trade is reported separately and is OFF in this build: Lighter Live entries need
 * every Lighter capability verified on a live pilot, the live inputs configured, administrator
 * approval and the investor's activation — none of which can happen in this step.
 */

const SECRET_MARKER = 'lighter:no-secret';

export interface LighterCredentials {
  environment: LighterEnvironment;
  accountIndex: number;
  apiKeyIndex: number;
  /** Hex, no 0x. Server-side only: never logged, never returned. */
  apiPrivateKey: string;
}

export interface LighterTestSeam {
  apiFor: (conn: ConnectionRow) => LighterApi;
  signerFor?: (conn: ConnectionRow) => LighterSigner;
}
let seam: LighterTestSeam | null = null;
/** Tests only: replace the Lighter HTTP API and signer. Refused in production. */
export function installLighterTestSeam(s: LighterTestSeam | null, env: Record<string, string | undefined> = process.env): void {
  if (s && env.NODE_ENV === 'production') throw new Error('The Lighter test seam is not allowed in production.');
  seam = s;
}

/** True while tests have replaced the Lighter API and signer. */
export const lighterSeamActive = () => seam !== null;

export function lighterCredentialsOf(c: ConnectionRow): LighterCredentials {
  if (c.exchange !== 'LIGHTER' || !c.apiKeySealed || c.venueAccountIndex === null || c.venueApiKeyIndex === null || !c.venueEnvironment) throw new Error('not an active Lighter connection');
  return { environment: c.venueEnvironment as LighterEnvironment, accountIndex: c.venueAccountIndex, apiKeyIndex: c.venueApiKeyIndex, apiPrivateKey: unseal(c.apiKeySealed) };
}

export const lighterScopeOf = (c: ConnectionRow): LighterScope => ({
  connectionId: c.id,
  ownerId: c.ownerId,
  environment: c.venueEnvironment as LighterEnvironment,
  accountIndex: c.venueAccountIndex!,
  apiKeyIndex: c.venueApiKeyIndex!
});

/** Lighter REST for this connection's environment (the seam replaces it outside production). */
export function lighterApiFor(c: ConnectionRow, env: Record<string, string | undefined> = process.env): LighterApi {
  if (seam) return seam.apiFor(c);
  const environment = (c.venueEnvironment ?? 'MAINNET') as LighterEnvironment;
  // Separate endpoints per environment: the mainnet override never applies to testnet and vice versa.
  const override = environment === 'TESTNET' ? env.LIGHTER_TESTNET_BASE_URL : env.LIGHTER_PRIVATE_BASE_URL;
  return new LighterHttpApi({ environment, baseUrl: override || LIGHTER_ENVIRONMENTS[environment].baseUrl, env });
}

/**
 * The signer for this connection: the pinned lighter-go WASM signer, server-side, bound to this
 * connection's own key (tests may install a mock through the seam). Signing never sends anything:
 * order submission stays behind the transport gates.
 */
export function lighterSignerFor(c: ConnectionRow): LighterSigner {
  if (seam?.signerFor) return seam.signerFor(c);
  const k = lighterCredentialsOf(c);
  return wasmLighterSigner({ accountIndex: k.accountIndex, apiKeyIndex: k.apiKeyIndex, chainId: LIGHTER_ENVIRONMENTS[k.environment].chainId, apiPrivateKey: k.apiPrivateKey });
}

/** Live inputs the operator must configure (never defaulted). Unset → Lighter entries / closes refuse. */
export function lighterLiveInputs(env: Record<string, string | undefined> = process.env): LighterLiveInputs {
  const v = (k: string) => (env[k] && /^\d+(\.\d+)?$/.test(env[k]!) ? env[k]! : null);
  return {
    entryWorstPricePct: v('LIGHTER_ENTRY_WORST_PRICE_PCT'),
    stopWorstPricePct: v('LIGHTER_STOP_WORST_PRICE_PCT'),
    closeWorstPricePct: v('LIGHTER_CLOSE_WORST_PRICE_PCT'),
    takerFeeRate: v('LIGHTER_TAKER_FEE_RATE')
  };
}

/**
 * Whether this investor may trade Lighter Live now (shown next to, not inside, the connection
 * check): the Lighter Live scope at account level (lighterLiveScope.ts). Off by default.
 */
export function lighterTradePermission(conn: ConnectionRow | null, capabilities: CapabilityState = {}, env: Record<string, string | undefined> = process.env): { allowed: boolean; reasons: string[] } {
  const target = { connection: conn && conn.status !== 'REVOKED' ? { id: conn.id, status: conn.status, venueEnvironment: conn.venueEnvironment } : null };
  const refusal = lighterLiveRefusal(lighterLiveScope(env), capabilities, lighterLiveInputs(env), target, 'ACCOUNT');
  if (!refusal) return { allowed: true, reasons: [] };
  const reasons = [refusal];
  const unverified = LIGHTER_CAPABILITIES.filter((c) => !livePilotVerified(c.id, capabilities)).map((c) => c.id);
  if (unverified.length) reasons.push(`Lighter capabilities not yet recorded as verified: ${unverified.join(', ')}.`);
  const inputs = [...new Set([...missingLiveInputs(lighterLiveInputs(env), 'OPEN'), ...missingLiveInputs(lighterLiveInputs(env), 'CLOSE')])];
  if (inputs.length) reasons.push(`Live inputs not configured: ${inputs.join(', ')}.`);
  return { allowed: false, reasons: [...new Set(reasons)] };
}

const describe = (e: unknown): string => (e instanceof LighterPrivateError ? `${e.kind}${e.code !== undefined ? ` ${e.code}` : ''}: ${e.message}`.slice(0, 300) : 'Verification failed.');

/** Managed Lighter exposure or orders that a disconnect or account change would strand. */
export async function lighterExposure(db: Executor, ownerId: string, connectionId?: string): Promise<{ openPositions: number; unresolvedIntents: number; unresolvedTxs: number }> {
  const accts = await db.select({ id: paperAccounts.id }).from(paperAccounts).where(and(eq(paperAccounts.ownerId, ownerId), eq(paperAccounts.mode, 'LIVE'), eq(paperAccounts.exchange, 'LIGHTER')));
  const ids = accts.map((a) => a.id);
  const open = ids.length ? await db.select({ id: positions.id }).from(positions).where(and(inArray(positions.paperAccountId, ids), eq(positions.status, 'OPEN'))) : [];
  const busy = ids.length
    ? await db
        .select({ id: orderIntents.id })
        .from(orderIntents)
        .where(and(inArray(orderIntents.paperAccountId, ids), inArray(orderIntents.state, ['INTENT', 'SUBMITTING', 'ACKNOWLEDGED', 'PARTIALLY_FILLED', 'UNKNOWN'])))
    : [];
  const txs = connectionId ? await db.select({ id: lighterTxs.id }).from(lighterTxs).where(and(eq(lighterTxs.connectionId, connectionId), inArray(lighterTxs.state, ['SENDING', 'UNKNOWN']))) : [];
  return { openPositions: open.length, unresolvedIntents: busy.length, unresolvedTxs: txs.length };
}

/** Verification of the investor's own Lighter connection. Sends nothing. */
export async function verifyLighterConnection(db: Db, ownerId: string, correlationId = 'live', env: Record<string, string | undefined> = process.env): Promise<ConnectionRow> {
  const conn = await connectionFor(db, ownerId, 'LIGHTER');
  if (!conn || conn.status === 'REVOKED') throw new DomainError(404, ErrorCode.NOT_FOUND, 'No Lighter connection is set up.');
  const checkedAt = new Date();
  const cred = lighterCredentialsOf(conn);
  let status: 'VERIFIED' | 'PENDING' | 'FAILED' = 'FAILED';
  let verification: Record<string, unknown>;
  try {
    const api = lighterApiFor(conn, env);
    // The API must be the environment the key is for (testnet and mainnet both report network_id 1).
    const id = await api.identity();
    if (id.contractAddress.toLowerCase() !== LIGHTER_ENVIRONMENTS[cred.environment].contractAddress.toLowerCase())
      throw new LighterPrivateError(`this Lighter API is not ${cred.environment} (contract ${id.contractAddress})`, 'API');
    const acct = await api.account(cred.accountIndex);
    const registered = acct ? await api.apiKeyPublicKey(cred.accountIndex, cred.apiKeyIndex) : null;
    let keyMatch: 'MATCH' | 'MISMATCH' | 'INVALID_KEY' | 'UNPROVEN_NO_SIGNER' = 'UNPROVEN_NO_SIGNER';
    let signerNote: string | null = null;
    if (registered) {
      try {
        keyMatch = (await lighterSignerFor(conn).publicKey()).replace(/^0x/i, '').toLowerCase() === registered ? 'MATCH' : 'MISMATCH';
      } catch (e) {
        // A signer that cannot run leaves the key unproven; a key the signer rejects fails the check.
        if (e instanceof LighterSignerError) keyMatch = 'INVALID_KEY';
        else if (e instanceof LighterSignerUnavailable) signerNote = e.message.slice(0, 200);
        else throw e;
      }
    }
    const error = !acct
      ? `Lighter has no account ${cred.accountIndex} on ${cred.environment}.`
      : !registered
        ? `API key index ${cred.apiKeyIndex} is not registered on Lighter account ${cred.accountIndex}.`
        : keyMatch === 'MISMATCH'
          ? `The saved API private key is not the key registered at index ${cred.apiKeyIndex} on account ${cred.accountIndex}.`
          : keyMatch === 'INVALID_KEY'
            ? 'The saved API private key is not a valid Lighter API key.'
            : null;
    status = error ? 'FAILED' : keyMatch === 'MATCH' ? 'VERIFIED' : 'PENDING';
    verification = {
      exchange: 'LIGHTER',
      checkedAt: checkedAt.toISOString(),
      environment: cred.environment,
      accountIndex: cred.accountIndex,
      apiKeyIndex: cred.apiKeyIndex,
      account: acct ? { found: true, tradingMode: acct.tradingMode === 1 ? 'UNIFIED' : acct.tradingMode === 0 ? 'CLASSIC' : null, accountType: acct.accountType, collateralUsdc: acct.collateral, availableUsdc: acct.availableBalance, openPositions: acct.positions.filter((p) => p.side).length } : { found: false },
      apiKey: { registered: !!registered, keyMatch },
      positionMode: 'Lighter keeps one net position per market (no hedge mode).',
      ...(error ? { error } : {}),
      ...(keyMatch === 'UNPROVEN_NO_SIGNER' && !error ? { note: 'Account and API key index found. The private key could not be proven to be that key: the Lighter signer is not available on this server.', ...(signerNote ? { signer: signerNote } : {}) } : {})
    };
  } catch (e) {
    verification = { exchange: 'LIGHTER', checkedAt: checkedAt.toISOString(), error: describe(e) };
  }
  verification.tradePermission = lighterTradePermission({ ...conn, status }, {}, env);
  await scrubLighterSignerAccount(cred.accountIndex).catch(() => undefined); // see Key lifecycle (lighterWasmSigner)
  let updated: ConnectionRow | undefined;
  try {
    [updated] = await db
      .update(exchangeConnections)
      .set({ status, verification, positionMode: status === 'VERIFIED' ? 'ONE_WAY' : null, verifiedAt: status === 'VERIFIED' ? checkedAt : null, liveEnabled: false, revision: sql`${exchangeConnections.revision} + 1`, updatedAt: sql`now()` })
      .where(eq(exchangeConnections.id, conn.id))
      .returning();
  } catch (e) {
    if ((e as { code?: string; cause?: { code?: string } }).code !== '23505' && (e as { cause?: { code?: string } }).cause?.code !== '23505') throw e;
    // Another investor's verified connection already holds this Lighter account.
    [updated] = await db
      .update(exchangeConnections)
      .set({ status: 'FAILED', verification: { ...verification, error: 'This Lighter account is already connected to another TrendPilot investor.' }, positionMode: null, verifiedAt: null, liveEnabled: false, revision: sql`${exchangeConnections.revision} + 1`, updatedAt: sql`now()` })
      .where(eq(exchangeConnections.id, conn.id))
      .returning();
    status = 'FAILED';
  }
  await recordAudit(db, { actorUserId: ownerId, action: 'LIVE_CONNECTION_VERIFY', targetType: 'exchange_connection', targetId: conn.id, result: status === 'VERIFIED' ? 'SUCCESS' : 'FAILED', metadata: { exchange: 'LIGHTER', status, accountIndex: cred.accountIndex, apiKeyIndex: cred.apiKeyIndex }, correlationId });
  return updated!;
}

/**
 * Saves (or replaces) the investor's Lighter API key, sealed, and verifies it. Replacing is refused
 * while it would strand managed exposure: a different Lighter ACCOUNT while TrendPilot manages
 * positions or orders on the current one, or any key change while a signed transaction's outcome is
 * still unknown (its nonce stream belongs to the old key).
 */
export async function saveLighterConnection(db: Db, ownerId: string, input: LighterConnectionInput, correlationId = 'live', env: Record<string, string | undefined> = process.env): Promise<ConnectionRow> {
  // Testnet is accepted only in an isolated local test setup (LIGHTER_TESTNET=enabled; see lighterTestnetEnabled).
  const v = validateLighterConnection(input, lighterTestnetEnabled(env) ? ['MAINNET', 'TESTNET'] : ['MAINNET']);
  if (!v.ok) throw new DomainError(400, ErrorCode.VALIDATION_FAILED, v.issues.join(' '));
  const [u] = await db.select({ role: users.role, status: users.status }).from(users).where(eq(users.id, ownerId));
  if (!u || u.role !== 'INVESTOR' || u.status !== 'ACTIVE') throw new DomainError(403, ErrorCode.FORBIDDEN, 'Only an active investor can connect an exchange account.');
  const prior = await connectionFor(db, ownerId, 'LIGHTER');
  if (prior && prior.status !== 'REVOKED') {
    // Rotation: this process's module stops holding the previous key for that account.
    if (prior.venueAccountIndex !== null) await scrubLighterSignerAccount(prior.venueAccountIndex).catch(() => undefined);
    const x = await lighterExposure(db, ownerId, prior.id);
    if (x.unresolvedTxs) throw new DomainError(409, ErrorCode.CONFLICT, 'A Lighter order sent with the current key is still being confirmed. Wait until it is resolved before replacing the key.');
    const sameAccount = prior.venueEnvironment === v.value.environment && prior.venueAccountIndex === v.value.accountIndex;
    if (!sameAccount && (x.openPositions || x.unresolvedIntents))
      throw new DomainError(409, ErrorCode.CONFLICT, 'TrendPilot manages Lighter positions or orders on your current Lighter account. Close them first; a key for a different account would leave them unmanaged.');
  }
  const values = {
    accountRef: lighterAccountRef(v.value.accountIndex, v.value.apiKeyIndex),
    apiKeySealed: seal(v.value.apiPrivateKey),
    secretSealed: seal(SECRET_MARKER),
    keyFingerprint: `API key ${v.value.apiKeyIndex}`,
    venueEnvironment: v.value.environment,
    venueAccountIndex: v.value.accountIndex,
    venueApiKeyIndex: v.value.apiKeyIndex,
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
    .values({ ownerId, exchange: 'LIGHTER', ...values })
    .onConflictDoUpdate({ target: [exchangeConnections.ownerId, exchangeConnections.exchange], set: { ...values, revision: sql`${exchangeConnections.revision} + 1`, updatedAt: sql`now()` } })
    .returning();
  await recordAudit(db, {
    actorUserId: ownerId,
    action: 'LIVE_CONNECTION_SAVE',
    targetType: 'exchange_connection',
    targetId: row!.id,
    result: 'SUCCESS',
    metadata: { exchange: 'LIGHTER', environment: v.value.environment, accountIndex: v.value.accountIndex, apiKeyIndex: v.value.apiKeyIndex, replaced: !!prior && prior.status !== 'REVOKED' },
    correlationId
  });
  return verifyLighterConnection(db, ownerId, correlationId, env);
}

/** Removes the Lighter key. Refused while it would strand managed positions, orders or an unconfirmed send. */
export async function revokeLighterConnection(db: Db, ownerId: string, correlationId = 'live'): Promise<ConnectionRow> {
  const conn = await connectionFor(db, ownerId, 'LIGHTER');
  if (!conn || conn.status === 'REVOKED') throw new DomainError(404, ErrorCode.NOT_FOUND, 'No Lighter connection is set up.');
  const x = await lighterExposure(db, ownerId, conn.id);
  if (x.openPositions || x.unresolvedIntents || x.unresolvedTxs)
    throw new DomainError(409, ErrorCode.CONFLICT, 'Close your Lighter Live positions and wait for Lighter orders to be confirmed before removing the key; without it TrendPilot could not manage or protect them.');
  const [u] = await db
    .update(exchangeConnections)
    .set({ status: 'REVOKED', apiKeySealed: '', secretSealed: '', liveEnabled: false, activatedAt: null, approvedAt: null, approvedBy: null, positionMode: null, revision: sql`${exchangeConnections.revision} + 1`, updatedAt: sql`now()` })
    .where(and(eq(exchangeConnections.id, conn.id), ne(exchangeConnections.status, 'REVOKED')))
    .returning();
  if (conn.venueAccountIndex !== null) await scrubLighterSignerAccount(conn.venueAccountIndex).catch(() => undefined);
  await recordAudit(db, { actorUserId: ownerId, action: 'LIVE_CONNECTION_REVOKE', targetType: 'exchange_connection', targetId: conn.id, result: 'SUCCESS', metadata: { exchange: 'LIGHTER' }, correlationId });
  return u!;
}
