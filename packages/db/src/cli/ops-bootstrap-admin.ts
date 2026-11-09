/**
 * Creates the FIRST administrator of an empty deployment (staging or production) and prints a
 * single-use invite link to this console. Refuses when any administrator already exists, so it
 * cannot be used to add or take over accounts later; further users are invited from the admin UI.
 *
 *   npm run ops:bootstrap-admin -- --email ops@example.com --name "Operations Admin"
 *
 * The link goes to the operator's console only (it is never emailed or logged elsewhere). It
 * expires after the normal invite TTL and works once.
 */
import { eq } from 'drizzle-orm';
import { INVITE_TTL_HOURS } from '@trendpilot/domain';
import { createDb } from '../client';
import { loadRootEnv, requireEnv } from '../env';
import { recordAudit } from '../repos/audit';
import { issueToken } from '../repos/tokens';
import { normalizeEmail } from '../repos/users';
import { users } from '../schema';

loadRootEnv();
const arg = (n: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const email = arg('email');
const name = arg('name');
if (!email || !name) throw new Error('--email and --name are required');
const base = requireEnv('APP_BASE_URL').replace(/\/+$/, '');

const h = createDb(requireEnv('DATABASE_URL'), 1);
try {
  const link = await h.db.transaction(async (tx) => {
    const admins = await tx.select({ id: users.id }).from(users).where(eq(users.role, 'ADMIN'));
    if (admins.length) throw new Error('An administrator already exists. Invite further users from the admin UI.');
    const [u] = await tx.insert(users).values({ name, email: normalizeEmail(email), role: 'ADMIN', status: 'INVITED' }).returning();
    const { token } = await issueToken(tx, u!.id, 'INVITE', INVITE_TTL_HOURS * 3_600_000, null);
    await recordAudit(tx, { actorUserId: null, action: 'ADMIN_BOOTSTRAP', targetType: 'user', targetId: u!.id, result: 'SUCCESS', after: { email: u!.email, role: 'ADMIN' }, correlationId: 'ops-bootstrap' });
    return `${base}/account/invite#token=${token}`;
  });
  console.log(`Created the first administrator ${normalizeEmail(email)} (INVITED).`);
  console.log(`Single-use invite link (expires in ${INVITE_TTL_HOURS} h). Open it to set the password, then enable MFA:`);
  console.log(link);
} finally {
  await h.close();
}
