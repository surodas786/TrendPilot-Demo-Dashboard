import { and, asc, eq, inArray, ne, sql } from 'drizzle-orm';
import {
  assertLiveTransportAllowed,
  Decimal,
  checkLiveEntry,
  DomainError,
  ErrorCode,
  keyFingerprint,
  LIVE_REFUSAL_TEXT,
  liveAccountBlockers,
  liveAccountGate,
  type LiveRefusal,
  validateAccountRef,
  validateLiveLimits,
  type LiveConnectionState,
  type LiveControlState,
  type LiveLimits,
  type LiveVerdict
} from '@trendpilot/domain';
import type { Db, Executor } from '../client';
import { recordAudit } from '../repos/audit';
import { exchangeConnections, instruments, liveControl, orderIntents, paperAccounts, positions, users } from '../schema';
import { open as unseal, seal } from '../security/secretBox';
import { book, lockPaperAccount } from '../paper/accounts';
import { paperVenue } from '../venue/paper';
import type { ExecutionVenue } from '../venue/types';
import type { CapabilityId, CapabilityState } from './capabilities';
import { MexcHttpTransport, MexcPrivateError, MEXC_PRIVATE_DEFAULT_BASE_URL, normalizeAssets, normalizePositions, normalizeStops, type MexcCredentials, type MexcRequester } from './mexcPrivate';
import { mexcVenue, POSITION_MODE_REQUIRED, UncertainSubmissionError } from './mexcVenue';

/**
 * Live mode (OPS-01/02/03): exchange connections, the platform switch, the contract allowlist,
 * venue resolution per account, and the Live guard. Paper and Live share the strategy rules,
 * the public market feed, the durable intents and the worker; they differ in the account (its
 * own balance, orders, positions, fills and ledger) and the venue (simulator vs MEXC).
 */

export type ConnectionRow = typeof exchangeConnections.$inferSelect;
export type LiveControlRow = typeof liveControl.$inferSelect;
const UNRESOLVED = ['INTENT', 'SUBMITTING', 'ACKNOWLEDGED', 'PARTIALLY_FILLED', 'UNKNOWN'] as const;

/* ───────────────────────── Test seam ───────────────────────── */

/**
 * Tests (and only tests) replace the MEXC HTTP transport with a mocked exchange and treat the
 * deployment transport as enabled. Refused in production, so a deployment can never route Live
 * orders anywhere but the signed MEXC transport, nor bypass LIVE_ORDER_TRANSPORT.
 */
export interface LiveTestSeam {
  requesterFor: (conn: ConnectionRow, purpose: 'READ_ONLY' | 'ORDERS') => MexcRequester;
  transportEnabled?: boolean;
  confirm?: { attempts: number; delayMs: number };
}
let seam: LiveTestSeam | null = null;
export function installLiveTestSeam(s: LiveTestSeam | null, env: Record<string, string | undefined> = process.env): void {
  if (s && env.NODE_ENV === 'production') throw new Error('The Live test seam is not allowed in production.');
  seam = s;
}

/** Whether this process may send Live orders at all (LIVE_ORDER_TRANSPORT). */
export function liveTransportEnabled(env: Record<string, string | undefined> = process.env): boolean {
  if (seam) return seam.transportEnabled ?? true;
  try {
    return assertLiveTransportAllowed(env) === 'enabled';
  } catch {
    return false;
  }
}

/* ───────────────────────── State ───────────────────────── */

export async function getLiveControl(db: Executor): Promise<LiveControlRow> {
  const [row] = await db.select().from(liveControl).where(eq(liveControl.id, 1));
  if (row) return row;
  await db.insert(liveControl).values({ id: 1 }).onConflictDoNothing();
  const [created] = await db.select().from(liveControl).where(eq(liveControl.id, 1));
  return created!;
}

export const limitsOf = (c: ConnectionRow): LiveLimits | null =>
  c.approvedAt && c.maxOrderContracts && c.maxOrderNotionalUsdt && c.maxLeverage && c.maxExposureUsdt
    ? { maxOrderContracts: c.maxOrderContracts, maxOrderNotionalUsdt: c.maxOrderNotionalUsdt, maxLeverage: c.maxLeverage, maxExposureUsdt: c.maxExposureUsdt }
    : null;

export const connectionState = (c: ConnectionRow): LiveConnectionState => ({
  ownerId: c.ownerId,
  status: c.status,
  positionMode: c.positionMode,
  approved: !!c.approvedAt,
  liveEnabled: c.liveEnabled,
  entriesHalted: c.entriesHalted,
  haltReason: c.haltReason,
  limits: limitsOf(c)
});

export const controlState = (c: LiveControlRow, env: Record<string, string | undefined> = process.env): LiveControlState => ({
  transportEnabled: liveTransportEnabled(env),
  platformEnabled: c.liveEnabled,
  platformEntriesHalted: c.entriesHalted,
  platformHaltReason: c.haltReason
});

export async function connectionFor(db: Executor, ownerId: string): Promise<ConnectionRow | null> {
  const [c] = await db.select().from(exchangeConnections).where(eq(exchangeConnections.ownerId, ownerId));
  return c ?? null;
}

