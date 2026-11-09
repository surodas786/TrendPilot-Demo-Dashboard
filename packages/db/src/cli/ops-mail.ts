/**
 * Prints the newest captured email to an address (invite, reset, notices). This build has no SMTP
 * transport: mail is captured in `email_outbox`. On staging, the operator relays invite and reset
 * links from this console. Requires database access; it is not reachable over HTTP.
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
