import { randomUUID } from 'node:crypto';
import { and, asc, eq, inArray, ne, sql } from 'drizzle-orm';
import {
  advanceTrailing,
  basisPrice,
  Decimal,
  EXIT_REASON_TEXT,
  marginRelease,
  planTargets,
  realizedPnl,
  takeProfitReached,
  targetStatusAfter,
  type ExitReason,
  type PriceBasis,
  type TrailingState
} from '@trendpilot/domain';
import type { QuoteChannel } from '@trendpilot/domain';
import type { Db, Executor } from '../client';
import { completeJob, enqueueJob, type JobRow } from '../jobs';
import { fills, instruments, marketQuotes, orderIntents, positionExits, positions, positionTargets } from '../schema';
import { book } from './accounts';
import { latestQuote } from './market';
import { paperVenue } from '../venue/paper';
import { resolveVenue } from '../venue/select';
import type { ExecutionVenue } from '../venue/types';
import { listStopFills, triggerStops, type CloseResult, type VenueQuote } from './simulator';

/**
 * Paper exits (EXT-01 stop loss, EXT-02/03 fixed and split TP, EXT-04 trailing stop, EXT-05
 * signal/manual close, EXT-06 races, STR-06 the closing leg of a reversal).
 *
 * - Every exit except a venue-triggered stop is a persisted CLOSE intent with a stable client
 *   order ID, committed before anything is sent. The unique "one unresolved operation per
 *   scope" index serialises exits per position (ARC-02), which also caps the aggregate closing
 *   quantity: a second exit can only be requested after the first is reconciled.
 * - Closes are reduce-only at the venue, capped at the confirmed remaining quantity, so a close
 *   can never flip the position.
 * - Results are recorded once per venue fill (unique fill ID): realized P&L, fee and margin
 *   release are ledger rows that can only be booked once. Target progress moves only on
 *   confirmed fills — a touched target is not a fill.
 * - The stop is resized after every partial exit and cleared only after the venue confirms zero.
 * - The trailing stop is a software trigger with persisted activation, watermark and level; the
 *   original venue stop stays in place as protection while any quantity is open.
 */

export const PAPER_CLOSE_JOB = 'paper.close';
export const MARKET_TICK_JOB = 'market.tick';
/** STR-06: the opening leg of a reversal, evaluated only after the close is terminal. */
export const PAPER_REVERSE_JOB = 'paper.reverse';

type PositionRow = typeof positions.$inferSelect;
type IntentRow = typeof orderIntents.$inferSelect;
type TargetRow = typeof positionTargets.$inferSelect;
const UNRESOLVED = ['INTENT', 'SUBMITTING', 'ACKNOWLEDGED', 'PARTIALLY_FILLED', 'UNKNOWN'] as const;
const D = (v: Decimal.Value) => new Decimal(v);

export type ExitRequestResult = { status: 'REQUESTED'; intentId: string } | { status: 'IN_PROGRESS'; intentId: string | null } | { status: 'NOT_OPEN' };

/**
 * Persists a CLOSE intent and its job (caller's transaction). One unresolved operation per
 * position scope. `contracts` defaults to the whole confirmed remaining quantity.
 */