export interface LiveEligibility {
  verdict: LiveVerdict;
  /** Text of every account-level blocker (e.g. an operator halt AND the position mode), or of the refusal. */
  reasonText: string | null;
  blockers: LiveRefusal[];
}

/**
 * Phase-1 Live check for an approved entry (inside the dispatch transaction): the same rules the
 * worker applies again right before sending. `openContracts`: platform contracts already open.
 */
export async function liveEntryEligibility(
  tx: Executor,
  r: { ownerId: string; instrumentId: string; contracts: string; price: string; leverage: number; openContracts: string }
): Promise<LiveEligibility> {
  const control = await getLiveControl(tx);
  const conn = await connectionFor(tx, r.ownerId);
  const [inst] = await tx.select({ liveAllowed: instruments.liveAllowed, multiplier: instruments.contractMultiplier }).from(instruments).where(eq(instruments.id, r.instrumentId));
  const state = controlState(control);
  const cs = conn ? connectionState(conn) : null;
  const verdict = checkLiveEntry(state, cs, {
    ownerId: r.ownerId,
    contractLiveAllowed: !!inst?.liveAllowed,
    contracts: r.contracts,
    price: r.price,
    multiplier: inst?.multiplier ?? '0',
    leverage: r.leverage,
    hasStop: true,
    openContracts: r.openContracts
  });
  if (verdict.ok) return { verdict, reasonText: null, blockers: [] };
  const account = liveAccountBlockers(state, cs, r.ownerId, !!inst?.liveAllowed).map((b) => b.reason);
  const blockers = account.length ? account : [verdict.reason];
  return { verdict, reasonText: blockers.map((b) => LIVE_REFUSAL_TEXT[b]).join(' '), blockers };
}

/* ───────────────────────── Capabilities ───────────────────────── */

export type CapabilityRecord = { state: 'VERIFIED' | 'PILOT_ACCEPTED' | 'PENDING'; evidence: string; by: string; at: string };
/** Capabilities a Live order path needs before the platform switch can be turned on. */
export const ORDER_CAPABILITIES: CapabilityId[] = ['OPEN_WITH_ATTACHED_STOP', 'REDUCE_ONLY_CLOSE', 'STOP_RESIZE_AFTER_PARTIAL_CLOSE', 'CANCEL_STOP'];

/** The adapter's capability gate from the operator's records (VERIFIED or accepted for the supervised pilot). */
export function capabilityStateOf(control: LiveControlRow): CapabilityState {
  const ev = (control.capabilityEvidence ?? {}) as Partial<Record<CapabilityId, CapabilityRecord>>;
  const out: CapabilityState = {};
  for (const [id, r] of Object.entries(ev) as [CapabilityId, CapabilityRecord][]) out[id] = r.state === 'VERIFIED' || r.state === 'PILOT_ACCEPTED' ? 'VERIFIED' : 'PENDING';
  return out;
}

/* ───────────────────────── Venue resolution ───────────────────────── */

export class LiveVenueUnavailable extends Error {
  constructor(reason: string) {
    super(`Live venue unavailable: ${reason}`);
    this.name = 'LiveVenueUnavailable';
  }
}

const credentialsOf = (c: ConnectionRow): MexcCredentials => ({ apiKey: unseal(c.apiKeySealed), secretKey: unseal(c.secretSealed) });

function requesterFor(c: ConnectionRow, purpose: 'READ_ONLY' | 'ORDERS', env: Record<string, string | undefined>): MexcRequester {
  if (seam) return seam.requesterFor(c, purpose);
  return new MexcHttpTransport({ mode: purpose, credentials: credentialsOf(c), baseUrl: env.MEXC_PRIVATE_BASE_URL || MEXC_PRIVATE_DEFAULT_BASE_URL, env });
}

/** The execution venue for an account. PAPER: the simulator. LIVE: the guarded MEXC adapter. */
export async function resolveAccountVenue(
  db: Db,
  scope: { mode: string; paperAccountId: string; ownerId?: string },
  injected?: ExecutionVenue,
  env: Record<string, string | undefined> = process.env
): Promise<ExecutionVenue> {
  if (injected) {
    if (env.NODE_ENV === 'production') throw new LiveVenueUnavailable('venue injection is not allowed in production');
    return injected;
  }
  if (scope.mode === 'PAPER') return paperVenue(db);
  if (scope.mode !== 'LIVE') throw new Error(`Unknown trading mode ${scope.mode}`);
  const [acct] = await db.select().from(paperAccounts).where(eq(paperAccounts.id, scope.paperAccountId));
  if (!acct || acct.mode !== 'LIVE') throw new LiveVenueUnavailable('the order does not belong to a Live account');
  // IAM-02 in the worker: the order's owner must own the account (and so the connection).
  if (scope.ownerId && acct.ownerId !== scope.ownerId) throw new LiveVenueUnavailable('ownership mismatch');
  const conn = await connectionFor(db, acct.ownerId);
  if (!conn || conn.status === 'REVOKED' || !conn.apiKeySealed) throw new LiveVenueUnavailable('no exchange connection');
  if (!conn.positionMode) throw new LiveVenueUnavailable('position mode not verified');
  const control = await getLiveControl(db);
  const inner = mexcVenue({
    requester: requesterFor(conn, 'ORDERS', env), // refuses unless LIVE_ORDER_TRANSPORT=enabled in production
    symbolFor: async (instrumentId) => {
      const [i] = await db.select({ s: instruments.exchangeSymbol }).from(instruments).where(eq(instruments.id, instrumentId));
      if (!i?.s) throw new LiveVenueUnavailable(`instrument ${instrumentId} has no MEXC symbol`);
      return i.s;
    },
    positionMode: conn.positionMode as 'ONE_WAY' | 'HEDGE',
    capabilities: capabilityStateOf(control),
    ...(seam?.confirm ? { confirm: seam.confirm, sleep: async () => {} } : {})
  });
  return liveGuardedVenue(db, inner, { paperAccountId: acct.id, ownerId: acct.ownerId, env });
}

