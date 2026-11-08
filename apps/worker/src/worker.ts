import { hostname } from 'node:os';
import { sql } from 'drizzle-orm';
import { createDb, drainJobs, processNextJob, requireEnv, signalClockFromEnv, type DbHandle, type ProcessResult } from '@trendpilot/db';
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
    ? `job ${r.job?.id} ${r.outcome}: event ${r.summary.eventId} evaluated=${r.summary.evaluated} new=${r.summary.inserted} ready=${r.summary.ready} skipped=${r.summary.skipped}`
    : `job ${r.job?.id} ${r.outcome}${r.error ? `: ${r.error}` : ''}`;

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
  log(`started as ${workerId}; database reachable; live order transport disabled`);

  let stopping = false;
  let busy: Promise<void> = Promise.resolve();

  const poll = async () => {
    if (stopping) return;
    try {
      for (;;) {
        const r = await processNextJob(handle.db, { workerId, now: clock() });
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
    const results = await drainJobs(handle.db, { workerId: workerIdentity(), now: clock });
    for (const r of results) log(describe(r));
    log(results.length ? `processed ${results.length} job(s)` : 'no runnable jobs');
    return results;
  } finally {
    await handle.close();
  }
}