export async function requestExit(
  tx: Executor,
  input: {
    position: PositionRow;
    reason: ExitReason;
    now: Date;
    contracts?: string;
    targetLevelId?: string | null;
    decisionId?: string | null;
    eventId?: string | null;
    idempotencyKey?: string | null;
    requestedBy?: string | null;
  }
): Promise<ExitRequestResult> {
  const p = input.position;
  if (p.status !== 'OPEN' || D(p.contracts).lte(0)) return { status: 'NOT_OPEN' };
  const contracts = Decimal.min(input.contracts ?? p.contracts, p.contracts);
  if (contracts.lte(0)) return { status: 'NOT_OPEN' };
  const [busy] = await tx
    .select({ id: orderIntents.id })
    .from(orderIntents)
    .where(and(eq(orderIntents.paperAccountId, p.paperAccountId), eq(orderIntents.instrumentId, p.instrumentId), eq(orderIntents.mode, p.mode), inArray(orderIntents.state, [...UNRESOLVED])));
  if (busy) return { status: 'IN_PROGRESS', intentId: busy.id };
  const [row] = await tx
    .insert(orderIntents)
    .values({
      ownerId: p.ownerId,
      paperAccountId: p.paperAccountId,
      orderBlockId: p.orderBlockId,
      decisionId: input.decisionId ?? null,
      eventId: input.eventId ?? null,
      instrumentId: p.instrumentId,
      mode: p.mode,
      kind: 'CLOSE',
      side: p.side,
      positionId: p.id,
      exitReason: input.reason,
      targetLevelId: input.targetLevelId ?? null,
      idempotencyKey: input.idempotencyKey ?? null,
      requestedBy: input.requestedBy ?? null,
      clientOrderId: `tpx-${randomUUID()}`,
      contracts: contracts.toFixed(),
      quantity: D(p.quantity).times(contracts).div(p.contracts).toFixed(),
      expectedPrice: p.avgEntryPrice,
      stopPrice: p.stopPrice,
      stopBasis: p.stopBasis,
      leverage: p.leverage,
      marginMode: p.marginMode,
      reservedUsdt: '0',
      sizing: {},
      settingsSnapshot: p.settingsSnapshot
    })
    .onConflictDoNothing()
    .returning({ id: orderIntents.id });
  if (!row) return { status: 'IN_PROGRESS', intentId: null }; // a concurrent request won the scope
  await enqueueJob(tx, { kind: PAPER_CLOSE_JOB, dedupeKey: `${PAPER_CLOSE_JOB}:${row.id}`, payload: { intentId: row.id }, runAfter: input.now });
  return { status: 'REQUESTED', intentId: row.id };
}

/**
 * Records one confirmed exit fill against a locked position, exactly once. Afterwards the
 * target (if any) advances by the confirmed quantity, the venue protection is resized
 * (partial) or, once the venue confirms zero, cleared.
 */
