import { desc } from 'drizzle-orm';
import type { Executor } from '../client';
import { emailOutbox } from '../schema';

/**
 * Local email capture (SRS §13: mock email until a provider is verified). Messages are
 * stored, never sent. The development mailbox page reads them back.
 */
export interface OutgoingEmail {
  to: string;
  subject: string;
  body: string;
  template: 'INVITE' | 'RESET' | 'SUSPENDED' | 'MFA_ENABLED' | 'PASSWORD_CHANGED';
}

export async function captureEmail(db: Executor, m: OutgoingEmail): Promise<void> {
  await db.insert(emailOutbox).values({ toEmail: m.to, subject: m.subject, bodyText: m.body, template: m.template });
}

export interface CapturedEmail {
  id: string;
  to: string;
  subject: string;
  body: string;
  template: string;
  createdAt: string;
}

export async function listCapturedEmails(db: Executor, limit = 50): Promise<CapturedEmail[]> {
  const rows = await db.select().from(emailOutbox).orderBy(desc(emailOutbox.createdAt)).limit(limit);
  return rows.map((r) => ({ id: r.id, to: r.toEmail, subject: r.subject, body: r.bodyText, template: r.template, createdAt: r.createdAt.toISOString() }));
}