/* ───────────────────────── Live guard ───────────────────────── */

/** Halts new Live entries for one connection (operator, investor or the system). Closes keep working. */
export async function haltConnectionEntries(db: Executor, ownerId: string, reason: string, actorUserId: string | null, correlationId = 'live'): Promise<void> {
  const rows = await db
    .update(exchangeConnections)
    .set({ entriesHalted: true, haltReason: reason.slice(0, 200), haltedAt: new Date(), revision: sql`${exchangeConnections.revision} + 1`, updatedAt: sql`now()` })
    .where(and(eq(exchangeConnections.ownerId, ownerId), eq(exchangeConnections.entriesHalted, false)))
    .returning({ id: exchangeConnections.id });
  if (rows[0]) await recordAudit(db, { actorUserId, action: 'LIVE_ENTRIES_HALT', targetType: 'exchange_connection', targetId: rows[0].id, result: 'SUCCESS', metadata: { reason }, correlationId });
}

/**
 * Wraps the MEXC venue. Opening orders are re-checked here, in the worker, right before they are
 * sent: transport, platform switch and halt, ownership, verified + approved connection,
 * investor activation and halt, contract allowlist, stop present, and the limits against the
 * position MEXC reports. Lookups, closes, stop resize and cancel pass through untouched, so
 * protection and closing are never blocked. An uncertain submission or an unverified stop halts
 * new entries on the account automatically.
 */
export function liveGuardedVenue(db: Db, inner: ExecutionVenue, o: { paperAccountId: string; ownerId: string; env?: Record<string, string | undefined> }): ExecutionVenue {
  const halt = (reason: string) => haltConnectionEntries(db, o.ownerId, reason, null, 'live-guard');
  return {
    ...inner,
    async placeOpeningOrderWithStop(r) {
      const reject = (reason: string) => ({ status: 'REJECTED' as const, orderId: '', clientOrderId: r.clientOrderId, reason });
      if (r.paperAccountId !== o.paperAccountId) return reject('LIVE_REFUSED:LIVE_OWNERSHIP_MISMATCH');
      const control = await getLiveControl(db);
      const conn = await connectionFor(db, o.ownerId);
      const [inst] = await db.select({ liveAllowed: instruments.liveAllowed, multiplier: instruments.contractMultiplier }).from(instruments).where(eq(instruments.id, r.instrumentId));
      const gate = liveAccountGate(controlState(control, o.env), conn ? connectionState(conn) : null, o.ownerId, !!inst?.liveAllowed);
      if (!gate.ok) return reject(`LIVE_REFUSED:${gate.reason}`);
      const held = await inner.position(r.paperAccountId, r.instrumentId);
      const verdict = checkLiveEntry(controlState(control, o.env), connectionState(conn!), {
        ownerId: o.ownerId,
        contractLiveAllowed: !!inst?.liveAllowed,
        contracts: r.contracts,
        price: r.side === 'LONG' ? r.quote.ask : r.quote.bid,
        multiplier: inst?.multiplier ?? '0',
        leverage: r.leverage ?? Number.MAX_SAFE_INTEGER,
        hasStop: !!r.stop,
        openContracts: held.contracts
      });
      if (!verdict.ok) return reject(`LIVE_REFUSED:${verdict.reason}`);
      let result;
      try {
        result = await inner.placeOpeningOrderWithStop(r);
      } catch (e) {
        if (e instanceof UncertainSubmissionError) await halt(`UNCERTAIN_ORDER ${r.clientOrderId}`);
        throw e;
      }
      if (result.status === 'REJECTED' && result.reason === POSITION_MODE_REQUIRED) {
        // MEXC reports Hedge although the last check said One-way: record it and stop new entries.
        await db
          .update(exchangeConnections)
          .set({ positionMode: 'HEDGE', revision: sql`${exchangeConnections.revision} + 1`, updatedAt: sql`now()` })
          .where(eq(exchangeConnections.ownerId, o.ownerId));
        await halt(`POSITION_MODE ${r.clientOrderId}: MEXC account is not in One-way mode`);
        return { ...result, reason: `LIVE_REFUSED:LIVE_POSITION_MODE` };
      }
      if (result.status === 'FILLED') {
        const prot = await inner.inspectProtection(result.stop.orderId, r.instrumentId);
        if (!prot || prot.status !== 'ACTIVE' || !prot.reduceOnly) await halt(`PROTECTION_FAILURE ${r.clientOrderId}`);
      }
      return result;
    }
  };
}

/* ───────────────────────── Live balance ───────────────────────── */