export async function recordExitFill(
  db: Db,
  tx: Executor,
  input: { position: PositionRow; fill: { fillId: string; contracts: string; price: string; fee: string; filledAt: Date }; reason: ExitReason; intentId: string | null; targetLevelId?: string | null; now: Date; venue?: ExecutionVenue }
): Promise<{ recorded: boolean; remaining: string; closed: boolean }> {
  const p = input.position;
  const venue = input.venue ?? paperVenue(db);
  const [inst] = await tx.select().from(instruments).where(eq(instruments.id, p.instrumentId));
  const before = D(p.contracts);
  const qty = Decimal.min(input.fill.contracts, before); // never more than the managed quantity
  const remaining = before.minus(qty);
  const pnl = realizedPnl(p.side as 'LONG' | 'SHORT', p.avgEntryPrice, input.fill.price, qty.toFixed(), inst!.contractMultiplier);
  const release = marginRelease(p.marginUsdt, before.toFixed(), qty.toFixed());

  const [exit] = await tx
    .insert(positionExits)
    .values({
      ownerId: p.ownerId,
      paperAccountId: p.paperAccountId,
      positionId: p.id,
      intentId: input.intentId,
      reason: input.reason,
      exchangeFillId: input.fill.fillId,
      contracts: qty.toFixed(),
      price: input.fill.price,
      fee: input.fill.fee,
      realizedPnl: pnl,
      marginReleased: release,
      remainingContracts: remaining.toFixed(),
      filledAt: input.fill.filledAt
    })
    .onConflictDoNothing({ target: [positionExits.paperAccountId, positionExits.exchangeFillId] })
    .returning({ id: positionExits.id });
  if (!exit) return { recorded: false, remaining: D(p.contracts).toFixed(), closed: p.status === 'CLOSED' };

  const account = { id: p.paperAccountId, ownerId: p.ownerId };
  await book(tx, account, [
    { kind: 'REALIZED_PNL', bucket: 'WALLET', amount: pnl, refType: 'fill', refId: input.fill.fillId, memo: `Realized P&L (${input.reason})` },
    { kind: 'TRADING_FEE', bucket: 'WALLET', amount: D(input.fill.fee).neg().toFixed(), refType: 'fill', refId: input.fill.fillId, memo: 'Simulated taker fee (exit)' },
    { kind: 'POSITION_MARGIN_RELEASE', bucket: 'POSITION_MARGIN', amount: D(release).neg().toFixed(), refType: 'fill', refId: input.fill.fillId, memo: 'Margin released by exit' }
  ]);

  // EXT-03: the target advances by the confirmed fill only (capped at its planned share).
  if (input.targetLevelId) {
    const [t] = await tx.select().from(positionTargets).where(and(eq(positionTargets.positionId, p.id), eq(positionTargets.levelId, input.targetLevelId))).for('update');
    if (t) {
      const filled = Decimal.min(D(t.filledContracts).plus(qty), t.plannedContracts);
      const status = targetStatusAfter(t.plannedContracts, filled.toFixed(), false);
      await tx
        .update(positionTargets)
        .set({ filledContracts: filled.toFixed(), status, completedAt: status === 'DONE' ? input.fill.filledAt : null, updatedAt: sql`now()` })
        .where(eq(positionTargets.id, t.id));
    }
  }

  let protection: { status: 'PROTECTED' | 'UNPROTECTED' | 'PENDING'; stopContracts: string | null } = { status: p.protectionStatus, stopContracts: p.stopContracts };
  let closed = false;
  const stopId = p.stopOrderRef ? await venue.stopOrderIdFor(p.stopOrderRef, tx) : null;
  let newStopRef: string | null = null;
  if (remaining.isZero()) {
    // Confirm zero at the venue before clearing the stop and closing the position.
    const held = await venue.position(p.paperAccountId, p.instrumentId, tx);
    if (D(held.contracts).isZero()) {
      if (stopId) await venue.cancelOrder(stopId, p.instrumentId);
      const s = stopId ? await venue.inspectProtection(stopId, p.instrumentId) : null;
      closed = !s || s.status !== 'ACTIVE';
      protection = { status: 'PENDING', stopContracts: '0' };
    }
  } else if (stopId) {
    // Partial: keep stop coverage for exactly the remainder, then verify (EXT-03). A live venue may
    // replace the stop order; the position then follows the new reference.
    let current = stopId;
    try {
      current = await venue.resizeProtection(stopId, remaining.toFixed(), p.instrumentId);
    } catch {
      current = stopId; // verified below: a stop that was not resized leaves the position UNPROTECTED
    }
    if (current !== stopId) newStopRef = current;
    const s = await venue.inspectProtection(current, p.instrumentId);
    const ok = !!s && s.status === 'ACTIVE' && D(s.contracts).eq(remaining);
    protection = { status: ok ? 'PROTECTED' : 'UNPROTECTED', stopContracts: s?.contracts ?? null };
  }

  await tx
    .update(positions)
    .set({
      contracts: remaining.toFixed(),
      quantity: remaining.times(inst!.contractMultiplier).toFixed(),
      marginUsdt: D(p.marginUsdt).minus(release).toFixed(),
      realizedPnlUsdt: D(p.realizedPnlUsdt).plus(pnl).toFixed(),
      feesUsdt: D(p.feesUsdt).plus(input.fill.fee).toFixed(),
      stopContracts: protection.stopContracts,
      protectionStatus: protection.status,
      ...(newStopRef ? { stopOrderRef: newStopRef } : {}),
      protectionVerifiedAt: input.now,
      ...(closed ? { status: 'CLOSED' as const, closeReason: input.reason, closedAt: input.fill.filledAt } : {}),
      updatedAt: sql`now()`
    })
    .where(eq(positions.id, p.id));
  // Targets not reached before the position closed are cancelled (their quantity is gone).
  if (closed) {
    await tx
      .update(positionTargets)
      .set({ status: 'CANCELLED', updatedAt: sql`now()` })
      .where(and(eq(positionTargets.positionId, p.id), ne(positionTargets.status, 'DONE')));
  }
  return { recorded: true, remaining: remaining.toFixed(), closed };
}

