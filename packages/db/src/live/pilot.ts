import { and, eq, inArray, ne, sql } from 'drizzle-orm';
import { ALLOWED_MODES, checkPilotEntry, DomainError, ErrorCode, pilotBlockIssues, validatePilotLimits, type PilotScope } from '@trendpilot/domain';
import type { Db, Executor } from '../client';
import { recordAudit } from '../repos/audit';
import { instruments, livePilots, orderBlocks, orderIntents, paperAccounts, positions, strategyVersions, users } from '../schema';
import type { ExecutionVenue } from '../venue/types';
import { livePilotVerified, MEXC_CAPABILITIES, type CapabilityId } from './capabilities';
import { LIVE_ACTIVATION_ALLOWED_IN_THIS_BUILD } from './mexcPrivate';
import { UncertainSubmissionError } from './mexcVenue';

/**
 * Step 12 live pilot (OPS-02): allowlist, approvals, activation, halts and readiness. Live order
 * submission stays disabled; nothing here opens the live transport.
 */

export type PilotRow = typeof livePilots.$inferSelect;

/** Pre-pilot checks an administrator must record (with evidence) before approval. */
export const PILOT_REQUIRED_CHECKS = {
  ELIGIBILITY_CONFIRMED: 'Written confirmation from MEXC that this account may place automated futures orders for this use',
  KYC_AND_KEY_PERMISSIONS: 'KYC complete; API key has only the permissions needed; IP whitelist set as required',
  READ_ONLY_CHECK: '`npm run ops:mexc-readonly-check` passed on the pilot account',
  POSITION_MODE: 'Account position mode recorded (one-way preferred) and matches the adapter configuration',
  CONTRACT_SPEC_MATCH: 'MEXC contract size, tick, step and minimum equal the platform instrument',
  ACCOUNT_FLAT_AT_START: 'No open position or resting order on the pilot contract at MEXC'
} as const;
export type PilotCheckId = keyof typeof PILOT_REQUIRED_CHECKS;
export type PilotChecks = Partial<Record<PilotCheckId, { passed: boolean; evidence: string; by: string; at: string }>>;

export const toScope = (p: PilotRow): PilotScope => ({
  status: p.status as PilotScope['status'],
  investorId: p.investorId,
  instrumentId: p.instrumentId,
  exchangeAccountRef: p.exchangeAccountRef,
  limits: { maxOrderContracts: p.maxOrderContracts, maxOrderNotionalUsdt: p.maxOrderNotionalUsdt, maxLeverage: p.maxLeverage, maxExposureUsdt: p.maxExposureUsdt },
  allowAdds: false,
  allowReversal: false,
  approvedAt: p.approvedAt,
  investorActivatedAt: p.investorActivatedAt,
  entriesHalted: p.entriesHalted,
  haltReason: p.haltReason
});

export async function openPilot(db: Executor): Promise<PilotRow | null> {
  const [p] = await db.select().from(livePilots).where(ne(livePilots.status, 'ENDED'));
  return p ?? null;
}

async function lockPilot(tx: Executor, id: string): Promise<PilotRow> {
  const [p] = await tx.select().from(livePilots).where(eq(livePilots.id, id)).for('update');
  if (!p) throw new DomainError(404, ErrorCode.NOT_FOUND, 'Live pilot not found.');
  return p;
}

const bump = { revision: sql`${livePilots.revision} + 1`, updatedAt: sql`now()` };

export interface PilotInput {
  investorId: string;
  instrumentId: string;
  exchangeAccountRef: string;
  maxOrderContracts: string;
  maxOrderNotionalUsdt: string;
  maxLeverage: number;
  maxExposureUsdt: string;
}

