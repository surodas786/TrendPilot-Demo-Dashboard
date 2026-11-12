import { and, eq, inArray } from 'drizzle-orm';
import { Decimal, DECISION_REASON_TEXT, evaluateBlockForSignal, REVERSAL_REASON_TEXT, type ReversalWithheldReason, type SignalAction, type SignalInterval, type Weekday } from '@trendpilot/domain';
import type { Db } from '../client';
import { completeJob, type JobRow } from '../jobs';
import { orderBlocks, orderIntents, positions, signalDecisions, signalEvents, simOrders, strategyVersions, users } from '../schema';
import { ENTRY_STEP, evaluateAndReserveEntry, windowOf } from './entry';
import { resolveAccountVenue } from '../live/liveMode';
import type { ExecutionVenue } from '../venue/types';

/**
 * STR-06 close and reverse — the opening leg. Runs only after the closing leg is terminal
 * (`paper.close` enqueues it). It proceeds only from a confirmed flat state: the platform
 * position is CLOSED with zero quantity, the venue reports zero, the old stop is no longer
 * active and no other order is unresolved in the scope. Then every entry rule is rechecked at
 * this moment — signal expiry, weekday, pause, direction, account status (routing screen) and
 * EMA, quote freshness, margin and sizing (entry evaluation) — and an approved entry goes
 * through the normal `paper.submit` path, which attaches the new stop in the same simulated
 * request. A blocked or withheld reversal records its reason and stays flat. The ENTRY_V1
 * decision is unique per (event, block), so re-running or replaying never opens twice.
 */

const UNRESOLVED = ['INTENT', 'SUBMITTING', 'ACKNOWLEDGED', 'PARTIALLY_FILLED', 'UNKNOWN'] as const;

export interface ReverseSummary {
  closeIntentId: string;
  eventId: string;
  outcome: 'ENTRY_APPROVED' | 'SKIPPED' | 'WITHHELD' | 'ALREADY_DECIDED';
  reason: string | null;
  intentId?: string;
}

