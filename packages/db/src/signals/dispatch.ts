import { and, eq, inArray, lte, ne, or, isNull, sql } from 'drizzle-orm';
import { DECISION_REASON_TEXT, decideSignalExit, EXIT_REASON_TEXT, evaluateBlockForSignal, type OppositePolicy, type SignalAction, type SignalInterval, type Weekday } from '@trendpilot/domain';
import type { Db, Executor } from '../client';
import { claimNextJob, completeJob, failJob, FenceLostError, type JobRow } from '../jobs';
import { orderBlocks, orderIntents, positions, signalDecisions, signalEvents, strategyVersions, users } from '../schema';
import { SIGNAL_DISPATCH_JOB } from './intake';
import { ENTRY_STEP, evaluateAndReserveEntry, PAPER_SUBMIT_JOB, processPaperSubmit, windowOf, type SubmitHooks, type SubmitSummary } from '../paper/entry';
import { MARKET_TICK_JOB, PAPER_CLOSE_JOB, PAPER_REVERSE_JOB, processMarketTick, processPaperClose, requestExit, type CloseSummary, type TickSummary } from '../paper/exits';
import { processPaperReverse, type ReverseSummary } from '../paper/reversal';
import { PAPER_FUNDING_JOB, processPaperFunding, type FundingSummary } from '../paper/funding';

/**
 * Signal routing worker step (SIG-04/05, ARC-01). For one accepted event, every matching Paper
 * order block is evaluated independently and gets exactly one private outcome. The whole step
 * — outcomes, event status and fenced job completion — commits atomically, so a crash or retry
 * either finds nothing written or finds everything written; the unique (event, block, step) key
 * makes re-running harmless either way.
 */

export const DECISION_STEP = 'ENTRY_SCREEN_V1';
export const EXIT_STEP = 'EXIT_V1';

export interface DispatchHooks extends SubmitHooks {
  /** Test seam: called after each outcome insert (e.g. to simulate a crash mid-dispatch). */
  afterDecision?: (index: number) => void | Promise<void>;
}

export interface DispatchSummary {
  eventId: string;
  /** Routing screen (step ENTRY_SCREEN_V1). */
  evaluated: number;
  inserted: number;
  ready: number;
  skipped: number;
  /** Entry evaluation (step ENTRY_V1) for blocks that passed the screen. */
  entriesApproved: number;
  entriesSkipped: number;
  /** Exit evaluation (step EXIT_V1) for open positions in this strategy lineage. */
  exitsRequested: number;
  exitsHeld: number;
  /** CLOSE_AND_REVERSE: blocks whose opening leg waits for the confirmed close (paper.reverse). */
  reversalsPending: number;
}

