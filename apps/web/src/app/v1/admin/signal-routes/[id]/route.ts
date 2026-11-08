import { getDb, recordAudit, setSignalRouteEnabled } from '@trendpilot/db';
import { DomainError, ErrorCode, notFound, signalRouteUpdateSchema } from '@trendpilot/domain';
import { json, parseBody, requireRevision, route } from '@/server/http';
import { requireAdmin } from '@/server/session';

export const dynamic = 'force-dynamic';

/** Enable or disable a route (revision-checked). Re-enabling cannot create an ambiguous route. */
export const PATCH = route<{ id: string }>(async (req, { correlationId, params }) => {
  const { user } = await requireAdmin(req);
  const revision = requireRevision(req);
  const { enabled } = await parseBody(req, signalRouteUpdateSchema);
  const db = getDb();
  const r = await setSignalRouteEnabled(db, params.id, revision, enabled);
  if (r === 'NOT_FOUND') throw notFound();
  if (r === 'REVISION_CONFLICT') throw new DomainError(409, ErrorCode.REVISION_CONFLICT, 'This route changed. Reload and try again.');
  if (r === 'AMBIGUOUS') throw new DomainError(409, ErrorCode.DUPLICATE, 'Another enabled route already uses this source tuple.');
  await recordAudit(db, { actorUserId: user.id, action: 'ADMIN_SIGNAL_ROUTE_UPDATE', targetType: 'signal_route', targetId: params.id, result: 'SUCCESS', after: { enabled }, correlationId });
  return json(correlationId, { id: params.id, enabled });
});