export async function createPilot(db: Db, adminId: string, input: PilotInput, correlationId = 'pilot'): Promise<PilotRow> {
  const issues = validatePilotLimits({ maxOrderContracts: input.maxOrderContracts, maxOrderNotionalUsdt: input.maxOrderNotionalUsdt, maxLeverage: input.maxLeverage, maxExposureUsdt: input.maxExposureUsdt });
  if (!input.exchangeAccountRef.trim() || /key|secret/i.test(input.exchangeAccountRef)) issues.push('exchangeAccountRef must be a non-secret account reference (e.g. UID suffix)');
  if (issues.length) throw new DomainError(400, ErrorCode.VALIDATION_FAILED, issues.join('; '));
  return db.transaction(async (tx) => {
    const [inv] = await tx.select().from(users).where(eq(users.id, input.investorId));
    if (!inv || inv.role !== 'INVESTOR' || inv.status !== 'ACTIVE') throw new DomainError(400, ErrorCode.VALIDATION_FAILED, 'The pilot investor must be an active investor.');
    const [inst] = await tx.select().from(instruments).where(eq(instruments.id, input.instrumentId));
    if (!inst || inst.status !== 'PUBLISHED' || !inst.exchangeSymbol) throw new DomainError(400, ErrorCode.VALIDATION_FAILED, 'The pilot contract must be a published instrument with a MEXC symbol.');
    if (await openPilot(tx)) throw new DomainError(409, ErrorCode.CONFLICT, 'A live pilot is already open. End it before creating another.');
    const [p] = await tx.insert(livePilots).values({ ...input, exchangeAccountRef: input.exchangeAccountRef.trim(), createdBy: adminId }).returning();
    await recordAudit(tx, { actorUserId: adminId, action: 'ADMIN_LIVE_PILOT_CREATE', targetType: 'live_pilot', targetId: p!.id, result: 'SUCCESS', after: { ...input }, correlationId });
    return p!;
  });
}

export async function recordPilotCheck(db: Db, adminId: string, id: string, check: PilotCheckId, r: { passed: boolean; evidence: string }, correlationId = 'pilot'): Promise<PilotRow> {
  if (!(check in PILOT_REQUIRED_CHECKS)) throw new DomainError(400, ErrorCode.VALIDATION_FAILED, `Unknown pilot check ${check}`);
  if (!r.evidence.trim()) throw new DomainError(400, ErrorCode.VALIDATION_FAILED, 'Evidence (a reference or note) is required.');
  return db.transaction(async (tx) => {
    const p = await lockPilot(tx, id);
    if (p.status === 'ENDED') throw new DomainError(409, ErrorCode.CONFLICT, 'The pilot has ended.');
    const checks = { ...(p.checks as PilotChecks), [check]: { passed: r.passed, evidence: r.evidence.trim().slice(0, 500), by: adminId, at: new Date().toISOString() } };
    const [u] = await tx.update(livePilots).set({ checks, ...bump }).where(eq(livePilots.id, id)).returning();
    await recordAudit(tx, { actorUserId: adminId, action: 'ADMIN_LIVE_PILOT_CHECK', targetType: 'live_pilot', targetId: id, result: 'SUCCESS', metadata: { check, passed: r.passed }, correlationId });
    return u!;
  });
}

export const missingChecks = (p: PilotRow) => (Object.keys(PILOT_REQUIRED_CHECKS) as PilotCheckId[]).filter((c) => !(p.checks as PilotChecks)[c]?.passed);

/** Platform authorization. Refused until every required check is recorded as passed. */
export async function approvePilot(db: Db, adminId: string, id: string, correlationId = 'pilot'): Promise<PilotRow> {
  return db.transaction(async (tx) => {
    const p = await lockPilot(tx, id);
    if (p.status !== 'DRAFT') throw new DomainError(409, ErrorCode.CONFLICT, `The pilot is ${p.status}, not DRAFT.`);
    const missing = missingChecks(p);
    if (missing.length) throw new DomainError(409, ErrorCode.CONFLICT, `Approval needs these checks recorded as passed: ${missing.join(', ')}`);
    const [u] = await tx.update(livePilots).set({ status: 'APPROVED', approvedBy: adminId, approvedAt: new Date(), ...bump }).where(eq(livePilots.id, id)).returning();
    await recordAudit(tx, { actorUserId: adminId, action: 'ADMIN_LIVE_PILOT_APPROVE', targetType: 'live_pilot', targetId: id, result: 'SUCCESS', metadata: { limits: toScope(u!).limits }, correlationId });
    return u!;
  });
}

