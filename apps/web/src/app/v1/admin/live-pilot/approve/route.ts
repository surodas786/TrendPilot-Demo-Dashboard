import { approvePilot, getDb, openPilot, pilotReadiness } from '@trendpilot/db';
import { DomainError, ErrorCode } from '@trendpilot/domain';
import { json, route } from '@/server/http';
import { requireAdmin } from '@/server/session';

export const dynamic = 'force-dynamic';

/** Platform authorization (refused until every required check is recorded as passed). */
export const POST = route(async (req, { correlationId }) => {
  const { user } = await requireAdmin(req);
  const db = getDb();
  const p = await openPilot(db);
  if (!p) throw new DomainError(404, ErrorCode.NOT_FOUND, 'No live pilot is open.');
  await approvePilot(db, user.id, p.id, correlationId);
  const u = await openPilot(db);
  return json(correlationId, { pilot: u, readiness: pilotReadiness(u) });
});
