import { hostname } from 'node:os';
import { sql } from 'drizzle-orm';
import { createDb, emailDeliveryMode, heartbeat, markStopped, processNextEmailJob, processNextJob, pruneRetention, requireEnv, RETENTION_DEFAULTS, signalClockFromEnv, syncAllLiveAccounts, type DbHandle, type ProcessResult } from '@trendpilot/db';
import { assertLiveTransportAllowed } from '@trendpilot/domain';

/**
 * TrendPilot background worker (SRS §3). Claims durable jobs (ARC-01): signal dispatch, entries,
 * exits, reversals, market ticks and funding for Paper and Live, and runs the private MEXC sync
 * for Live accounts. Live orders need LIVE_ORDER_TRANSPORT=enabled (production only) plus the
 * platform and investor gates; with the transport disabled no order-changing request can be sent.
 */
export interface WorkerOptions {
  env?: Record<string, string | undefined>;
  heartbeatMs?: number;
  pollMs?: number;
  log?: (msg: string) => void;
  /** Disable the polling loop (used by tests that only check startup). */
  processJobs?: boolean;
}

export interface RunningWorker {
  workerId: string;
  stop: () => Promise<void>;
}

export const workerIdentity = () => `worker-${hostname()}-${process.pid}`;

const describe = (r: ProcessResult) =>
  r.summary
    ? `job ${r.job?.id} ${r.outcome}: event ${r.summary.eventId} evaluated=${r.summary.evaluated} new=${r.summary.inserted} ready=${r.summary.ready} skipped=${r.summary.skipped} entriesApproved=${r.summary.entriesApproved} entriesSkipped=${r.summary.entriesSkipped} exitsRequested=${r.summary.exitsRequested} exitsHeld=${r.summary.exitsHeld}${r.summary.reversalsPending ? ` reversalsPending=${r.summary.reversalsPending}` : ''}`
    : r.close
      ? `job ${r.job?.id} ${r.outcome}: paper close ${r.close.intentId} ${r.close.state}${r.close.reason ? ` (${r.close.reason})` : ''}${r.close.filled ? ` filled=${r.close.filled} remaining=${r.close.remaining}${r.close.closed ? ' position CLOSED' : ''}` : ''}${r.close.reconciled ? ' [reconciled with simulator]' : ''}${r.close.exitReason ? ` exit=${r.close.exitReason}` : ''}${r.close.targetLevelId ? ` target=${r.close.targetLevelId}` : ''}${r.close.next ? ` next=${r.close.next}` : ''}${r.close.reversalQueued ? ' reversal queued' : ''}`
      : r.tick
        ? `job ${r.job?.id} ${r.outcome}: market tick stopsTriggered=${r.tick.stopsTriggered} stopExitsRecorded=${r.tick.stopExitsRecorded} takeProfitsRequested=${r.tick.takeProfitsRequested} trailingActivated=${r.tick.trailingActivated} trailingTightened=${r.tick.trailingTightened} trailingTakeProfitsRequested=${r.tick.trailingTakeProfitsRequested} trailingStopsRequested=${r.tick.trailingStopsRequested} exitsWaiting=${r.tick.exitsWaiting} targetsArmed=${r.tick.targetsArmed}`
        : r.funding
          ? `job ${r.job?.id} ${r.outcome}: funding ${r.funding.settledAt} positions=${r.funding.positions} booked=${r.funding.booked} alreadyBooked=${r.funding.alreadyBooked}${r.funding.noMark ? ` noMark=${r.funding.noMark}` : ''}`
        : r.reverse
          ? `job ${r.job?.id} ${r.outcome}: reversal for close ${r.reverse.closeIntentId} ${r.reverse.outcome}${r.reverse.reason ? ` (${r.reverse.reason})` : ''}${r.reverse.intentId ? ` order=${r.reverse.intentId}` : ''}`
          : r.submit
      ? `job ${r.job?.id} ${r.outcome}: paper order ${r.submit.intentId} ${r.submit.state}${r.submit.reason ? ` (${r.submit.reason})` : ''}${r.submit.positionId ? ` position=${r.submit.positionId}` : ''}${r.submit.reconciled ? ' [reconciled with simulator]' : ''}`
      : `job ${r.job?.id} ${r.outcome}${r.error ? `: ${r.error}` : ''}`;

