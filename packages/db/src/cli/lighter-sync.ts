/**
 * Runs the application's authenticated Lighter sync for one investor now: the same code as the
 * worker schedule and the investor's Lighter "Sync" button. Lighter reads only (account, API key,
 * orders, trades); no order is placed, cancelled or retried and no alert is replayed. With Lighter
 * order submission disabled (LIGHTER_MAINNET_ORDERS unset) nothing can be sent at all. It updates
 * TrendPilot's Lighter balance, protection status and drift, like the button does.
 * Prints a summary without keys, tokens or signatures.
 *
 *   npm run ops:lighter-sync -- --email investor@…
 */
import { sql } from 'drizzle-orm';
import { createDb } from '../client';
import { loadRootEnv, requireEnv } from '../env';
import { syncLighterConnection } from '../live/lighterSync';
import { recordAudit } from '../repos/audit';

loadRootEnv();
const i = process.argv.indexOf('--email');
const email = i >= 0 ? process.argv[i + 1] : undefined;
if (!email) {
  console.error('Usage: npm run ops:lighter-sync -- --email <investor>');
  process.exit(2);
}
const h = createDb(requireEnv('DATABASE_URL'), 2);
try {
  const [c] = (await h.db.execute(sql`SELECT c.id, c.owner_id FROM exchange_connections c JOIN users u ON u.id = c.owner_id WHERE lower(u.email) = lower(${email}) AND c.exchange = 'LIGHTER' AND c.status <> 'REVOKED'`)).rows as { id: string; owner_id: string }[];
  if (!c) throw new Error(`No Lighter connection for ${email}`);
  const r = await syncLighterConnection(h.db, c.id, new Date());
  await recordAudit(h.db, { actorUserId: null, action: 'OPS_LIVE_SYNC', targetType: 'exchange_connection', targetId: c.id, result: r.ok ? 'SUCCESS' : 'FAILED', metadata: { exchange: 'LIGHTER', positionsChecked: r.positionsChecked, drift: r.drift.length, error: r.error ?? null }, correlationId: 'ops-lighter-sync' });
  console.log(JSON.stringify(r, null, 2));
  process.exitCode = r.ok ? 0 : 1;
} finally {
  await h.close();
}