/** A target whose close ended without a fill returns to PENDING/PARTIAL so it can resume. */
async function releaseTarget(tx: Executor, intent: IntentRow) {
  if (!intent.targetLevelId || !intent.positionId) return;
  await tx
    .update(positionTargets)
    .set({ status: sql`CASE WHEN ${positionTargets.filledContracts} > 0 THEN 'PARTIAL' ELSE 'PENDING' END`, updatedAt: sql`now()` })
    .where(and(eq(positionTargets.positionId, intent.positionId), eq(positionTargets.levelId, intent.targetLevelId), eq(positionTargets.status, 'REQUESTED')));
}

/** STR-06: once the closing leg of a reversal is terminal, evaluate the opening leg. */
async function scheduleReversal(tx: Executor, intent: IntentRow, now: Date): Promise<boolean> {
  if (intent.exitReason !== 'REVERSAL_CLOSE' || !intent.eventId) return false;
  await enqueueJob(tx, { kind: PAPER_REVERSE_JOB, dedupeKey: `${PAPER_REVERSE_JOB}:${intent.id}`, payload: { closeIntentId: intent.id }, runAfter: now });
  return true;
}

/* ─────────────────────────── paper.close ─────────────────────────── */

export interface CloseHooks {
  afterSimulatorFill?: () => void | Promise<void>;
  /** Test seam: execute through this venue (e.g. the MEXC adapter over a mocked exchange). Refused in production. */
  venue?: ExecutionVenue;
}

export interface CloseSummary {
  intentId: string;
  positionId: string;
  state: string;
  reason?: string;
  exitReason?: string;
  targetLevelId?: string | null;
  filled?: string;
  remaining?: string;
  closed?: boolean;
  reconciled: boolean;
  /** Next exit requested right after a full fill (e.g. the next split target). */
  next?: string;
  reversalQueued?: boolean;
}

export async function quoteFor(db: Db | Executor, instrumentId: string, now: Date): Promise<VenueQuote | null> {
  const q = await latestQuote(db, instrumentId, now);
  if (!q) return null;
  const [row] = await db
    .select({ last: marketQuotes.last, liquidity: marketQuotes.liquidityContracts })
    .from(marketQuotes)
    .where(and(eq(marketQuotes.instrumentId, instrumentId), eq(marketQuotes.asOf, q.asOf)));
  return { bid: q.bid, ask: q.ask, mark: q.mark, last: row?.last ?? q.mark, liquidityContracts: row?.liquidity ?? null };
}