/**
 * Applies a MEXC USDT balance read to the investor's Live account (creating it on first use): the
 * wallet follows MEXC's cash balance (equity − unrealized) through an EXCHANGE_BALANCE_SYNC ledger
 * row, and equity / available-to-open are stored for display and the entry margin check.
 */
export async function applyExchangeBalance(db: Db, ownerId: string, usdt: { equity: string; availableOpen: string; unrealized: string }, refId: string, now: Date): Promise<{ accountId: string; walletAdjustment: string }> {
  return db.transaction(async (tx) => {
    const a = await lockPaperAccount(tx, ownerId, 'LIVE');
    const delta = new Decimal(usdt.equity).minus(usdt.unrealized).minus(a.walletBalance);
    if (!delta.isZero()) {
      await book(tx, a, [{ kind: 'EXCHANGE_BALANCE_SYNC', bucket: 'WALLET', amount: delta.toFixed(), refType: 'exchange_sync', refId, memo: 'Wallet matched to the MEXC balance (fees, funding and P&L as booked by MEXC)' }]);
    }
    await tx.update(paperAccounts).set({ exchangeEquity: usdt.equity, exchangeAvailable: usdt.availableOpen, exchangeSyncedAt: now, updatedAt: sql`now()` }).where(eq(paperAccounts.id, a.id));
    return { accountId: a.id, walletAdjustment: delta.toFixed() };
  });
}

/* ───────────────────────── Investor: exchange connection ───────────────────────── */

export interface ConnectionDto {
  id: string;
  exchange: string;
  accountRef: string;
  keyFingerprint: string;
  status: string;
  positionMode: string | null;
  verification: Record<string, unknown>;
  verifiedAt: string | null;
  approved: boolean;
  approvedAt: string | null;
  limits: LiveLimits | null;
  liveEnabled: boolean;
  activatedAt: string | null;
  entriesHalted: boolean;
  haltReason: string | null;
  lastSyncAt: string | null;
  lastSyncError: string | null;
  /** Last sync that completed every MEXC query. */
  lastSyncOkAt: string | null;
  drift: unknown[];
  revision: number;
}

/** Never includes the sealed key or secret. */
export const connectionDto = (c: ConnectionRow): ConnectionDto => ({
  id: c.id,
  exchange: c.exchange,
  accountRef: c.accountRef,
  keyFingerprint: c.keyFingerprint,
  status: c.status,
  positionMode: c.positionMode,
  verification: (c.verification ?? {}) as Record<string, unknown>,
  verifiedAt: c.verifiedAt?.toISOString() ?? null,
  approved: !!c.approvedAt,
  approvedAt: c.approvedAt?.toISOString() ?? null,
  limits: limitsOf(c),
  liveEnabled: c.liveEnabled,
  activatedAt: c.activatedAt?.toISOString() ?? null,
  entriesHalted: c.entriesHalted,
  haltReason: c.haltReason,
  lastSyncAt: c.lastSyncAt?.toISOString() ?? null,
  lastSyncError: c.lastSyncError,
  lastSyncOkAt: c.lastSyncOkAt?.toISOString() ?? null,
  drift: (c.drift ?? []) as unknown[],
  revision: c.revision
});

async function liveExposure(db: Executor, ownerId: string): Promise<{ openPositions: number; unresolved: number }> {
  const accts = await db.select({ id: paperAccounts.id }).from(paperAccounts).where(and(eq(paperAccounts.ownerId, ownerId), eq(paperAccounts.mode, 'LIVE')));
  if (!accts.length) return { openPositions: 0, unresolved: 0 };
  const ids = accts.map((a) => a.id);
  const open = await db.select({ id: positions.id }).from(positions).where(and(inArray(positions.paperAccountId, ids), eq(positions.status, 'OPEN')));
  const busy = await db.select({ id: orderIntents.id }).from(orderIntents).where(and(inArray(orderIntents.paperAccountId, ids), inArray(orderIntents.state, [...UNRESOLVED])));
  return { openPositions: open.length, unresolved: busy.length };
}

/**
 * Read-only verification of a connection: signing, position mode, balances, open positions and
 * stop orders. Uses the READ_ONLY transport, which cannot send an order. MEXC has no documented
 * endpoint that lists an API key's permissions, so "Order Placing" permission is confirmed only by
 * the first supervised Live order (see the runbook).
 */