/**
 * Restart drill (dev/test only): PAPER_SIM_CRASH_AFTER_FILL=1 makes the process exit right after
 * the simulator fills an order and before the platform records it, like a crash mid-submission.
 * The next worker run must reconcile by client order ID instead of submitting again.
 */
function crashHooks(env: Record<string, string | undefined>, log: (m: string) => void) {
  if (env.PAPER_SIM_CRASH_AFTER_FILL !== '1') return {};
  if (env.NODE_ENV === 'production') throw new Error('PAPER_SIM_CRASH_AFTER_FILL is not allowed in production.');
  return {
    afterSimulatorFill: () => {
      log('PAPER_SIM_CRASH_AFTER_FILL: exiting after the simulated fill, before recording it');
      process.exit(75);
    }
  };
}

export async function startWorker(opts: WorkerOptions = {}): Promise<RunningWorker> {
  const env = opts.env ?? process.env;
  const log = opts.log ?? ((m: string) => console.log(`[worker] ${new Date().toISOString()} ${m}`));

  // OPS-02 / AT-11: checked before any connection is opened.
  const transport = assertLiveTransportAllowed(env);

  const url = env.DATABASE_URL ?? requireEnv('DATABASE_URL');
  const handle: DbHandle = createDb(url, 4);
  await handle.db.execute(sql`select 1`);
  const workerId = workerIdentity();
  const clock = signalClockFromEnv(env);
  const hooks = crashHooks(env, log);
  log(`started as ${workerId}; database reachable; live order transport ${transport}`);

  let stopping = false;
  let busy: Promise<void> = Promise.resolve();
  // OPS: liveness and queue counters, visible in the admin Operations view.
  const startedAt = new Date();
  const stats = { processed: 0, failed: 0, lastJobAt: null as string | null, lastError: null as string | null, lastPrunedAt: null as string | null };
  const beat = () => heartbeat(handle.db, { service: 'worker', instance: workerId, startedAt, detail: { ...stats, pid: process.pid } });
  await beat();

  const poll = async () => {
    if (stopping) return;
    try {
      for (;;) {
        const r = await processNextJob(handle.db, { workerId, now: clock(), leaseNow: new Date(), hooks });
        if (r.outcome === 'IDLE' || stopping) break;
        stats.processed += 1;
        stats.lastJobAt = new Date().toISOString();
        if (r.outcome === 'RETRY' || r.outcome === 'DEAD') {
          stats.failed += 1;
          stats.lastError = `${r.job?.kind} ${r.outcome}: ${r.error ?? ''}`.slice(0, 300);
        }
        log(describe(r));
      }
    } catch (e) {
      log(`poll failed: ${(e as Error).message}`);
    }
  };

  // Mail Box: SMTP delivery runs in its own loop so a slow mail server never delays trading jobs.
  // Logs carry the outbox id and a redacted result only, never message bodies or credentials.
  let mailBusy: Promise<void> = Promise.resolve();
  const pollMail = async () => {
    if (stopping) return;
    try {
      for (;;) {
        const r = await processNextEmailJob(handle.db, { workerId });
        if (r.outcome === 'IDLE' || stopping) break;
        if (r.outcome === 'FAILED' || r.outcome === 'RETRY') {
          stats.failed += 1;
          stats.lastError = `${r.job?.kind} ${r.outcome}: ${r.detail ?? ''}`.slice(0, 300);
        }
        log(`job ${r.job?.id} ${r.outcome}: email ${r.outboxId}${r.detail ? ` (${r.detail})` : ''}`);
      }
    } catch (e) {
      log(`mail poll failed: ${(e as Error).message}`);
    }
  };
  log(`email delivery: ${emailDeliveryMode(env) === 'smtp' ? 'SMTP (Admin → Settings → Mail Box)' : 'capture only (nothing is sent)'}`);

  const pollTimer = opts.processJobs === false ? null : setInterval(() => (busy = busy.then(poll)), opts.pollMs ?? Number(env.WORKER_POLL_MS ?? 1000));
  const mailTimer = opts.processJobs === false ? null : setInterval(() => (mailBusy = mailBusy.then(pollMail)), Math.max(1000, opts.pollMs ?? Number(env.WORKER_POLL_MS ?? 1000)));
  const beatTimer = setInterval(async () => {
    try {
      await beat();
    } catch (e) {
      log(`heartbeat failed: ${(e as Error).message}`);
    }
  }, opts.heartbeatMs ?? 30_000);
  // Retention for finished jobs and old quotes (hourly; first run a minute after start).
  const prune = async () => {
    try {
      const r = await pruneRetention(handle.db, { jobDays: Number(env.JOB_RETENTION_DAYS ?? RETENTION_DEFAULTS.jobDays), quoteDays: Number(env.QUOTE_RETENTION_DAYS ?? RETENTION_DEFAULTS.quoteDays) });
      stats.lastPrunedAt = new Date().toISOString();
      if (r.jobs || r.quotes) log(`retention: removed ${r.jobs} finished job(s) and ${r.quotes} old quote(s)`);
    } catch (e) {
      log(`retention failed: ${(e as Error).message}`);
    }
  };
  // Live: private MEXC sync (balances, positions, fills, funding, liquidation, stop coverage, drift).
  let syncBusy: Promise<void> = Promise.resolve();
  const syncLive = async () => {
    if (stopping) return;
    try {
      for (const r of await syncAllLiveAccounts(handle.db, clock(), { env })) {
        if (!r.ok) log(`live sync ${r.ownerId}: failed (${r.error})`);
        else if (r.exitsRecorded || r.protectionFailures || r.drift.length) log(`live sync ${r.ownerId}: exitsRecorded=${r.exitsRecorded} protectionFailures=${r.protectionFailures} drift=${r.drift.map((d) => `${d.kind} ${d.symbol}`).join(', ') || 'none'}`);
      }
    } catch (e) {
      log(`live sync failed: ${(e as Error).message}`);
    }
  };
  const syncTimer = opts.processJobs === false ? null : setInterval(() => (syncBusy = syncBusy.then(syncLive)), Number(env.LIVE_SYNC_MS ?? 30_000));
  const pruneStart = opts.processJobs === false ? null : setTimeout(() => void prune(), 60_000);
  const pruneTimer = opts.processJobs === false ? null : setInterval(() => void prune(), 3_600_000);

  return {
    workerId,
    stop: async () => {
      stopping = true;
      if (pollTimer) clearInterval(pollTimer);
      if (mailTimer) clearInterval(mailTimer);
      if (syncTimer) clearInterval(syncTimer);
      clearInterval(beatTimer);
      if (pruneStart) clearTimeout(pruneStart);
      if (pruneTimer) clearInterval(pruneTimer);
      await busy;
      await mailBusy;
      await syncBusy;
      await markStopped(handle.db, 'worker', workerId).catch(() => undefined);
      await handle.close();
      log('stopped');
    }
  };
}

