import { and, eq } from 'drizzle-orm';
import type { Db } from '../client';
import { claimNextJob, completeJob, failJob, FenceLostError, type JobRow } from '../jobs';
import { EMAIL_DELIVER_JOB } from '../repos/outbox';
import { emailOutbox } from '../schema';
import { loadSmtpConfig } from './settings';
import { sendSmtp, type SmtpConfig } from './smtp';

/**
 * Worker side of SMTP delivery. Runs in its own polling loop so a slow mail server never
 * delays Paper trading jobs. At-least-once like every job; a SENT message is never resent.
 */

export interface EmailDeliveryResult {
  job: Pick<JobRow, 'id' | 'kind' | 'attempts'> | null;
  outcome: 'IDLE' | 'SENT' | 'FAILED' | 'RETRY' | 'SKIPPED' | 'FENCE_LOST';
  outboxId?: string;
  /** Redacted; never contains credentials or the message body. */
  detail?: string;
}

/** Long enough for connect + greeting + send timeouts in smtp.ts. */
const EMAIL_LEASE_MS = 90_000;

async function markFailed(db: Db, job: JobRow, outboxId: string, detail: string): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.update(emailOutbox).set({ deliveryStatus: 'FAILED', deliveryError: detail }).where(eq(emailOutbox.id, outboxId));
    await completeJob(tx, job);
  });
}

export async function processNextEmailJob(db: Db, opts: { workerId: string; now?: Date }): Promise<EmailDeliveryResult> {
  const now = opts.now ?? new Date();
  const job = await claimNextJob(db, { workerId: opts.workerId, now, leaseMs: EMAIL_LEASE_MS, kinds: [EMAIL_DELIVER_JOB] });
  if (!job) return { job: null, outcome: 'IDLE' };
  const ref = { id: job.id, kind: job.kind, attempts: job.attempts };
  const { outboxId } = job.payload as { outboxId: string };
  try {
    const [mail] = await db.select().from(emailOutbox).where(eq(emailOutbox.id, outboxId));
    if (!mail || mail.deliveryStatus !== 'QUEUED') {
      await db.transaction((tx) => completeJob(tx, job));
      return { job: ref, outcome: 'SKIPPED', outboxId, detail: mail ? `already ${mail.deliveryStatus}` : 'message no longer exists' };
    }

    let config: SmtpConfig | null;
    try {
      config = await loadSmtpConfig(db);
    } catch {
      const detail = 'The stored SMTP password could not be read (DATA_ENCRYPTION_KEY changed?). Re-enter it in Admin → Settings → Mail Box.';
      await markFailed(db, job, outboxId, detail);
      return { job: ref, outcome: 'FAILED', outboxId, detail };
    }
    if (!config) {
      const detail = 'SMTP is not configured. Set it up in Admin → Settings → Mail Box; this message was not sent.';
      await markFailed(db, job, outboxId, detail);
      return { job: ref, outcome: 'FAILED', outboxId, detail };
    }

    const r = await sendSmtp(config, { to: mail.toEmail, subject: mail.subject, text: mail.bodyText });
    if (r.ok) {
      await db.transaction(async (tx) => {
        await tx
          .update(emailOutbox)
          .set({ deliveryStatus: 'SENT', deliveryError: null, deliveredAt: new Date() })
          .where(and(eq(emailOutbox.id, outboxId), eq(emailOutbox.deliveryStatus, 'QUEUED')));
        await completeJob(tx, job);
      });
      return { job: ref, outcome: 'SENT', outboxId, detail: r.response };
    }
    if (r.permanent || job.attempts >= job.maxAttempts) {
      await markFailed(db, job, outboxId, r.detail);
      return { job: ref, outcome: 'FAILED', outboxId, detail: r.detail };
    }
    // Transient (connection, timeout, 4xx): keep QUEUED, record why, retry with backoff.
    await db.update(emailOutbox).set({ deliveryError: `Retrying: ${r.detail}` }).where(eq(emailOutbox.id, outboxId));
    await failJob(db, job, new Error(r.detail), new Date());
    return { job: ref, outcome: 'RETRY', outboxId, detail: r.detail };
  } catch (e) {
    if (e instanceof FenceLostError) return { job: ref, outcome: 'FENCE_LOST', outboxId };
    const outcome = await failJob(db, job, e, new Date());
    if (outcome === 'DEAD') await db.update(emailOutbox).set({ deliveryStatus: 'FAILED', deliveryError: 'Delivery failed after all retries; see the worker log.' }).where(eq(emailOutbox.id, outboxId));
    return { job: ref, outcome: outcome === 'DEAD' ? 'FAILED' : 'RETRY', outboxId, detail: e instanceof Error ? e.message.slice(0, 200) : 'error' };
  }
}
