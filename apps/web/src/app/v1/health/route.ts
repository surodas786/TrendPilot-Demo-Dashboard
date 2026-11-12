import { sql } from 'drizzle-orm';
import { getDb, getLiveControl } from '@trendpilot/db';
import { assertLiveTransportAllowed } from '@trendpilot/domain';

export const dynamic = 'force-dynamic';

/**
 * GET /v1/health: unauthenticated liveness for load balancers and container checks. Reveals no
 * data beyond "web up, database reachable", the release mode and whether the Live order transport
 * is enabled for this deployment. 503 when the database is unreachable or the transport setting
 * is invalid.
 */
export async function GET(): Promise<Response> {
  let db = false;
  let platformLive = false;
  try {
    await getDb().execute(sql`select 1`);
    db = true;
    platformLive = (await getLiveControl(getDb())).liveEnabled;
  } catch {
    db = db || false;
  }
  let transport: 'disabled' | 'enabled' | 'MISCONFIGURED';
  try {
    transport = assertLiveTransportAllowed();
  } catch {
    transport = 'MISCONFIGURED';
  }
  const ok = db && transport !== 'MISCONFIGURED';
  return Response.json(
    { status: ok ? 'ok' : 'degraded', web: 'up', database: db ? 'up' : 'down', mode: transport === 'enabled' && platformLive ? 'PAPER_AND_LIVE' : 'PAPER', liveOrderTransport: transport },
    { status: ok ? 200 : 503, headers: { 'cache-control': 'no-store' } }
  );
}