export async function processPaperClose(db: Db, job: JobRow, now: Date, hooks: CloseHooks = {}): Promise<CloseSummary> {
  const { intentId } = job.payload as { intentId: string };

  const step = await db.transaction(async (tx) => {
    const [intent] = await tx.select().from(orderIntents).where(eq(orderIntents.id, intentId)).for('update');
    if (!intent || intent.kind !== 'CLOSE') throw new Error(`Close intent ${intentId} not found.`);
    if (!['INTENT', 'SUBMITTING'].includes(intent.state)) {
      await scheduleReversal(tx, intent, now);
      await completeJob(tx, job);
      return { kind: 'done' as const, intent };
    }
    const [pos] = await tx.select().from(positions).where(eq(positions.id, intent.positionId!)).for('update');
    const finish = async (state: 'CANCELLED' | 'REJECTED', reason: string) => {
      await tx.update(orderIntents).set({ state, stateReason: reason, resolvedAt: now, updatedAt: sql`now()` }).where(eq(orderIntents.id, intent.id));
      await releaseTarget(tx, intent);
      const reversalQueued = await scheduleReversal(tx, intent, now);
      await completeJob(tx, job);
      return { kind: 'stopped' as const, intent, reason, state, reversalQueued };
    };
    // IAM-02 in the worker too: the request's owner must own the position.
    if (!pos || pos.ownerId !== intent.ownerId) return finish('REJECTED', 'OWNERSHIP_MISMATCH');
    if (intent.state === 'SUBMITTING') return { kind: 'reconcile' as const, intent, pos };
    if (pos.status !== 'OPEN' || D(pos.contracts).lte(0)) return finish('CANCELLED', 'POSITION_ALREADY_FLAT');
    // EXT-06: recheck the confirmed remaining quantity right before submission.
    const contracts = Decimal.min(intent.contracts, pos.contracts).toFixed();
    await tx.update(orderIntents).set({ state: 'SUBMITTING', contracts, submittedAt: now, updatedAt: sql`now()` }).where(eq(orderIntents.id, intent.id));
    return { kind: 'submit' as const, intent: { ...intent, contracts }, pos };
  });

  const base = { intentId, exitReason: step.intent.exitReason ?? undefined, targetLevelId: step.intent.targetLevelId };
  if (step.kind === 'done') return { ...base, positionId: step.intent.positionId!, state: step.intent.state, reconciled: false };
  if (step.kind === 'stopped') return { ...base, positionId: step.intent.positionId!, state: step.state, reason: step.reason, reconciled: false, reversalQueued: step.reversalQueued };

  const { intent, pos } = step;
  const venue = resolveVenue(db, intent.mode, hooks.venue);
  let result: CloseResult | null = null;
  let reconciled = false;
  if (step.kind === 'reconcile') {
    result = await venue.lookupCloseOrder(intent.clientOrderId, pos.instrumentId);
    reconciled = result !== null;
    const grace = (venue as { reconcileGraceMs?: number }).reconcileGraceMs ?? 0;
    const waited = now.getTime() - (intent.submittedAt?.getTime() ?? 0);
    if (!result && grace > 0 && waited < grace) throw new Error(`Close ${intent.clientOrderId} not visible at the venue yet (${Math.round(waited / 1000)} s); reconciling before any resubmission.`);
  }
  if (!result) {
    const q = await quoteFor(db, pos.instrumentId, now);
    if (!q) throw new Error('No venue quote available for the close.');
    const [inst] = await db.select().from(instruments).where(eq(instruments.id, pos.instrumentId));
    result = await venue.placeReduceOnlyClose({
      paperAccountId: pos.paperAccountId,
      clientOrderId: intent.clientOrderId,
      instrumentId: pos.instrumentId,
      positionSide: pos.side as 'LONG' | 'SHORT',
      contracts: intent.contracts,
      contract: { multiplier: inst!.contractMultiplier, qtyStep: inst!.qtyStep, takerFeeRate: inst!.takerFeeRate },
      quote: q,
      now,
      marginMode: pos.marginMode as 'ISOLATED' | 'CROSS'
    });
    if (result.status !== 'REJECTED') await hooks.afterSimulatorFill?.();
  }

  return db.transaction(async (tx) => {
    const [cur] = await tx.select().from(orderIntents).where(eq(orderIntents.id, intent.id)).for('update');
    const [p] = await tx.select().from(positions).where(eq(positions.id, pos.id)).for('update');
    if (cur!.state !== 'SUBMITTING') {
      await completeJob(tx, job);
      return { ...base, positionId: pos.id, state: cur!.state, reconciled };
    }
    if (result!.status === 'REJECTED') {
      // e.g. the venue stop already flattened the position: reduce-only refuses to open the other side.
      await tx.update(orderIntents).set({ state: 'REJECTED', stateReason: result!.reason, resolvedAt: now, updatedAt: sql`now()` }).where(eq(orderIntents.id, intent.id));
      await releaseTarget(tx, cur!);
      const reversalQueued = await scheduleReversal(tx, cur!, now);
      await completeJob(tx, job);
      return { ...base, positionId: pos.id, state: 'REJECTED', reason: result!.reason, reconciled, reversalQueued };
    }
    const f = result!.fill;
    await tx
      .insert(fills)
      .values({ ownerId: cur!.ownerId, paperAccountId: cur!.paperAccountId, intentId: cur!.id, exchangeFillId: f.fillId, side: cur!.side === 'LONG' ? 'SHORT' : 'LONG', contracts: f.contracts, price: f.price, fee: f.fee, filledAt: f.filledAt })
      .onConflictDoNothing();
    const rec = await recordExitFill(db, tx, { position: p!, fill: f, reason: cur!.exitReason as ExitReason, intentId: cur!.id, targetLevelId: cur!.targetLevelId, now, venue });
    const full = result!.status === 'FILLED';
    await tx
      .update(orderIntents)
      .set({ state: full ? 'FILLED' : 'EXPIRED', stateReason: full ? null : 'PARTIAL_FILL_REMAINDER_EXPIRED', filledContracts: f.contracts, resolvedAt: now, updatedAt: sql`now()` })
      .where(eq(orderIntents.id, cur!.id));
    const reversalQueued = await scheduleReversal(tx, cur!, now);
    // After a full fill the scope is free again: act on the latest price right away (e.g. the
    // next split target or a trailing trigger reached by the same move). After a partial fill
    // the next price is awaited instead — the expired remainder had no liquidity.
    let next: string | undefined;
    if (full && !rec.closed && cur!.exitReason !== 'REVERSAL_CLOSE') {
      const [after] = await tx.select().from(positions).where(eq(positions.id, pos.id)).for('update');
      const q = await quoteFor(tx, pos.instrumentId, now);
      if (after && q) next = (await evaluatePositionExits(tx, after, q, now)).requested ?? undefined;
    }
    await completeJob(tx, job);
    return {
      ...base,
      positionId: pos.id,
      state: full ? 'FILLED' : 'EXPIRED',
      filled: D(f.contracts).toFixed(),
      remaining: rec.remaining,
      closed: rec.closed,
      reconciled,
      ...(full ? {} : { reason: 'PARTIAL_FILL' }),
      ...(next ? { next } : {}),
      ...(reversalQueued ? { reversalQueued } : {})
    };
  });
}