export async function verifyConnection(db: Db, ownerId: string, correlationId = 'live', env: Record<string, string | undefined> = process.env): Promise<ConnectionRow> {
  const conn = await connectionFor(db, ownerId);
  if (!conn || conn.status === 'REVOKED') throw new DomainError(404, ErrorCode.NOT_FOUND, 'No exchange connection is set up.');
  const checkedAt = new Date().toISOString();
  let verification: Record<string, unknown>;
  let status: 'VERIFIED' | 'FAILED';
  let positionMode: 'ONE_WAY' | 'HEDGE' | null = null;
  try {
    const r = requesterFor(conn, 'READ_ONLY', env);
    const mode = await r.request<number>('GET', '/api/v1/private/position/position_mode');
    positionMode = Number(mode) === 2 ? 'ONE_WAY' : 'HEDGE';
    const usdt = normalizeAssets(await r.request('GET', '/api/v1/private/account/assets')).find((a) => a.currency === 'USDT');
    const open = normalizePositions(await r.request('GET', '/api/v1/private/position/open_positions', {})).filter((p) => p.open);
    const stops = normalizeStops(await r.request('GET', '/api/v1/private/stoporder/open_orders', {})).filter((s) => s.state === 'ACTIVE');
    verification = {
      checkedAt,
      signedRequests: 'OK',
      positionMode,
      positionModeNote:
        positionMode === 'ONE_WAY'
          ? 'One-way mode: required for Live entries.'
          : 'Hedge mode: Live entries need One-way mode. Switch the MEXC Futures account to One-way, then press Save and check again. Closes of any open position still work.',
      usdt: usdt ? { equity: usdt.equity, available: usdt.availableOpen } : null,
      openPositions: open.map((p) => ({ symbol: p.symbol, side: p.side, contracts: p.contracts })),
      activeStops: stops.length,
      orderPermission: 'Not readable through the MEXC API; confirmed by the first supervised Live order.'
    };
    status = 'VERIFIED';
    if (usdt) await applyExchangeBalance(db, ownerId, usdt, `verify:${conn.id}:${checkedAt}`, new Date());
  } catch (e) {
    const err = e as MexcPrivateError;
    verification = { checkedAt, error: err instanceof MexcPrivateError ? `${err.kind}${err.code ? ` ${err.code}` : ''}: ${err.message}`.slice(0, 300) : 'Verification failed.' };
    status = 'FAILED';
  }
  const [u] = await db
    .update(exchangeConnections)
    .set({
      status,
      verification,
      positionMode,
      verifiedAt: status === 'VERIFIED' ? new Date() : null,
      // A failed verification switches Live off for the account.
      ...(status === 'FAILED' ? { liveEnabled: false } : {}),
      revision: sql`${exchangeConnections.revision} + 1`,
      updatedAt: sql`now()`
    })
    .where(eq(exchangeConnections.id, conn.id))
    .returning();
  await recordAudit(db, { actorUserId: ownerId, action: 'LIVE_CONNECTION_VERIFY', targetType: 'exchange_connection', targetId: conn.id, result: status === 'VERIFIED' ? 'SUCCESS' : 'FAILED', metadata: { status, positionMode }, correlationId });
  return u!;
}

/** Saves (or replaces) the investor's MEXC API key and verifies it read-only. Live stays Off. */
export async function saveConnection(
  db: Db,
  ownerId: string,
  input: { accountRef: string; apiKey: string; secretKey: string },
  correlationId = 'live',
  env: Record<string, string | undefined> = process.env
): Promise<ConnectionRow> {
  const refIssue = validateAccountRef(input.accountRef ?? '');
  const apiKey = (input.apiKey ?? '').trim();
  const secretKey = (input.secretKey ?? '').trim();
  const issues = [refIssue, apiKey.length < 8 ? 'Enter the MEXC API key.' : null, secretKey.length < 8 ? 'Enter the MEXC secret key.' : null].filter((x): x is string => !!x);
  if (issues.length) throw new DomainError(400, ErrorCode.VALIDATION_FAILED, issues.join(' '));
  const [u] = await db.select({ role: users.role, status: users.status }).from(users).where(eq(users.id, ownerId));
  if (!u || u.role !== 'INVESTOR' || u.status !== 'ACTIVE') throw new DomainError(403, ErrorCode.FORBIDDEN, 'Only an active investor can connect an exchange account.');
  const exposure = await liveExposure(db, ownerId);
  if (exposure.openPositions || exposure.unresolved) throw new DomainError(409, ErrorCode.CONFLICT, 'Close your Live positions and wait for open Live orders to finish before replacing the API key.');
  const values = {
    accountRef: input.accountRef.trim(),
    apiKeySealed: seal(apiKey),
    secretSealed: seal(secretKey),
    keyFingerprint: keyFingerprint(apiKey),
    status: 'PENDING',
    verification: {},
    verifiedAt: null,
    positionMode: null,
    // A new key (possibly a different account) needs a fresh approval and activation.
    approvedAt: null,
    approvedBy: null,
    maxOrderContracts: null,
    maxOrderNotionalUsdt: null,
    maxLeverage: null,
    maxExposureUsdt: null,
    liveEnabled: false,
    activatedAt: null,
    drift: []
  };
  const [row] = await db
    .insert(exchangeConnections)
    .values({ ownerId, ...values })
    .onConflictDoUpdate({ target: exchangeConnections.ownerId, set: { ...values, revision: sql`${exchangeConnections.revision} + 1`, updatedAt: sql`now()` } })
    .returning();
  await recordAudit(db, { actorUserId: ownerId, action: 'LIVE_CONNECTION_SAVE', targetType: 'exchange_connection', targetId: row!.id, result: 'SUCCESS', metadata: { accountRef: values.accountRef, keyFingerprint: values.keyFingerprint }, correlationId });
  return verifyConnection(db, ownerId, correlationId, env);
}

