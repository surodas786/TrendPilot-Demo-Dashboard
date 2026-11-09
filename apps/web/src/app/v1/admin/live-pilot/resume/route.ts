import { resumePilotEntries, getDb, openPilot, pilotReadiness } from '@trendpilot/db';
import { DomainError, ErrorCode } from '@trendpilot/domain';
import { json, readJson, route } from '@/server/http';
import { requireAdmin } from '@/server/session';

export const dynamic = 'force-dynamic';

/** Resumes entries after review (refused while an order is unresolved or a position is unprotected). */
export const POST = route(async (req, { correlationId }) => {
  const { user } = await requireAdmin(req);
  const db = getDb();
  const b = (await readJson(req).catch(() => ({}))) as Record<string, unknown>;
  const p = await openPilot(db);
  if (!p) throw new DomainError(404, ErrorCode.NOT_FOUND, 'No live pilot is open.');
  await resumePilotEntries(db, user.id, p.id, String(b.note ?? ''), correlationId);
  const u = await openPilot(db);
  return json(correlationId, { pilot: u, readiness: pilotReadiness(u) });
});