/* ─────────────────────────── targets and trailing ─────────────────────────── */

/** Targets for a position (created at entry; derived from the saved plan for older rows). */
async function targetsFor(tx: Executor, p: PositionRow): Promise<TargetRow[]> {
  const rows = await tx.select().from(positionTargets).where(eq(positionTargets.positionId, p.id)).orderBy(asc(positionTargets.ordinal)).for('update');
  if (rows.length) return rows;
  const snap = p.settingsSnapshot as { block?: { takeProfit?: { mode: 'FIXED' | 'SPLIT' | 'OFF'; levels: { id: string; movePct: string; closePct: string }[] } } };
  const tp = snap.block?.takeProfit;
  if (!tp || tp.mode === 'OFF') return [];
  const [inst] = await tx.select().from(instruments).where(eq(instruments.id, p.instrumentId));
  const planned = planTargets(p.side as 'LONG' | 'SHORT', p.avgEntryPrice, p.initialContracts, tp, { priceTick: inst!.priceTick, qtyStep: inst!.qtyStep });
  if (!planned.length) return [];
  await tx
    .insert(positionTargets)
    .values(planned.map((t) => ({ ownerId: p.ownerId, positionId: p.id, ...t, triggerBasis: p.takeProfitBasis ?? p.stopBasis })))
    .onConflictDoNothing();
  return tx.select().from(positionTargets).where(eq(positionTargets.positionId, p.id)).orderBy(asc(positionTargets.ordinal)).for('update');
}

export interface PositionExitStep {
  requested: ExitReason | null;
  inProgress: boolean;
  trailingActivated: boolean;
  trailingTightened: boolean;
  trailingTriggered: boolean;
}

/**
 * Software exit triggers for one locked, open position at one price (caller's transaction):
 * trailing stop first (it protects), then the first unfinished target that is reached. At most
 * one close is requested — exits are serialised per position.
 */
