import { desc } from 'drizzle-orm';
import type { Executor } from '../client';
import { enqueueJob } from '../jobs';
import { emailDeliveryMode } from '../mail/settings';
import { emailOutbox } from '../schema';

/** Worker job that relays one outbox message over SMTP (Admin → Settings → Mail Box). */
export const EMAIL_DELIVER_JOB = 'email.deliver';

/**
 * Every outgoing email is first stored in `email_outbox`, in the same transaction as the change
 * that caused it (invite, reset, notice). In capture mode (development, tests) that is all: the
 * development mailbox and `ops:mail` read it back and nothing is sent. In SMTP mode a delivery
 * job is queued in the same transaction, so mail is sent only after the change commits.
 */
export interface OutgoingEmail {
  to: string;
  subject: string;
  body: string;
  template: 'INVITE' | 'RESET' | 'SUSPENDED' | 'MFA_ENABLED' | 'PASSWORD_CHANGED';
}

export async function captureEmail(db: Executor, m: OutgoingEmail, env: Record<string, string | undefined> = process.env): Promise<{ id: string; deliveryStatus: 'CAPTURED' | 'QUEUED' }> {
  const smtp = emailDeliveryMode(env) === 'smtp';
  const [row] = await db
    .insert(emailOutbox)
    .values({ toEmail: m.to, subject: m.subject, bodyText: m.body, template: m.template, deliveryStatus: smtp ? 'QUEUED' : 'CAPTURED' })
    .returning({ id: emailOutbox.id });
  if (smtp) await enqueueJob(db, { kind: EMAIL_DELIVER_JOB, dedupeKey: `email:${row!.id}`, payload: { outboxId: row!.id } });
  return { id: row!.id, deliveryStatus: smtp ? 'QUEUED' : 'CAPTURED' };
}

export interface CapturedEmail {
  id: string;
  to: string;
  subject: string;
  body: string;
  template: string;
  deliveryStatus: string;
  createdAt: string;
}

export async function listCapturedEmails(db: Executor, limit = 50): Promise<CapturedEmail[]> {
  const rows = await db.select().from(emailOutbox).orderBy(desc(emailOutbox.createdAt)).limit(limit);
  return rows.map((r) => ({ id: r.id, to: r.toEmail, subject: r.subject, body: r.bodyText, template: r.template, deliveryStatus: r.deliveryStatus, createdAt: r.createdAt.toISOString() }));
}