/** Explicit investor activation. Only the allowlisted investor; block settings must fit the pilot. */
export async function activatePilot(db: Db, investorId: string, correlationId = 'pilot'): Promise<PilotRow> {
  return db.transaction(async (tx) => {
    const open = await openPilot(tx);
    if (!open || open.investorId !== investorId) throw new DomainError(404, ErrorCode.NOT_FOUND, 'No live pilot is offered to this account.');
    const p = await lockPilot(tx, open.id);
    if (p.status !== 'APPROVED') throw new DomainError(409, ErrorCode.CONFLICT, p.status === 'DRAFT' ? 'The pilot is not approved by the platform yet.' : `The pilot is ${p.status}.`);
    const blocks = await tx
      .select({ b: orderBlocks, oppositePolicy: strategyVersions.oppositePolicy })
      .from(orderBlocks)
      .innerJoin(strategyVersions, eq(strategyVersions.id, orderBlocks.strategyVersionId))
      .where(and(eq(orderBlocks.ownerId, investorId), eq(orderBlocks.instrumentId, p.instrumentId)));
    if (!blocks.length) throw new DomainError(409, ErrorCode.CONFLICT, 'Create Trade Settings for the pilot contract first.');
    const issues = blocks.flatMap(({ b, oppositePolicy }) => pilotBlockIssues({ allowAdds: b.allowAdds, leverage: b.leverage, instrumentId: b.instrumentId }, { oppositePolicy }, toScope(p)));
    if (issues.length) throw new DomainError(409, ErrorCode.CONFLICT, issues.join(' '));
    const [u] = await tx.update(livePilots).set({ status: 'ACTIVE', investorActivatedAt: new Date(), ...bump }).where(eq(livePilots.id, p.id)).returning();
    await recordAudit(tx, { actorUserId: investorId, action: 'LIVE_PILOT_ACTIVATE', targetType: 'live_pilot', targetId: p.id, result: 'SUCCESS', correlationId });
    return u!;
  });
}

/** The investor withdraws: no new entries; closing and protection stay available. */
export async function deactivatePilot(db: Db, investorId: string, correlationId = 'pilot'): Promise<PilotRow> {
  return db.transaction(async (tx) => {
    const open = await openPilot(tx);
    if (!open || open.investorId !== investorId) throw new DomainError(404, ErrorCode.NOT_FOUND, 'No live pilot is offered to this account.');
    const [u] = await tx.update(livePilots).set({ status: 'APPROVED', investorActivatedAt: null, ...bump }).where(eq(livePilots.id, open.id)).returning();
    await recordAudit(tx, { actorUserId: investorId, action: 'LIVE_PILOT_DEACTIVATE', targetType: 'live_pilot', targetId: open.id, result: 'SUCCESS', correlationId });
    return u!;
  });
}

/** Halts NEW entries. Any actor (operator, investor, or the system on a protection fault). */
export async function haltPilotEntries(db: Db | Executor, id: string, reason: string, actorUserId: string | null, correlationId = 'pilot'): Promise<void> {
  await db.update(livePilots).set({ entriesHalted: true, haltReason: reason.slice(0, 200), haltedAt: new Date(), ...bump }).where(and(eq(livePilots.id, id), eq(livePilots.entriesHalted, false)));
  await recordAudit(db, { actorUserId, action: 'LIVE_PILOT_HALT', targetType: 'live_pilot', targetId: id, result: 'SUCCESS', metadata: { reason }, correlationId });
}

/** Operator-only resume, refused while any order is unresolved or a position is unprotected. */
export async function resumePilotEntries(db: Db, adminId: string, id: string, note: string, correlationId = 'pilot'): Promise<PilotRow> {
  return db.transaction(async (tx) => {
    const p = await lockPilot(tx, id);
    if (!note.trim()) throw new DomainError(400, ErrorCode.VALIDATION_FAILED, 'A note confirming the review is required.');
    const [acct] = await tx.select({ id: paperAccounts.id }).from(paperAccounts).where(eq(paperAccounts.ownerId, p.investorId));
    if (acct) {
      const unresolved = await tx
        .select({ id: orderIntents.id })
        .from(orderIntents)
        .where(and(eq(orderIntents.paperAccountId, acct.id), eq(orderIntents.instrumentId, p.instrumentId), inArray(orderIntents.state, ['INTENT', 'SUBMITTING', 'ACKNOWLEDGED', 'PARTIALLY_FILLED', 'UNKNOWN'])));
      if (unresolved.length) throw new DomainError(409, ErrorCode.CONFLICT, `${unresolved.length} order(s) are unresolved; reconcile them before resuming entries.`);
      const unprotected = await tx
        .select({ id: positions.id })
        .from(positions)
        .where(and(eq(positions.paperAccountId, acct.id), eq(positions.instrumentId, p.instrumentId), eq(positions.status, 'OPEN'), ne(positions.protectionStatus, 'PROTECTED')));
      if (unprotected.length) throw new DomainError(409, ErrorCode.CONFLICT, 'An open position is not protected; restore its stop or close it before resuming entries.');
    }
    const [u] = await tx.update(livePilots).set({ entriesHalted: false, haltReason: null, haltedAt: null, ...bump }).where(eq(livePilots.id, id)).returning();
    await recordAudit(tx, { actorUserId: adminId, action: 'ADMIN_LIVE_PILOT_RESUME', targetType: 'live_pilot', targetId: id, result: 'SUCCESS', metadata: { note: note.slice(0, 300) }, correlationId });
    return u!;
  });
}

