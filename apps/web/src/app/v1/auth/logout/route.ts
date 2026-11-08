import { getDb, recordAudit, resolveSession, revokeSession } from '@trendpilot/db';
import { empty, route } from '@/server/http';
import { clearSessionCookie, sessionTokenFrom } from '@/server/session';

export const dynamic = 'force-dynamic';

/** IAM-01 session revocation for the presented session. */
export const POST = route(async (req, { correlationId }) => {
  const token = sessionTokenFrom(req);
  if (token) {
    const db = getDb();
    const s = await resolveSession(db, token);
    await revokeSession(db, token);
    if (s) await recordAudit(db, { actorUserId: s.user.id, action: 'AUTH_LOGOUT', targetType: 'session', targetId: s.sessionId, result: 'SUCCESS', correlationId });
  }
  return empty(correlationId, 204, { 'set-cookie': clearSessionCookie() });
});