/** Processes every runnable job once, then returns (used by `npm run worker -- --once`). */
export async function runOnce(opts: { env?: Record<string, string | undefined>; log?: (m: string) => void } = {}): Promise<ProcessResult[]> {
  const env = opts.env ?? process.env;
  const log = opts.log ?? ((m: string) => console.log(`[worker] ${m}`));
  assertLiveTransportAllowed(env);
  const clock = signalClockFromEnv(env);
  const handle = createDb(env.DATABASE_URL ?? requireEnv('DATABASE_URL'), 2);
  try {
    const hooks = crashHooks(env, log);
    const results: ProcessResult[] = [];
    // Log each job as it finishes, so output survives a crash later in the run.
    for (;;) {
      const r = await processNextJob(handle.db, { workerId: workerIdentity(), now: clock(), leaseNow: new Date(), hooks });
      if (r.outcome === 'IDLE') break;
      log(describe(r));
      results.push(r);
    }
    for (;;) {
      const m = await processNextEmailJob(handle.db, { workerId: workerIdentity() });
      if (m.outcome === 'IDLE') break;
      log(`job ${m.job?.id} ${m.outcome}: email ${m.outboxId}${m.detail ? ` (${m.detail})` : ''}`);
    }
    log(results.length ? `processed ${results.length} job(s)` : 'no runnable jobs');
    return results;
  } finally {
    await handle.close();
  }
}