export async function endPilot(db: Db, adminId: string, id: string, correlationId = 'pilot'): Promise<PilotRow> {
  const [u] = await db.update(livePilots).set({ status: 'ENDED', endedAt: new Date(), entriesHalted: true, haltReason: 'Pilot ended', ...bump }).where(eq(livePilots.id, id)).returning();
  if (!u) throw new DomainError(404, ErrorCode.NOT_FOUND, 'Live pilot not found.');
  await recordAudit(db, { actorUserId: adminId, action: 'ADMIN_LIVE_PILOT_END', targetType: 'live_pilot', targetId: id, result: 'SUCCESS', correlationId });
  return u;
}

/* ───────────────────────── Readiness ───────────────────────── */

export type ReadinessState = 'PASS' | 'MISSING' | 'BLOCKED_IN_THIS_BUILD';
export interface ReadinessItem {
  id: string;
  label: string;
  state: ReadinessState;
  /** FIRST_TRADE: needed before the first supervised order. EXPANSION: needed before widening access. */
  stage: 'FIRST_TRADE' | 'EXPANSION';
  detail?: string;
}

const FIRST_TRADE_CAPS: CapabilityId[] = ['SIGNED_REQUESTS', 'READ_BALANCES', 'READ_POSITIONS', 'READ_POSITION_MODE', 'ACCOUNT_ELIGIBILITY'];

/**
 * What stands between this pilot and (a) its first supervised order and (b) wider live access.
 * The first order is itself the live evidence for the order capabilities, so those are listed
 * under EXPANSION; reads and eligibility must be verified before the first order.
 */
export function pilotReadiness(p: PilotRow | null): { readyForFirstTrade: boolean; readyForExpansion: boolean; items: ReadinessItem[] } {
  const items: ReadinessItem[] = [];
  const add = (id: string, label: string, ok: boolean, stage: ReadinessItem['stage'], detail?: string, blocked = false) =>
    items.push({ id, label, state: ok ? 'PASS' : blocked ? 'BLOCKED_IN_THIS_BUILD' : 'MISSING', stage, detail });

  add('PILOT_DEFINED', 'A pilot allowlist exists (one investor, one MEXC account, one contract, approved limits)', !!p, 'FIRST_TRADE');
  for (const [id, label] of Object.entries(PILOT_REQUIRED_CHECKS)) add(id, label, !!p && !!(p.checks as PilotChecks)[id as PilotCheckId]?.passed, 'FIRST_TRADE', p ? (p.checks as PilotChecks)[id as PilotCheckId]?.evidence : undefined);
  add('PLATFORM_APPROVAL', 'Platform authorization (administrator approval)', !!p?.approvedAt, 'FIRST_TRADE');
  add('INVESTOR_ACTIVATION', 'Explicit investor activation', !!p?.investorActivatedAt && p.status === 'ACTIVE', 'FIRST_TRADE');
  add('ENTRIES_NOT_HALTED', 'New entries not halted', !!p && !p.entriesHalted, 'FIRST_TRADE', p?.haltReason ?? undefined);
  for (const c of FIRST_TRADE_CAPS) add(`CAP_${c}`, `Verified on the pilot account: ${MEXC_CAPABILITIES.find((x) => x.id === c)!.summary}`, livePilotVerified(c), 'FIRST_TRADE');
  add('CREDENTIAL_STORE', 'Encrypted, access-restricted storage for the pilot API key (OPS-01)', false, 'FIRST_TRADE', 'Not built: no exchange credentials can be stored in this build', true);
  add('LIVE_MODE_ALLOWED', 'LIVE mode allowed for the pilot investor’s order block', (ALLOWED_MODES as readonly string[]).includes('LIVE'), 'FIRST_TRADE', 'ALLOWED_MODES is PAPER only', true);
  add('LIVE_VENUE_WIRING', 'venueForMode(LIVE) builds the pilot-guarded MEXC venue', false, 'FIRST_TRADE', 'Intentionally not wired: LIVE fails closed', true);
  add('BUILD_GATE', 'Build gate open (LIVE_ACTIVATION_ALLOWED_IN_THIS_BUILD) under review', LIVE_ACTIVATION_ALLOWED_IN_THIS_BUILD, 'FIRST_TRADE', 'Closed in this build', true);
  add('FIRST_TRADE_APPROVAL', 'Operator approval of the first supervised trade (separate, per trade)', false, 'FIRST_TRADE', 'Not given');
  for (const c of MEXC_CAPABILITIES.filter((x) => !FIRST_TRADE_CAPS.includes(x.id))) add(`CAP_${c.id}`, `Live-pilot evidence: ${c.summary}`, livePilotVerified(c.id), 'EXPANSION');
  add('PRIVATE_SYNC', 'Scheduled private sync of balances, positions, fills and funding (REP-01) and drift detection (OPS-03)', false, 'EXPANSION', 'Not built', true);

  const firstTrade = items.filter((i) => i.stage === 'FIRST_TRADE');
  return { readyForFirstTrade: firstTrade.every((i) => i.state === 'PASS'), readyForExpansion: items.every((i) => i.state === 'PASS'), items };
}

