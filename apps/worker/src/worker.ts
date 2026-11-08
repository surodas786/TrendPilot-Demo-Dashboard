import { hostname } from 'node:os';
import { sql } from 'drizzle-orm';
import { createDb, processNextJob, requireEnv, signalClockFromEnv, type DbHandle, type ProcessResult } from '@trendpilot/db';
import { assertLiveTransportDisabled } from '@trendpilot/domain';

/**
 * TrendPilot background worker (SRS §3). M2 slice 1: claims durable jobs (ARC-01) and routes
 * accepted TradingView signals to private per-investor outcomes. No exchange calls exist; the
 * live order transport stays disabled.
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
        ? `job ${r.job?.id} ${r.outcome}: market tick stopsTriggered=${r.tick.stopsTriggered} stopExitsRecorded=${r.tick.stopExitsRecorded} takeProfitsRequested=${r.tick.takeProfitsRequested} trailingActivated=${r.tick.trailingActivated} trailingTightened=${r.tick.trailingTightened} trailingStopsRequested=${r.tick.trailingStopsRequested} exitsWaiting=${r.tick.exitsWaiting}`
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
  assertLiveTransportDisabled(env);

  const url = env.DATABASE_URL ?? requireEnv('DATABASE_URL');
  const handle: DbHandle = createDb(url, 4);
  await handle.db.execute(sql`select 1`);
  const workerId = workerIdentity();
  const clock = signalClockFromEnv(env);
  const hooks = crashHooks(env, log);
  log(`started as ${workerId}; database reachable; live order transport disabled`);

  let stopping = false;
  let busy: Promise<void> = Promise.resolve();

  const poll = async () => {
    if (stopping) return;
    try {
      for (;;) {
        const r = await processNextJob(handle.db, { workerId, now: clock(), leaseNow: new Date(), hooks });
        if (r.outcome === 'IDLE' || stopping) break;
        log(describe(r));
      }
    } catch (e) {
      log(`poll failed: ${(e as Error).message}`);
    }
  };

  const pollTimer = opts.processJobs === false ? null : setInterval(() => (busy = busy.then(poll)), opts.pollMs ?? Number(env.WORKER_POLL_MS ?? 1000));
  const beatTimer = setInterval(async () => {
    try {
      await handle.db.execute(sql`select 1`);
      log('heartbeat ok');
    } catch (e) {
      log(`heartbeat failed: ${(e as Error).message}`);
    }
  }, opts.heartbeatMs ?? 30_000);

  return {
    workerId,
    stop: async () => {
      stopping = true;
      if (pollTimer) clearInterval(pollTimer);
      clearInterval(beatTimer);
      await busy;
      await handle.close();
      log('stopped');
    }
  };
}

/** Processes every runnable job once, then returns (used by `npm run worker -- --once`). */
export async function runOnce(opts: { env?: Record<string, string | undefined>; log?: (m: string) => void } = {}): Promise<ProcessResult[]> {
  const env = opts.env ?? process.env;
  const log = opts.log ?? ((m: string) => console.log(`[worker] ${m}`));
  assertLiveTransportDisabled(env);
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
    log(results.length ? `processed ${results.length} job(s)` : 'no runnable jobs');
    return results;
  } finally {
    await handle.close();
  }
}
