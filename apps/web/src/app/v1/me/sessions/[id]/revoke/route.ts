import { getDb, recordAudit, revokeSessionById } from '@trendpilot/db';
import { notFound } from '@trendpilot/domain';
import { empty, route } from '@/server/http';
import { requireSession } from '@/server/session';

export const dynamic = 'force-dynamic';

/** IAM-01 session revocation. Only the caller's own sessions; other IDs are 404. */
export const POST = route<{ id: string }>(async (req, { correlationId, params }) => {
  const s = await requireSession(req);
  const db = getDb();
  if (!(await revokeSessionById(db, s.user.id, params.id))) throw notFound();
  await recordAudit(db, { actorUserId: s.user.id, action: 'ACCOUNT_SESSION_REVOKE', targetType: 'session', targetId: params.id, result: 'SUCCESS', correlationId });
  return empty(correlationId, 204);
});
