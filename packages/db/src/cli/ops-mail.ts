/**
 * Prints the newest email stored for an address (invite, reset, notices). Every email is kept in
 * `email_outbox`; with EMAIL_DELIVERY=capture nothing is sent and the operator relays invite and
 * reset links from this console. With SMTP (Admin → Settings → Mail Box) it is also sent. Requires database access; it is not reachable over HTTP.
 *
 *   npm run ops:mail -- --to investor@example.com [--template INVITE|RESET]
 */
import { and, desc, eq } from 'drizzle-orm';
import { createDb } from '../client';
import { loadRootEnv, requireEnv } from '../env';
import { emailOutbox } from '../schema';

loadRootEnv();
const arg = (n: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const to = arg('to')?.trim().toLowerCase();
if (!to) throw new Error('--to is required');
const template = arg('template');

const h = createDb(requireEnv('DATABASE_URL'), 1);
try {
  const [m] = await h.db
    .select()
    .from(emailOutbox)
    .where(and(eq(emailOutbox.toEmail, to), template ? eq(emailOutbox.template, template) : undefined))
    .orderBy(desc(emailOutbox.createdAt))
    .limit(1);
  if (!m) {
    console.log(`No captured email to ${to}.`);
  } else {
    console.log(`To: ${m.toEmail}\nTemplate: ${m.template}\nCreated: ${m.createdAt.toISOString()}\nSubject: ${m.subject}\n\n${m.bodyText}`);
  }
} finally {
  await h.close();
}
