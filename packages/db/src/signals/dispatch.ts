import { and, eq, sql } from 'drizzle-orm';
import { DECISION_REASON_TEXT, evaluateBlockForSignal, type SignalAction, type SignalInterval, type Weekday } from '@trendpilot/domain';
import type { Db, Executor } from '../client';
import { claimNextJob, completeJob, failJob, FenceLostError, type JobRow } from '../jobs';
import { orderBlocks, signalDecisions, signalEvents, strategyVersions, users } from '../schema';
import { SIGNAL_DISPATCH_JOB } from './intake';

/**
 * Signal routing worker step (SIG-04/05, ARC-01). For one accepted event, every matching Paper
 * order block is evaluated independently and gets exactly one private outcome. The whole step
 * — outcomes, event status and fenced job completion — commits atomically, so a crash or retry
 * either finds nothing written or finds everything written; the unique (event, block, step) key
 * makes re-running harmless either way.
 */

export const DECISION_STEP = 'ENTRY_SCREEN_V1';

export interface DispatchHooks {
  /** Test seam: called after each outcome insert (e.g. to simulate a crash mid-dispatch). */
  afterDecision?: (index: number) => void | Promise<void>;
}

export interface DispatchSummary {
  eventId: string;
  evaluated: number;
  inserted: number;
  ready: number;
  skipped: number;
}

export async function dispatchSignalEvent(tx: Executor, eventId: string, now: Date, hooks: DispatchHooks = {}): Promise<DispatchSummary> {
  const [event] = await tx.select().from(signalEvents).where(eq(signalEvents.id, eventId)).for('update');
  if (!event) throw new Error(`Signal event ${eventId} not found.`);
  const summary: DispatchSummary = { eventId, evaluated: 0, inserted: 0, ready: 0, skipped: 0 };

  if (event.disposition === 'DISPATCH') {
    // SIG-04: the version stays pinned on the block; the route only names the lineage (package).
    const candidates = await tx
      .select({ block: orderBlocks, user: { id: users.id, status: users.status }, version: strategyVersions })
      .from(orderBlocks)
      .innerJoin(users, eq(users.id, orderBlocks.ownerId))
      .innerJoin(strategyVersions, eq(strategyVersions.id, orderBlocks.strategyVersionId))
      .where(and(eq(orderBlocks.instrumentId, event.instrumentId), eq(strategyVersions.packageId, event.packageId)))
      .orderBy(orderBlocks.id);

    for (const [i, c] of candidates.entries()) {
      const result = evaluateBlockForSignal({
        action: event.action as SignalAction,
        interval: event.interval as SignalInterval,
        barCloseAt: event.barCloseAt,
        evaluatedAt: now,
        user: { status: c.user.status },
        block: { status: c.block.status, mode: c.block.mode, direction: c.block.direction, weekdays: c.block.weekdays as Weekday[], timezone: c.block.timezone },
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
      if (rows.length) {
        summary.inserted += 1;
        if (result.status === 'READY_FOR_EVALUATION') summary.ready += 1;
        else summary.skipped += 1;
      }
      await hooks.afterDecision?.(i);
    }
  }

  await tx.update(signalEvents).set({ status: 'DISPATCHED', dispatchedAt: event.dispatchedAt ?? now }).where(eq(signalEvents.id, event.id));
  return summary;
}

export interface ProcessResult {
  job: Pick<JobRow, 'id' | 'kind' | 'attempts'> | null;
  outcome: 'IDLE' | 'DONE' | 'RETRY' | 'DEAD' | 'FENCE_LOST';
  summary?: DispatchSummary;
  error?: string;
}

/** Claims one job and runs it. Safe to call concurrently from several workers. */
export async function processNextJob(
  db: Db,
  opts: { workerId: string; now?: Date; leaseMs?: number; hooks?: DispatchHooks }
): Promise<ProcessResult> {
  const now = opts.now ?? new Date();
  const job = await claimNextJob(db, { workerId: opts.workerId, now, leaseMs: opts.leaseMs ?? 30_000, kinds: [SIGNAL_DISPATCH_JOB] });
  if (!job) return { job: null, outcome: 'IDLE' };
  const ref = { id: job.id, kind: job.kind, attempts: job.attempts };
  try {
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
    const r = await failJob(db, job, e, now);
    return { job: ref, outcome: r, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Processes jobs until the queue has nothing runnable. */
export async function drainJobs(db: Db, opts: { workerId: string; now?: () => Date; maxJobs?: number }): Promise<ProcessResult[]> {
  const out: ProcessResult[] = [];
  for (let i = 0; i < (opts.maxJobs ?? 1000); i++) {
    const r = await processNextJob(db, { workerId: opts.workerId, now: opts.now?.() });
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
    status: d.status,
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

/** IAM-02: an investor's own outcomes only. */
export async function listMyOutcomes(db: Executor, ownerId: string, limit = 50): Promise<SignalOutcomeDto[]> {
  const rows = await outcomeSelect(db)
    .where(eq(signalDecisions.ownerId, ownerId))
    .orderBy(sql`${signalEvents.barOpenAt} DESC`, signalDecisions.id)
    .limit(Math.min(Math.max(limit, 1), 200));
  return rows.map(toOutcome);
}

export async function getMyOutcome(db: Executor, ownerId: string, id: string): Promise<SignalOutcomeDto | undefined> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return undefined;
  const [row] = await outcomeSelect(db).where(and(eq(signalDecisions.id, id), eq(signalDecisions.ownerId, ownerId)));
  return row && toOutcome(row);
}