export async function dispatchSignalEvent(tx: Executor, eventId: string, now: Date, hooks: DispatchHooks = {}): Promise<DispatchSummary> {
  const [event] = await tx.select().from(signalEvents).where(eq(signalEvents.id, eventId)).for('update');
  if (!event) throw new Error(`Signal event ${eventId} not found.`);
  const summary: DispatchSummary = { eventId, evaluated: 0, inserted: 0, ready: 0, skipped: 0, entriesApproved: 0, entriesSkipped: 0, exitsRequested: 0, exitsHeld: 0, reversalsPending: 0 };

  if (event.disposition === 'DISPATCH') {
    // STR-03/04/05: exits first, for open positions whose saved strategy is in this lineage. Pause,
    // weekday, EMA and account status are entry restrictions and never block a valid exit. Only
    // positions already open when the event arrived: re-running an older event (crash recovery)
    // must never act on a position opened after it, e.g. the opposite leg of a reversal.
    const open = await tx
      .select({ p: positions })
      .from(positions)
      .innerJoin(strategyVersions, eq(strategyVersions.id, positions.strategyVersionId))
      .innerJoin(orderIntents, eq(orderIntents.id, positions.openIntentId))
      .where(
        and(
          eq(positions.instrumentId, event.instrumentId),
          eq(positions.status, 'OPEN'),
          eq(strategyVersions.packageId, event.packageId),
          lte(positions.openedAt, event.receivedAt),
          or(isNull(orderIntents.eventId), ne(orderIntents.eventId, event.id))
        )
      )
      .orderBy(positions.ownerId, positions.id);
    for (const { p } of open) {
      const [already] = await tx
        .select({ id: signalDecisions.id })
        .from(signalDecisions)
        .where(and(eq(signalDecisions.eventId, event.id), eq(signalDecisions.orderBlockId, p.orderBlockId), eq(signalDecisions.step, EXIT_STEP)));
      if (already) continue;
      const policy = ((p.settingsSnapshot as { strategyVersion?: { oppositePolicy?: OppositePolicy } }).strategyVersion?.oppositePolicy ?? 'KEEP_OPEN') as OppositePolicy;
      const d = decideSignalExit(event.action as SignalAction, p.side as 'LONG' | 'SHORT', policy);
      const base = { eventId: event.id, ownerId: p.ownerId, orderBlockId: p.orderBlockId, strategyVersionId: p.strategyVersionId!, step: EXIT_STEP, evaluatedAt: now, correlationId: event.correlationId };
      // ARC-02: exits are serialised per position; an exit already in flight is not duplicated.
      const [inFlight] =
        d.kind === 'CLOSE'
          ? await tx
              .select({ id: orderIntents.id })
              .from(orderIntents)
              .where(and(eq(orderIntents.positionId, p.id), inArray(orderIntents.state, ['INTENT', 'SUBMITTING', 'ACKNOWLEDGED', 'PARTIALLY_FILLED', 'UNKNOWN'])))
          : [];
      if (d.kind === 'CLOSE' && inFlight) {
        await tx.insert(signalDecisions).values({ ...base, status: 'HELD', reason: 'EXIT_IN_PROGRESS', detail: { positionId: p.id, positionSide: p.side, savedPolicy: policy, wanted: d.reason, existingOrderId: inFlight.id } });
        summary.exitsHeld += 1;
      } else if (d.kind === 'CLOSE') {
        const [decision] = await tx
          .insert(signalDecisions)
          .values({ ...base, status: 'EXIT_REQUESTED', reason: d.reason, detail: { positionId: p.id, positionSide: p.side, savedPolicy: policy, reasonText: EXIT_REASON_TEXT[d.reason] } })
          .returning({ id: signalDecisions.id });
        const r = await requestExit(tx, { position: p, reason: d.reason, now, decisionId: decision!.id, eventId: event.id });
        if (r.status === 'REQUESTED') summary.exitsRequested += 1;
        else summary.exitsHeld += 1;
      } else {
        await tx.insert(signalDecisions).values({ ...base, status: 'HELD', reason: d.reason, detail: { positionId: p.id, positionSide: p.side, savedPolicy: policy } });
        summary.exitsHeld += 1;
      }
    }

    // STR-06: a block whose position is being closed for a reversal gets its opening leg later,
    // from paper.reverse, after the close is confirmed. Read from the recorded decisions so a
    // re-run of this dispatch behaves the same.
    const reversing = new Set(
      (
        await tx
          .select({ blockId: signalDecisions.orderBlockId })
          .from(signalDecisions)
          .where(and(eq(signalDecisions.eventId, event.id), eq(signalDecisions.step, EXIT_STEP), eq(signalDecisions.status, 'EXIT_REQUESTED'), eq(signalDecisions.reason, 'REVERSAL_CLOSE')))
      ).map((r) => r.blockId)
    );
    summary.reversalsPending = reversing.size;

    // SIG-04: the version stays pinned on the block; the route only names the lineage (package).
    const candidates = await tx
      .select({ block: orderBlocks, user: { id: users.id, status: users.status }, version: strategyVersions })
      .from(orderBlocks)
      .innerJoin(users, eq(users.id, orderBlocks.ownerId))
      .innerJoin(strategyVersions, eq(strategyVersions.id, orderBlocks.strategyVersionId))
      .where(and(eq(orderBlocks.instrumentId, event.instrumentId), eq(strategyVersions.packageId, event.packageId)))
      // Owner order = account-lock order: concurrent dispatches can never deadlock.
      .orderBy(orderBlocks.ownerId, orderBlocks.id);

    for (const [i, c] of candidates.entries()) {
      const result = evaluateBlockForSignal({
        action: event.action as SignalAction,
        interval: event.interval as SignalInterval,
        barCloseAt: event.barCloseAt,
        evaluatedAt: now,
        user: { status: c.user.status },
        block: { status: c.block.status, mode: c.block.mode, direction: c.block.direction, weekdays: c.block.weekdays as Weekday[], timezone: c.block.timezone, tradingWindow: windowOf(c.block) },
        version: { timeframe: c.version.timeframe, permittedDirections: c.version.permittedDirections, signalMaxAgeSeconds: c.version.signalMaxAgeSeconds }
      });
      summary.evaluated += 1;
      const rows = await tx
        .insert(signalDecisions)
        .values({
          eventId: event.id,
          ownerId: c.block.ownerId,
          orderBlockId: c.block.id,
          strategyVersionId: c.block.strategyVersionId,
          step: DECISION_STEP,
          status: result.status,
          reason: result.reason,
          detail: {
            side: result.side,
            failedChecks: result.failed,
            reasonText: result.reason ? DECISION_REASON_TEXT[result.reason] : null,
            signalAgeSeconds: result.signalAgeSeconds,
            blockRevision: c.block.revision,
            strategyVersion: c.version.version,
            mode: c.block.mode,
            note:
              result.status === 'READY_FOR_EVALUATION'
                ? 'Passed the routing checks of this slice. Not an approved entry and not a fill: EMA, market data, risk and sizing checks come later.'
                : null
          },
          evaluatedAt: now,
          correlationId: event.correlationId
        })
        .onConflictDoNothing({ target: [signalDecisions.eventId, signalDecisions.orderBlockId, signalDecisions.step] })
        .returning({ id: signalDecisions.id });
      let screenStatus: string = result.status;
      if (rows.length) {
        summary.inserted += 1;
        if (result.status === 'READY_FOR_EVALUATION') summary.ready += 1;
        else summary.skipped += 1;
      } else {
        // Retry: the screen outcome already exists; continue from what was recorded.
        const [prev] = await tx
          .select({ status: signalDecisions.status })
          .from(signalDecisions)
          .where(and(eq(signalDecisions.eventId, event.id), eq(signalDecisions.orderBlockId, c.block.id), eq(signalDecisions.step, DECISION_STEP)));
        screenStatus = prev!.status;
      }
      await hooks.afterDecision?.(i);

      // STR-01/02: a bullish flip can open a Long, a bearish flip a Short, from a confirmed flat scope.
      if (screenStatus === 'READY_FOR_EVALUATION' && result.side && !reversing.has(c.block.id)) {
        const entry = await evaluateAndReserveEntry(tx, { event, block: c.block, version: c.version, side: result.side, now });
        if (entry.status === 'ENTRY_APPROVED') summary.entriesApproved += 1;
        else summary.entriesSkipped += 1;
      }
    }
  }

  await tx.update(signalEvents).set({ status: 'DISPATCHED', dispatchedAt: event.dispatchedAt ?? now }).where(eq(signalEvents.id, event.id));
  return summary;
}