export async function processPaperReverse(db: Db, job: JobRow, now: Date, hooks: { venue?: ExecutionVenue } = {}): Promise<ReverseSummary> {
  const { closeIntentId } = job.payload as { closeIntentId: string };
  return db.transaction(async (tx) => {
    const [close] = await tx.select().from(orderIntents).where(eq(orderIntents.id, closeIntentId));
    if (!close || close.kind !== 'CLOSE' || close.exitReason !== 'REVERSAL_CLOSE' || !close.eventId) throw new Error(`Reversal close ${closeIntentId} not found.`);
    if ((UNRESOLVED as readonly string[]).includes(close.state)) throw new Error('The closing leg is not terminal yet.'); // retried later
    const [event] = await tx.select().from(signalEvents).where(eq(signalEvents.id, close.eventId));
    const [c] = await tx
      .select({ block: orderBlocks, user: { id: users.id, status: users.status }, version: strategyVersions })
      .from(orderBlocks)
      .innerJoin(users, eq(users.id, orderBlocks.ownerId))
      .innerJoin(strategyVersions, eq(strategyVersions.id, orderBlocks.strategyVersionId))
      .where(eq(orderBlocks.id, close.orderBlockId));
    const result = (outcome: ReverseSummary['outcome'], reason: string | null, intentId?: string): ReverseSummary => ({ closeIntentId, eventId: event!.id, outcome, reason, ...(intentId ? { intentId } : {}) });

    const [already] = await tx
      .select({ status: signalDecisions.status, reason: signalDecisions.reason })
      .from(signalDecisions)
      .where(and(eq(signalDecisions.eventId, event!.id), eq(signalDecisions.orderBlockId, c!.block.id), eq(signalDecisions.step, ENTRY_STEP)));
    if (already) {
      await completeJob(tx, job);
      return result('ALREADY_DECIDED', already.reason);
    }

    const [pos] = await tx.select().from(positions).where(eq(positions.id, close.positionId!));
    const reversal = { reversal: true, fromPositionId: pos!.id, fromSide: pos!.side, closeIntentId, closeState: close.state };
    const record = async (outcome: 'SKIPPED' | 'WITHHELD', reason: string, reasonText: string, extra: Record<string, unknown> = {}) => {
      await tx
        .insert(signalDecisions)
        .values({
          eventId: event!.id,
          ownerId: c!.block.ownerId,
          orderBlockId: c!.block.id,
          strategyVersionId: c!.block.strategyVersionId,
          step: ENTRY_STEP,
          status: 'SKIPPED',
          reason,
          detail: { side: pos!.side === 'LONG' ? 'SHORT' : 'LONG', reasonText, ...reversal, ...extra, strategyVersion: c!.version.version, blockRevision: c!.block.revision },
          evaluatedAt: now,
          correlationId: event!.correlationId
        })
        .onConflictDoNothing();
      await completeJob(tx, job);
      return result(outcome, reason);
    };
    const withhold = (reason: ReversalWithheldReason, extra: Record<string, unknown> = {}) => record('WITHHELD', reason, REVERSAL_REASON_TEXT[reason], extra);

    // 1. Confirmed flat, terminal orders, obsolete protection gone (AT-09: partial or unknown cannot reverse).
    if (pos!.status !== 'CLOSED' || !new Decimal(pos!.contracts).isZero()) return withhold('REVERSAL_CLOSE_INCOMPLETE', { remainingContracts: new Decimal(pos!.contracts).toFixed() });
    let venue: ExecutionVenue;
    let held: { contracts: string };
    try {
      venue = await resolveAccountVenue(db, { mode: pos!.mode, paperAccountId: pos!.paperAccountId, ownerId: pos!.ownerId }, hooks.venue);
      held = await venue.position(pos!.paperAccountId, pos!.instrumentId, tx);
    } catch (e) {
      return withhold('REVERSAL_NOT_FLAT', { venueError: (e as Error).message.slice(0, 200) });
    }
    if (!new Decimal(held.contracts).isZero()) return withhold('REVERSAL_NOT_FLAT', { venueContracts: held.contracts });
    if (pos!.stopOrderRef) {
      if (pos!.mode === 'PAPER') {
        const [stop] = await tx.select({ status: simOrders.status }).from(simOrders).where(eq(simOrders.clientOrderId, pos!.stopOrderRef));
        if (stop?.status === 'ACTIVE') return withhold('REVERSAL_PROTECTION_UNRECONCILED');
      } else {
        const stopId = await venue.stopOrderIdFor(pos!.stopOrderRef, tx);
        const prot = stopId ? await venue.inspectProtection(stopId, pos!.instrumentId).catch(() => ({ status: 'UNKNOWN' })) : null;
        if (prot?.status === 'ACTIVE' || prot?.status === 'UNKNOWN') return withhold('REVERSAL_PROTECTION_UNRECONCILED');
      }
    }
    const [busy] = await tx
      .select({ id: orderIntents.id })
      .from(orderIntents)
      .where(and(eq(orderIntents.paperAccountId, pos!.paperAccountId), eq(orderIntents.instrumentId, pos!.instrumentId), eq(orderIntents.mode, pos!.mode), inArray(orderIntents.state, [...UNRESOLVED])));
    if (busy) return withhold('REVERSAL_ORDERS_UNRESOLVED', { orderId: busy.id });

    // 2. Fresh eligibility now: expiry, weekday, pause, direction, account (routing screen)…
    const screen = evaluateBlockForSignal({
      action: event!.action as SignalAction,
      interval: event!.interval as SignalInterval,
      barCloseAt: event!.barCloseAt,
      evaluatedAt: now,
      user: { status: c!.user.status },
      block: { status: c!.block.status, mode: c!.block.mode, direction: c!.block.direction, weekdays: c!.block.weekdays as Weekday[], timezone: c!.block.timezone, tradingWindow: windowOf(c!.block) },
      version: { timeframe: c!.version.timeframe, permittedDirections: c!.version.permittedDirections, signalMaxAgeSeconds: c!.version.signalMaxAgeSeconds }
    });
    if (screen.status !== 'READY_FOR_EVALUATION' || !screen.side) {
      return record('SKIPPED', screen.reason ?? 'NOT_ELIGIBLE', screen.reason ? DECISION_REASON_TEXT[screen.reason] : 'Not eligible.', { failedChecks: screen.failed, signalAgeSeconds: screen.signalAgeSeconds });
    }

    // 3. …then EMA, market data, margin and sizing; an approval reserves and queues the submit.
    const entry = await evaluateAndReserveEntry(tx, { event: event!, block: c!.block, version: c!.version, side: screen.side, now, extraDetail: reversal });
    await completeJob(tx, job);
    return result(entry.status, entry.reason, entry.intentId);
  });
}