export async function evaluatePositionExits(tx: Executor, p: PositionRow, quote: VenueQuote, now: Date): Promise<PositionExitStep> {
  const out: PositionExitStep = { requested: null, inProgress: false, trailingActivated: false, trailingTightened: false, trailingTriggered: false };
  if (p.status !== 'OPEN' || D(p.contracts).lte(0)) return out;
  const side = p.side as 'LONG' | 'SHORT';

  if (p.trailingStatus !== 'OFF' && p.trailingDistancePct && p.trailingBasis) {
    const [inst] = await tx.select({ tick: instruments.priceTick }).from(instruments).where(eq(instruments.id, p.instrumentId));
    const state: TrailingState = { status: p.trailingStatus as 'WAITING' | 'ACTIVE', activationPrice: p.trailingActivationPrice, watermark: p.trailingWatermark, level: p.trailingStopPrice };
    const step = advanceTrailing(side, state, basisPrice(quote, p.trailingBasis as PriceBasis), { distancePct: p.trailingDistancePct, tick: inst!.tick });
    if (step.state !== state) {
      await tx
        .update(positions)
        .set({
          trailingStatus: step.state.status,
          trailingWatermark: step.state.watermark,
          trailingStopPrice: step.state.level,
          ...(step.activated ? { trailingActivatedAt: now } : {}),
          trailingUpdatedAt: now,
          updatedAt: sql`now()`
        })
        .where(eq(positions.id, p.id));
    }
    out.trailingActivated = step.activated;
    out.trailingTightened = step.tightened && !step.activated;
    if (step.triggered) {
      out.trailingTriggered = true;
      const r = await requestExit(tx, { position: p, reason: 'TRAILING_STOP', now });
      if (r.status === 'REQUESTED') out.requested = 'TRAILING_STOP';
      else out.inProgress = r.status === 'IN_PROGRESS';
      return out;
    }
  }

  for (const t of await targetsFor(tx, p)) {
    if (t.status === 'DONE' || t.status === 'CANCELLED' || D(t.plannedContracts).lte(0)) continue;
    if (!takeProfitReached(side, basisPrice(quote, t.triggerBasis as PriceBasis), t.triggerPrice)) break; // later targets are further
    if (t.status === 'REQUESTED') {
      out.inProgress = true; // its order is not reconciled yet
      break;
    }
    // EXT-07: an unfilled target resumes only for its remaining quantity.
    const want = Decimal.min(D(t.plannedContracts).minus(t.filledContracts), p.contracts);
    if (want.lte(0)) continue;
    const r = await requestExit(tx, { position: p, reason: 'TAKE_PROFIT', now, contracts: want.toFixed(), targetLevelId: t.levelId });
    if (r.status === 'REQUESTED') {
      await tx
        .update(positionTargets)
        .set({ status: 'REQUESTED', requestedContracts: D(t.requestedContracts).plus(want).toFixed(), updatedAt: sql`now()` })
        .where(eq(positionTargets.id, t.id));
      out.requested = 'TAKE_PROFIT';
    } else out.inProgress = r.status === 'IN_PROGRESS';
    break;
  }
  return out;
}

/* ─────────────────────────── market.tick ─────────────────────────── */

export interface TickSummary {
  instrumentId: string;
  stopsTriggered: number;
  stopExitsRecorded: number;
  takeProfitsRequested: number;
  trailingActivated: number;
  trailingTightened: number;
  trailingStopsRequested: number;
  /** A trigger fired but an exit for that position was still in flight (serialised). */
  exitsWaiting: number;
}

/** Postgres NOTIFY channel carrying every stored quote (payload: QuoteNotification JSON). */
export const QUOTE_NOTIFY_CHANNEL = 'market_quote';

export interface QuoteNotification {
  instrumentId: string;
  asOf: string;
  bid: string;
  ask: string;
  mark: string;
  last: string;
  source: string;
  channel: string | null;
  /** Feed-process receipt time. */
  receivedAt: string;
}

/**
 * Stores one quote and queues the `market.tick` job that runs stops, targets and trailing on it.
 * Fixture ticks (CLI, tests) default to source FIXTURE; the public feed passes MEXC_PUBLIC.
 */