export interface ProcessResult {
  job: Pick<JobRow, 'id' | 'kind' | 'attempts'> | null;
  outcome: 'IDLE' | 'DONE' | 'RETRY' | 'DEAD' | 'FENCE_LOST';
  summary?: DispatchSummary;
  submit?: SubmitSummary;
  close?: CloseSummary;
  tick?: TickSummary;
  reverse?: ReverseSummary;
  funding?: FundingSummary;
  error?: string;
}

/** Claims one job and runs it. Safe to call concurrently from several workers. */
export async function processNextJob(
  db: Db,
  opts: { workerId: string; now?: Date; leaseMs?: number; hooks?: DispatchHooks; leaseNow?: Date }
): Promise<ProcessResult> {
  const now = opts.now ?? new Date();
  const leaseNow = opts.leaseNow ?? now;
  const job = await claimNextJob(db, { workerId: opts.workerId, now, leaseNow, leaseMs: opts.leaseMs ?? 30_000, kinds: [SIGNAL_DISPATCH_JOB, PAPER_SUBMIT_JOB, PAPER_CLOSE_JOB, PAPER_REVERSE_JOB, MARKET_TICK_JOB, PAPER_FUNDING_JOB] });
  if (!job) return { job: null, outcome: 'IDLE' };
  const ref = { id: job.id, kind: job.kind, attempts: job.attempts };
  try {
    if (job.kind === PAPER_SUBMIT_JOB) {
      const submit = await processPaperSubmit(db, job, now, opts.hooks);
      return { job: ref, outcome: 'DONE', submit };
    }
    if (job.kind === PAPER_CLOSE_JOB) {
      const close = await processPaperClose(db, job, now, opts.hooks);
      return { job: ref, outcome: 'DONE', close };
    }
    if (job.kind === PAPER_REVERSE_JOB) {
      const reverse = await processPaperReverse(db, job, now, opts.hooks);
      return { job: ref, outcome: 'DONE', reverse };
    }
    if (job.kind === PAPER_FUNDING_JOB) {
      const funding = await processPaperFunding(db, job);
      return { job: ref, outcome: 'DONE', funding };
    }
    if (job.kind === MARKET_TICK_JOB) {
      const tick = await processMarketTick(db, job, now);
      return { job: ref, outcome: 'DONE', tick };
    }
    const { eventId } = job.payload as { eventId: string };
    const summary = await db.transaction(async (tx) => {
      const s = await dispatchSignalEvent(tx, eventId, now, opts.hooks);
      // Fenced: if the lease expired and another worker reclaimed the job, this rolls back.
      await completeJob(tx, job);
      return s;
    });
    return { job: ref, outcome: 'DONE', summary };
  } catch (e) {
    if (e instanceof FenceLostError) return { job: ref, outcome: 'FENCE_LOST', error: e.message };
    const r = await failJob(db, job, e, leaseNow);
    return { job: ref, outcome: r, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Processes jobs until the queue has nothing runnable. */
export async function drainJobs(db: Db, opts: { workerId: string; now?: () => Date; maxJobs?: number; hooks?: DispatchHooks }): Promise<ProcessResult[]> {
  const out: ProcessResult[] = [];
  for (let i = 0; i < (opts.maxJobs ?? 1000); i++) {
    const r = await processNextJob(db, { workerId: opts.workerId, now: opts.now?.(), hooks: opts.hooks });
    if (r.outcome === 'IDLE') break;
    out.push(r);
  }
  return out;
}

/* ───────────────────────── Read models ───────────────────────── */

export interface SignalOutcomeDto {
  id: string;
  status: 'READY_FOR_EVALUATION' | 'SKIPPED';
  reason: string | null;
  reasonText: string | null;
  side: 'LONG' | 'SHORT' | null;
  failedChecks: string[];
  evaluatedAt: string;
  orderBlockId: string;
  strategyVersion: number;
  /** Exit decision for an open position (close requested or held). */
  exit?: { status: 'EXIT_REQUESTED' | 'HELD'; reason: string | null; reasonText: string | null; positionId: string | null; orderState: string | null };
  /** Entry evaluation and paper order, when the block passed the routing screen. */
  entry?: {
    status: 'ENTRY_APPROVED' | 'SKIPPED';
    reason: string | null;
    reasonText: string | null;
    orderId: string | null;
    orderState: string | null;
    orderStateReason: string | null;
    positionId: string | null;
  };
  signal: {
    eventId: string;
    action: string;
    sourceExchange: string;
    sourceSymbol: string;
    interval: string;
    barOpenAt: string;
    barCloseAt: string;
    alertFiredAt: string;
    receivedAt: string;
    referencePrice: string;
  };
}

const outcomeSelect = (db: Executor) =>
  db
    .select({ d: signalDecisions, e: signalEvents })
    .from(signalDecisions)
    .innerJoin(signalEvents, eq(signalEvents.id, signalDecisions.eventId));

function toOutcome({ d, e }: { d: typeof signalDecisions.$inferSelect; e: typeof signalEvents.$inferSelect }): SignalOutcomeDto {
  const detail = d.detail as { side: SignalOutcomeDto['side']; failedChecks: string[]; reasonText: string | null; strategyVersion: number };
  return {
    id: d.id,
    status: d.status as SignalOutcomeDto['status'],
    reason: d.reason,
    reasonText: detail.reasonText,
    side: detail.side,
    failedChecks: detail.failedChecks,
    evaluatedAt: d.evaluatedAt.toISOString(),
    orderBlockId: d.orderBlockId,
    strategyVersion: detail.strategyVersion,
    signal: {
      eventId: e.id,
      action: e.action,
      sourceExchange: e.sourceExchange,
      sourceSymbol: e.sourceSymbol,
      interval: e.interval,
      barOpenAt: e.barOpenAt.toISOString(),
      barCloseAt: e.barCloseAt.toISOString(),
      alertFiredAt: e.alertFiredAt.toISOString(),
      receivedAt: e.receivedAt.toISOString(),
      referencePrice: e.referencePrice.replace(/\.?0+$/, '')
    }
  };
}

/** IAM-02: an investor's own outcomes only (routing screen rows; entry results are attached). */
export async function listMyOutcomes(db: Executor, ownerId: string, limit = 50): Promise<SignalOutcomeDto[]> {
  const rows = await outcomeSelect(db)
    .where(and(eq(signalDecisions.ownerId, ownerId), eq(signalDecisions.step, DECISION_STEP)))
    .orderBy(sql`${signalEvents.barOpenAt} DESC`, signalDecisions.id)
    .limit(Math.min(Math.max(limit, 1), 200));
  return attachEntries(db, ownerId, rows.map(toOutcome));
}

/** Folds the ENTRY_V1 result (and its order intent) into each screen outcome. */
async function attachEntries(db: Executor, ownerId: string, outcomes: SignalOutcomeDto[]): Promise<SignalOutcomeDto[]> {
  if (!outcomes.length) return outcomes;
  const entries = await db
    .select({ d: signalDecisions, intentId: orderIntents.id, intentState: orderIntents.state, intentReason: orderIntents.stateReason, positionId: positions.id })
    .from(signalDecisions)
    .leftJoin(orderIntents, eq(orderIntents.decisionId, signalDecisions.id))
    .leftJoin(positions, eq(positions.openIntentId, orderIntents.id))
    .where(and(eq(signalDecisions.ownerId, ownerId), eq(signalDecisions.step, ENTRY_STEP), inArray(signalDecisions.eventId, outcomes.map((o) => o.signal.eventId))));
  const exits = await db
    .select({ d: signalDecisions, intentState: orderIntents.state })
    .from(signalDecisions)
    .leftJoin(orderIntents, eq(orderIntents.decisionId, signalDecisions.id))
    .where(and(eq(signalDecisions.ownerId, ownerId), eq(signalDecisions.step, EXIT_STEP), inArray(signalDecisions.eventId, outcomes.map((o) => o.signal.eventId))));
  return outcomes.map((o0) => {
    const x = exits.find((r) => r.d.eventId === o0.signal.eventId && r.d.orderBlockId === o0.orderBlockId);
    const xd = x?.d.detail as { reasonText?: string | null; positionId?: string } | undefined;
    const o: SignalOutcomeDto = x
      ? { ...o0, exit: { status: x.d.status as 'EXIT_REQUESTED' | 'HELD', reason: x.d.reason, reasonText: xd?.reasonText ?? null, positionId: xd?.positionId ?? null, orderState: x.intentState } }
      : o0;
    const e = entries.find((r) => r.d.eventId === o.signal.eventId && r.d.orderBlockId === o.orderBlockId);
    if (!e) return o;
    const detail = e.d.detail as { reasonText: string | null };
    return {
      ...o,
      entry: {
        status: e.d.status as 'ENTRY_APPROVED' | 'SKIPPED',
        reason: e.d.reason,
        reasonText: detail.reasonText,
        orderId: e.intentId,
        orderState: e.intentState,
        orderStateReason: e.intentReason,
        positionId: e.positionId
      }
    };
  });
}

export async function getMyOutcome(db: Executor, ownerId: string, id: string): Promise<SignalOutcomeDto | undefined> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return undefined;
  const [row] = await outcomeSelect(db).where(and(eq(signalDecisions.id, id), eq(signalDecisions.ownerId, ownerId), eq(signalDecisions.step, DECISION_STEP)));
  return row && (await attachEntries(db, ownerId, [toOutcome(row)]))[0];
}