/* ───────────────────────── Pilot-guarded venue ───────────────────────── */

export interface PilotGuardEvent {
  kind: 'ENTRY_REFUSED' | 'ENTRY_SENT' | 'HALTED';
  reason: string;
  at: Date;
}

/**
 * Wraps the MEXC venue for the pilot. Opening orders pass the pilot rules (allowlist, approvals,
 * activation, halt, limits, no adds); everything else — lookups, closes, stop resize and cancel —
 * passes through untouched, so protection and closing are never blocked. A missing or unverified
 * stop, or an uncertain submission, halts new entries automatically.
 */
export function pilotGuardedVenue(db: Db, inner: ExecutionVenue, o: { onEvent?: (e: PilotGuardEvent) => void } = {}): ExecutionVenue {
  const emit = (e: Omit<PilotGuardEvent, 'at'>) => o.onEvent?.({ ...e, at: new Date() });
  const halt = async (reason: string) => {
    const p = await openPilot(db);
    if (p) await haltPilotEntries(db, p.id, reason, null, 'pilot-guard');
    emit({ kind: 'HALTED', reason });
  };
  return {
    ...inner,
    async placeOpeningOrderWithStop(r) {
      const p = await openPilot(db);
      const [acct] = await db.select({ ownerId: paperAccounts.ownerId }).from(paperAccounts).where(eq(paperAccounts.id, r.paperAccountId));
      const [inst] = await db.select({ multiplier: instruments.contractMultiplier }).from(instruments).where(eq(instruments.id, r.instrumentId));
      const held = await inner.position(r.paperAccountId, r.instrumentId);
      const verdict = checkPilotEntry(p ? toScope(p) : null, {
        investorId: acct?.ownerId ?? '',
        instrumentId: r.instrumentId,
        contracts: r.contracts,
        price: r.side === 'LONG' ? r.quote.ask : r.quote.bid,
        multiplier: inst?.multiplier ?? '0',
        leverage: r.leverage ?? Number.MAX_SAFE_INTEGER,
        hasStop: !!r.stop,
        openContracts: held.contracts
      });
      if (!verdict.ok) {
        emit({ kind: 'ENTRY_REFUSED', reason: verdict.reason });
        return { status: 'REJECTED', orderId: '', clientOrderId: r.clientOrderId, reason: verdict.reason };
      }
      emit({ kind: 'ENTRY_SENT', reason: r.clientOrderId });
      let result;
      try {
        result = await inner.placeOpeningOrderWithStop(r);
      } catch (e) {
        if (e instanceof UncertainSubmissionError) await halt(`UNCERTAIN_ORDER ${r.clientOrderId}`);
        throw e;
      }
      if (result.status === 'FILLED') {
        const prot = await inner.inspectProtection(result.stop.orderId, r.instrumentId);
        if (!prot || prot.status !== 'ACTIVE') await halt(`PROTECTION_FAILURE ${r.clientOrderId}`);
      }
      return result;
    }
  };
}

/** Keeps the pilot halted until the operator reviews: called on any unresolved-order alarm. */
export async function pilotForInvestor(db: Executor, investorId: string): Promise<PilotRow | null> {
  const p = await openPilot(db);
  return p && p.investorId === investorId ? p : null;
}
