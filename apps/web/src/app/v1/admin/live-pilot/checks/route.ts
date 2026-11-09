import { getDb, openPilot, pilotReadiness, recordPilotCheck, type PilotCheckId } from '@trendpilot/db';
import { DomainError, ErrorCode } from '@trendpilot/domain';
import { json, readJson, route } from '@/server/http';
import { requireAdmin } from '@/server/session';

export const dynamic = 'force-dynamic';

/** Records one pre-pilot check with its evidence (a reference or note; never a credential). */
export const POST = route(async (req, { correlationId }) => {
  const { user } = await requireAdmin(req);
  const b = (await readJson(req)) as { check?: string; passed?: boolean; evidence?: string };
  const p = await openPilot(getDb());
  if (!p) throw new DomainError(404, ErrorCode.NOT_FOUND, 'No live pilot is open.');
  const u = await recordPilotCheck(getDb(), user.id, p.id, String(b.check) as PilotCheckId, { passed: b.passed === true, evidence: String(b.evidence ?? '') }, correlationId);
  return json(correlationId, { pilot: u, readiness: pilotReadiness(u) });
});