export async function recordMarketTick(
  db: Db,
  t: {
    instrumentId: string;
    asOf: Date;
    bid: string;
    ask: string;
    mark: string;
    last: string;
    liquidityContracts?: string | null;
    source?: 'FIXTURE' | 'MEXC_PUBLIC';
    /** MEXC_PUBLIC transport (WS, REST_FALLBACK, REST_POLL). */
    channel?: QuoteChannel | null;
    /** When the feed process received it (for end-to-end latency); defaults to now. */
    receivedAt?: Date;
  }
): Promise<void> {
  const source = t.source ?? 'FIXTURE';
  const channel = t.channel ?? null;
  await db.transaction(async (tx) => {
    await tx
      .insert(marketQuotes)
      .values({ instrumentId: t.instrumentId, asOf: t.asOf, bid: t.bid, ask: t.ask, mark: t.mark, last: t.last, liquidityContracts: t.liquidityContracts ?? null, source, channel })
      .onConflictDoUpdate({ target: [marketQuotes.instrumentId, marketQuotes.asOf], set: { bid: t.bid, ask: t.ask, mark: t.mark, last: t.last, liquidityContracts: t.liquidityContracts ?? null, source, channel } });
    // Delivered to LISTENers (the web app's live quote stream) when this transaction commits.
    const note: QuoteNotification = { instrumentId: t.instrumentId, asOf: t.asOf.toISOString(), bid: t.bid, ask: t.ask, mark: t.mark, last: t.last, source, channel, receivedAt: (t.receivedAt ?? new Date()).toISOString() };
    await tx.execute(sql`select pg_notify(${QUOTE_NOTIFY_CHANNEL}, ${JSON.stringify(note)})`);
    await enqueueJob(tx, {
      kind: MARKET_TICK_JOB,
      dedupeKey: `${MARKET_TICK_JOB}:${t.instrumentId}:${t.asOf.toISOString()}:${t.mark}:${t.last}:${t.bid}:${t.ask}`,
      payload: { instrumentId: t.instrumentId, asOf: t.asOf.toISOString(), source, quote: { bid: t.bid, ask: t.ask, mark: t.mark, last: t.last, liquidityContracts: t.liquidityContracts ?? null } },
      runAfter: t.asOf
    });
  });
}

export async function processMarketTick(db: Db, job: JobRow, now: Date): Promise<TickSummary> {
  const { instrumentId, quote } = job.payload as { instrumentId: string; quote: VenueQuote };
  const summary: TickSummary = { instrumentId, stopsTriggered: 0, stopExitsRecorded: 0, takeProfitsRequested: 0, trailingActivated: 0, trailingTightened: 0, trailingStopsRequested: 0, exitsWaiting: 0 };

  // 1. The venue triggers resting stops on their own basis (exchange-native, may fire any time).
  summary.stopsTriggered = (await triggerStops(db, instrumentId, quote, now)).length;

  // 2. Reconcile every venue stop fill not yet recorded (also catches fills from a crashed run).
  for (const f of await listStopFills(db, instrumentId)) {
    const recorded = await db.transaction(async (tx) => {
      const [p] = await tx.select().from(positions).where(and(eq(positions.paperAccountId, f.paperAccountId), eq(positions.stopOrderRef, f.stopClientOrderId))).for('update');
      if (!p) return false;
      return (await recordExitFill(db, tx, { position: p, fill: f, reason: 'STOP_LOSS', intentId: null, now })).recorded;
    });
    if (recorded) summary.stopExitsRecorded += 1;
  }

  // 3. Software triggers (trailing stop, TP targets) on each position's saved basis.
  const open = await db.select({ id: positions.id }).from(positions).where(and(eq(positions.instrumentId, instrumentId), eq(positions.status, 'OPEN')));
  for (const { id } of open) {
    const r = await db.transaction(async (tx) => {
      const [p] = await tx.select().from(positions).where(eq(positions.id, id)).for('update');
      return p ? evaluatePositionExits(tx, p, quote, now) : null;
    });
    if (!r) continue;
    if (r.requested === 'TAKE_PROFIT') summary.takeProfitsRequested += 1;
    if (r.requested === 'TRAILING_STOP') summary.trailingStopsRequested += 1;
    if (r.trailingActivated) summary.trailingActivated += 1;
    if (r.trailingTightened) summary.trailingTightened += 1;
    if (r.inProgress) summary.exitsWaiting += 1;
  }

  await db.transaction(async (tx) => completeJob(tx, job));
  return summary;
}

export { EXIT_REASON_TEXT };
