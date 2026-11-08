import { getDb, recordAudit, revokeAllSessions } from '@trendpilot/db';
import { json, route } from '@/server/http';
import { requireSession } from '@/server/session';

export const dynamic = 'force-dynamic';

export const POST = route(async (req, { correlationId }) => {
  const s = await requireSession(req);
  const db = getDb();
  const revoked = await revokeAllSessions(db, s.user.id, s.sessionId);
  await recordAudit(db, { actorUserId: s.user.id, action: 'ACCOUNT_SESSIONS_REVOKE_OTHERS', targetType: 'user', targetId: s.user.id, result: 'SUCCESS', metadata: { revoked }, correlationId });
  return json(correlationId, { revoked });
});
