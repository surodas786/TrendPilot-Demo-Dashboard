/**
 * Runs the application's private MEXC sync for one investor now — the same code as the worker
 * schedule and the investor's "Sync with MEXC" button. MEXC is read only (no order is placed,
 * cancelled or retried, no alert replayed). It books exchange-side closes once each, refreshes the
 * balance, updates stop coverage and drift, and never lifts a halt.
 *
 *   npm run ops:live-sync -- --email investor@…
 */
import { sql } from 'drizzle-orm';
import { createDb } from '../client';
import { loadRootEnv, requireEnv } from '../env';
import { syncLiveAccount } from '../live/liveSync';
import { recordAudit } from '../repos/audit';

loadRootEnv();
const i = process.argv.indexOf('--email');
const email = i >= 0 ? process.argv[i + 1] : undefined;
if (!email) {
  console.error('Usage: npm run ops:live-sync -- --email <investor>');
  process.exit(2);
}
const h = createDb(requireEnv('DATABASE_URL'), 2);
try {
  const [u] = (await h.db.execute(sql`SELECT id FROM users WHERE lower(email) = lower(${email})`)).rows as { id: string }[];
  if (!u) throw new Error(`No user ${email}`);
  const r = await syncLiveAccount(h.db, u.id, new Date());
  await recordAudit(h.db, { actorUserId: null, action: 'OPS_LIVE_SYNC', targetType: 'user', targetId: u.id, result: r.ok ? 'SUCCESS' : 'FAILED', metadata: { exitsRecorded: r.exitsRecorded, closes: r.closes, drift: r.drift, skipped: r.skipped, error: r.error ?? null }, correlationId: 'ops-live-sync' });
  console.log(JSON.stringify(r, null, 2));
  process.exitCode = r.ok ? 0 : 1;
} finally {
  await h.close();
}