/** Removes the key. Refused while Live positions are open or Live orders are unresolved. */
export async function revokeConnection(db: Db, ownerId: string, correlationId = 'live'): Promise<ConnectionRow> {
  const conn = await connectionFor(db, ownerId);
  if (!conn || conn.status === 'REVOKED') throw new DomainError(404, ErrorCode.NOT_FOUND, 'No exchange connection is set up.');
  const exposure = await liveExposure(db, ownerId);
  if (exposure.openPositions || exposure.unresolved) throw new DomainError(409, ErrorCode.CONFLICT, 'Close your Live positions and wait for open Live orders to finish before removing the API key.');
  const [u] = await db
    .update(exchangeConnections)
    .set({ status: 'REVOKED', apiKeySealed: '', secretSealed: '', liveEnabled: false, activatedAt: null, approvedAt: null, approvedBy: null, revision: sql`${exchangeConnections.revision} + 1`, updatedAt: sql`now()` })
    .where(eq(exchangeConnections.id, conn.id))
    .returning();
  await recordAudit(db, { actorUserId: ownerId, action: 'LIVE_CONNECTION_REVOKE', targetType: 'exchange_connection', targetId: conn.id, result: 'SUCCESS', correlationId });
  return u!;
}

/** The investor switches Live trading on or off for their own account. Off by default. */
export async function setLiveActivation(db: Db, ownerId: string, enabled: boolean, correlationId = 'live'): Promise<ConnectionRow> {
  return db.transaction(async (tx) => {
    const [conn] = await tx.select().from(exchangeConnections).where(eq(exchangeConnections.ownerId, ownerId)).for('update');
    if (!conn || conn.status === 'REVOKED') throw new DomainError(404, ErrorCode.NOT_FOUND, 'No exchange connection is set up.');
    if (enabled) {
      if (conn.status !== 'VERIFIED') throw new DomainError(409, ErrorCode.CONFLICT, 'Verify the exchange connection first.');
      if (!conn.approvedAt) throw new DomainError(409, ErrorCode.CONFLICT, 'An administrator must approve this MEXC account and set its limits first.');
    }
    const [u] = await tx
      .update(exchangeConnections)
      .set({ liveEnabled: enabled, activatedAt: enabled ? new Date() : null, revision: sql`${exchangeConnections.revision} + 1`, updatedAt: sql`now()` })
      .where(eq(exchangeConnections.id, conn.id))
      .returning();
    await recordAudit(tx, { actorUserId: ownerId, action: enabled ? 'LIVE_ACTIVATE' : 'LIVE_DEACTIVATE', targetType: 'exchange_connection', targetId: conn.id, result: 'SUCCESS', correlationId });
    return u!;
  });
}

/* ───────────────────────── Admin ───────────────────────── */

export async function listConnections(db: Executor): Promise<(ConnectionDto & { owner: { id: string; email: string; name: string } })[]> {
  const rows = await db
    .select({ c: exchangeConnections, email: users.email, name: users.name })
    .from(exchangeConnections)
    .innerJoin(users, eq(users.id, exchangeConnections.ownerId))
    .where(ne(exchangeConnections.status, 'REVOKED'))
    .orderBy(asc(users.email));
  return rows.map((r) => ({ ...connectionDto(r.c), owner: { id: r.c.ownerId, email: r.email, name: r.name } }));
}

/** Allowlists a verified MEXC account for Live and sets its limits (or updates them). */
export async function approveConnection(db: Db, adminId: string, connectionId: string, limits: LiveLimits, correlationId = 'live'): Promise<ConnectionRow> {
  const issues = validateLiveLimits(limits);
  if (issues.length) throw new DomainError(400, ErrorCode.VALIDATION_FAILED, issues.join('; '));
  return db.transaction(async (tx) => {
    const [conn] = await tx.select().from(exchangeConnections).where(eq(exchangeConnections.id, connectionId)).for('update');
    if (!conn || conn.status === 'REVOKED') throw new DomainError(404, ErrorCode.NOT_FOUND, 'Exchange connection not found.');
    if (conn.status !== 'VERIFIED') throw new DomainError(409, ErrorCode.CONFLICT, 'Only a verified connection can be approved.');
    const before = limitsOf(conn);
    const [u] = await tx
      .update(exchangeConnections)
      .set({
        approvedAt: new Date(),
        approvedBy: adminId,
        maxOrderContracts: limits.maxOrderContracts,
        maxOrderNotionalUsdt: limits.maxOrderNotionalUsdt,
        maxLeverage: limits.maxLeverage,
        maxExposureUsdt: limits.maxExposureUsdt,
        revision: sql`${exchangeConnections.revision} + 1`,
        updatedAt: sql`now()`
      })
      .where(eq(exchangeConnections.id, connectionId))
      .returning();
    await recordAudit(tx, { actorUserId: adminId, action: 'ADMIN_LIVE_CONNECTION_APPROVE', targetType: 'exchange_connection', targetId: connectionId, result: 'SUCCESS', before: before ? { ...before } : null, after: { ...limits }, correlationId });
    return u!;
  });
}

