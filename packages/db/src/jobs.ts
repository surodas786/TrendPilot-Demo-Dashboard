import { and, eq, sql } from 'drizzle-orm';
import type { Db, Executor } from './client';
import { jobs } from './schema';

/**
 * ARC-01 durable job queue. Jobs are inserted in the same transaction as the record that
 * caused them (transactional outbox). Processing is at-least-once: a claim carries a fencing
 * token and an expiring lease, so a crashed worker's job is reclaimed after the lease, and a
 * stale worker can never complete a job someone else reclaimed.
 */

export type JobRow = typeof jobs.$inferSelect;

export async function enqueueJob(tx: Executor, j: { kind: string; dedupeKey: string; payload: unknown; runAfter?: Date }): Promise<{ id: string; created: boolean }> {
  const [row] = await tx
    .insert(jobs)
    .values({ kind: j.kind, dedupeKey: j.dedupeKey, payload: j.payload, runAfter: j.runAfter ?? new Date() })
    .onConflictDoNothing({ target: jobs.dedupeKey })
    .returning({ id: jobs.id });
  if (row) return { id: row.id, created: true };
  const [existing] = await tx.select({ id: jobs.id }).from(jobs).where(eq(jobs.dedupeKey, j.dedupeKey));
  return { id: existing!.id, created: false };
}

/** Claims the oldest runnable job (pending and due, or running with an expired lease). */
export async function claimNextJob(db: Db, opts: { workerId: string; now: Date; leaseMs: number; kinds?: string[] }): Promise<JobRow | null> {
  const now = opts.now.toISOString();
  const leaseUntil = new Date(opts.now.getTime() + opts.leaseMs).toISOString();
  const kindFilter = opts.kinds?.length ? sql`AND kind IN (${sql.join(opts.kinds.map((k) => sql`${k}`), sql`, `)})` : sql``;
  const result = await db.execute<{ id: string }>(sql`
    UPDATE jobs SET
      status = 'RUNNING',
      claimed_by = ${opts.workerId},
      claim_token = gen_random_uuid(),
      claim_expires_at = ${leaseUntil}::timestamptz,
      attempts = attempts + 1,
      updated_at = now()
    WHERE id = (
      SELECT id FROM jobs
      WHERE ((status = 'PENDING' AND run_after <= ${now}::timestamptz)
          OR (status = 'RUNNING' AND claim_expires_at < ${now}::timestamptz))
        ${kindFilter}
      ORDER BY run_after, created_at
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    RETURNING id`);
  const id = result.rows[0]?.id;
  if (!id) return null;
  const [row] = await db.select().from(jobs).where(eq(jobs.id, id));
  return row ?? null;
}

export class FenceLostError extends Error {
  constructor(jobId: string) {
    super(`Job ${jobId} was reclaimed by another worker; this attempt's work is discarded.`);
    this.name = 'FenceLostError';
  }
}

/** Fenced completion: only the holder of the current claim token can complete the job. */
export async function completeJob(tx: Executor, job: Pick<JobRow, 'id' | 'claimToken'>): Promise<void> {
  const rows = await tx
    .update(jobs)
    .set({ status: 'DONE', completedAt: new Date(), lastError: null, claimExpiresAt: null, updatedAt: sql`now()` })
    .where(and(eq(jobs.id, job.id), eq(jobs.claimToken, job.claimToken!), eq(jobs.status, 'RUNNING')))
    .returning({ id: jobs.id });
  if (rows.length === 0) throw new FenceLostError(job.id);
}

/** Releases a failed attempt for retry with exponential backoff, or marks it DEAD. */
export async function failJob(db: Executor, job: JobRow, error: unknown, now: Date): Promise<'RETRY' | 'DEAD'> {
  const dead = job.attempts >= job.maxAttempts;
  const backoffMs = Math.min(60_000, 1000 * 2 ** Math.max(0, job.attempts - 1));
  const message = (error instanceof Error ? `${error.name}: ${error.message}` : String(error)).slice(0, 500);
  await db
    .update(jobs)
    .set({
      status: dead ? 'DEAD' : 'PENDING',
      runAfter: new Date(now.getTime() + backoffMs),
      lastError: message,
      claimToken: null,
      claimExpiresAt: null,
      updatedAt: sql`now()`
    })
    .where(and(eq(jobs.id, job.id), eq(jobs.claimToken, job.claimToken!)));
  return dead ? 'DEAD' : 'RETRY';
}
