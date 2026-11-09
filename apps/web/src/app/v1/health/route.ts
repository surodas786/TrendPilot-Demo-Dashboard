import { sql } from 'drizzle-orm';
import { getDb } from '@trendpilot/db';
import { assertLiveTransportDisabled } from '@trendpilot/domain';

export const dynamic = 'force-dynamic';

/**
 * GET /v1/health: unauthenticated liveness for load balancers and container checks. Reveals no
 * data beyond "web up, database reachable, Paper mode". 503 when the database is unreachable.
 */
export async function GET(): Promise<Response> {
  let db = false;
  try {
    await getDb().execute(sql`select 1`);
    db = true;
  } catch {
    db = false;
  }
  let liveDisabled = true;
  try {
    assertLiveTransportDisabled();
  } catch {
    liveDisabled = false;
  }
  const ok = db && liveDisabled;
  return Response.json({ status: ok ? 'ok' : 'degraded', web: 'up', database: db ? 'up' : 'down', mode: 'PAPER', liveOrderTransport: liveDisabled ? 'disabled' : 'MISCONFIGURED' }, { status: ok ? 200 : 503, headers: { 'cache-control': 'no-store' } });
}