/** Removes the account from the Live allowlist; Live is switched off for it. Closes keep working. */
export async function unapproveConnection(db: Db, adminId: string, connectionId: string, correlationId = 'live'): Promise<ConnectionRow> {
  const [u] = await db
    .update(exchangeConnections)
    .set({ approvedAt: null, approvedBy: null, liveEnabled: false, activatedAt: null, revision: sql`${exchangeConnections.revision} + 1`, updatedAt: sql`now()` })
    .where(eq(exchangeConnections.id, connectionId))
    .returning();
  if (!u) throw new DomainError(404, ErrorCode.NOT_FOUND, 'Exchange connection not found.');
  await recordAudit(db, { actorUserId: adminId, action: 'ADMIN_LIVE_CONNECTION_UNAPPROVE', targetType: 'exchange_connection', targetId: connectionId, result: 'SUCCESS', correlationId });
  return u;
}

/** Resume new entries on one account (operator only). Refused while an order is unresolved or a position is unprotected. */
export async function resumeConnectionEntries(db: Db, adminId: string, connectionId: string, note: string, correlationId = 'live'): Promise<ConnectionRow> {
  if (!note?.trim()) throw new DomainError(400, ErrorCode.VALIDATION_FAILED, 'A note confirming the review is required.');
  return db.transaction(async (tx) => {
    const [conn] = await tx.select().from(exchangeConnections).where(eq(exchangeConnections.id, connectionId)).for('update');
    if (!conn) throw new DomainError(404, ErrorCode.NOT_FOUND, 'Exchange connection not found.');
    const accts = await tx.select({ id: paperAccounts.id }).from(paperAccounts).where(and(eq(paperAccounts.ownerId, conn.ownerId), eq(paperAccounts.mode, 'LIVE')));
    if (accts.length) {
      const ids = accts.map((a) => a.id);
      const busy = await tx.select({ id: orderIntents.id }).from(orderIntents).where(and(inArray(orderIntents.paperAccountId, ids), inArray(orderIntents.state, [...UNRESOLVED])));
      if (busy.length) throw new DomainError(409, ErrorCode.CONFLICT, `${busy.length} Live order(s) are unresolved; reconcile them before resuming entries.`);
      const unprotected = await tx
        .select({ id: positions.id })
        .from(positions)
        .where(and(inArray(positions.paperAccountId, ids), eq(positions.status, 'OPEN'), ne(positions.protectionStatus, 'PROTECTED')));
      if (unprotected.length) throw new DomainError(409, ErrorCode.CONFLICT, 'A Live position is not protected; restore its stop or close it before resuming entries.');
    }
    if ((conn.drift as unknown[]).length) throw new DomainError(409, ErrorCode.CONFLICT, 'MEXC and TrendPilot disagree on this account (drift). Resolve it before resuming entries.');
    const [u] = await tx
      .update(exchangeConnections)
      .set({ entriesHalted: false, haltReason: null, haltedAt: null, revision: sql`${exchangeConnections.revision} + 1`, updatedAt: sql`now()` })
      .where(eq(exchangeConnections.id, connectionId))
      .returning();
    await recordAudit(tx, { actorUserId: adminId, action: 'ADMIN_LIVE_ENTRIES_RESUME', targetType: 'exchange_connection', targetId: connectionId, result: 'SUCCESS', metadata: { note: note.slice(0, 300) }, correlationId });
    return u!;
  });
}

/** Clears a reviewed drift record (the operator confirmed MEXC and TrendPilot match again). */
export async function clearConnectionDrift(db: Db, adminId: string, connectionId: string, note: string, correlationId = 'live'): Promise<ConnectionRow> {
  if (!note?.trim()) throw new DomainError(400, ErrorCode.VALIDATION_FAILED, 'A note describing the review is required.');
  const [u] = await db
    .update(exchangeConnections)
    .set({ drift: [], revision: sql`${exchangeConnections.revision} + 1`, updatedAt: sql`now()` })
    .where(eq(exchangeConnections.id, connectionId))
    .returning();
  if (!u) throw new DomainError(404, ErrorCode.NOT_FOUND, 'Exchange connection not found.');
  await recordAudit(db, { actorUserId: adminId, action: 'ADMIN_LIVE_DRIFT_CLEAR', targetType: 'exchange_connection', targetId: connectionId, result: 'SUCCESS', metadata: { note: note.slice(0, 300) }, correlationId });
  return u;
}

export interface LiveControlDto {
  transportEnabled: boolean;
  liveEnabled: boolean;
  entriesHalted: boolean;
  haltReason: string | null;
  haltedAt: string | null;
  capabilities: Partial<Record<CapabilityId, CapabilityRecord>>;
  note: string | null;
  revision: number;
  updatedAt: string;
}
export const liveControlDto = (c: LiveControlRow, env: Record<string, string | undefined> = process.env): LiveControlDto => ({
  transportEnabled: liveTransportEnabled(env),
  liveEnabled: c.liveEnabled,
  entriesHalted: c.entriesHalted,
  haltReason: c.haltReason,
  haltedAt: c.haltedAt?.toISOString() ?? null,
  capabilities: (c.capabilityEvidence ?? {}) as Partial<Record<CapabilityId, CapabilityRecord>>,
  note: c.note,
  revision: c.revision,
  updatedAt: c.updatedAt.toISOString()
});

const bumpControl = { revision: sql`${liveControl.revision} + 1`, updatedAt: sql`now()` };

/** Records the operator's evidence for one MEXC capability. */
export async function recordCapabilityEvidence(db: Db, adminId: string, capability: CapabilityId, state: CapabilityRecord['state'], evidence: string, correlationId = 'live'): Promise<LiveControlRow> {
  if (!['VERIFIED', 'PILOT_ACCEPTED', 'PENDING'].includes(state)) throw new DomainError(400, ErrorCode.VALIDATION_FAILED, 'state must be VERIFIED, PILOT_ACCEPTED or PENDING');
  if (!evidence?.trim()) throw new DomainError(400, ErrorCode.VALIDATION_FAILED, 'Evidence (a reference or note) is required.');
  return db.transaction(async (tx) => {
    const c = await getLiveControl(tx);
    const ev = { ...(c.capabilityEvidence as Record<string, CapabilityRecord>), [capability]: { state, evidence: evidence.trim().slice(0, 500), by: adminId, at: new Date().toISOString() } };
    const [u] = await tx.update(liveControl).set({ capabilityEvidence: ev, updatedBy: adminId, ...bumpControl }).where(eq(liveControl.id, 1)).returning();
    await recordAudit(tx, { actorUserId: adminId, action: 'ADMIN_LIVE_CAPABILITY', targetType: 'live_control', targetId: '1', result: 'SUCCESS', metadata: { capability, state }, correlationId });
    return u!;
  });
}

/**
 * The platform Live switch. Turning it on needs a note and every order capability recorded as
 * VERIFIED or accepted for the supervised pilot. Turning it off is always allowed: no new Live
 * entries; protective and closing actions continue.
 */
export async function setPlatformLive(db: Db, adminId: string, enabled: boolean, note: string, correlationId = 'live'): Promise<LiveControlRow> {
  if (!note?.trim()) throw new DomainError(400, ErrorCode.VALIDATION_FAILED, 'A note is required.');
  return db.transaction(async (tx) => {
    const c = await getLiveControl(tx);
    if (enabled) {
      const ev = c.capabilityEvidence as Record<string, CapabilityRecord>;
      const missing = ORDER_CAPABILITIES.filter((id) => !['VERIFIED', 'PILOT_ACCEPTED'].includes(ev[id]?.state ?? ''));
      if (missing.length) throw new DomainError(409, ErrorCode.CONFLICT, `Record these order capabilities as VERIFIED or PILOT_ACCEPTED first: ${missing.join(', ')}`);
    }
    const [u] = await tx.update(liveControl).set({ liveEnabled: enabled, note: note.trim().slice(0, 500), updatedBy: adminId, ...bumpControl }).where(eq(liveControl.id, 1)).returning();
    await recordAudit(tx, { actorUserId: adminId, action: enabled ? 'ADMIN_LIVE_PLATFORM_ON' : 'ADMIN_LIVE_PLATFORM_OFF', targetType: 'live_control', targetId: '1', result: 'SUCCESS', before: { liveEnabled: c.liveEnabled }, after: { liveEnabled: enabled }, metadata: { note: note.slice(0, 300) }, correlationId });
    return u!;
  });
}

/** Operator control: halt (or resume) every new Live entry. Protection and closes keep running. */
export async function setPlatformEntriesHalted(db: Db, adminId: string, halted: boolean, reason: string, correlationId = 'live'): Promise<LiveControlRow> {
  if (!reason?.trim()) throw new DomainError(400, ErrorCode.VALIDATION_FAILED, halted ? 'A reason is required.' : 'A note confirming the review is required.');
  const [u] = await db
    .update(liveControl)
    .set({ entriesHalted: halted, haltReason: halted ? reason.trim().slice(0, 200) : null, haltedAt: halted ? new Date() : null, updatedBy: adminId, ...bumpControl })
    .where(eq(liveControl.id, 1))
    .returning();
  await recordAudit(db, { actorUserId: adminId, action: halted ? 'ADMIN_LIVE_PLATFORM_HALT' : 'ADMIN_LIVE_PLATFORM_RESUME', targetType: 'live_control', targetId: '1', result: 'SUCCESS', metadata: { reason: reason.slice(0, 300) }, correlationId });
  return u!;
}

/** Adds or removes a published contract from the Live allowlist. */
export async function setInstrumentLiveAllowed(db: Db, adminId: string, instrumentId: string, allowed: boolean, correlationId = 'live'): Promise<void> {
  const [i] = await db.select().from(instruments).where(eq(instruments.id, instrumentId));
  if (!i) throw new DomainError(404, ErrorCode.NOT_FOUND, 'Instrument not found.');
  if (allowed && (i.status !== 'PUBLISHED' || !i.exchangeSymbol || i.isFixture)) throw new DomainError(409, ErrorCode.CONFLICT, 'Only a published contract validated against MEXC (not fixture metadata) can be allowed for Live.');
  await db.update(instruments).set({ liveAllowed: allowed, revision: sql`${instruments.revision} + 1`, updatedAt: sql`now()` }).where(eq(instruments.id, instrumentId));
  await recordAudit(db, { actorUserId: adminId, action: allowed ? 'ADMIN_LIVE_CONTRACT_ALLOW' : 'ADMIN_LIVE_CONTRACT_DISALLOW', targetType: 'instrument', targetId: instrumentId, result: 'SUCCESS', metadata: { symbol: i.symbol, exchangeSymbol: i.exchangeSymbol }, correlationId });
}
