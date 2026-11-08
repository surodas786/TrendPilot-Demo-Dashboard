import { getDb, listSessions } from '@trendpilot/db';
import { json, route } from '@/server/http';
import { requireSession } from '@/server/session';

export const dynamic = 'force-dynamic';

/** The signed-in user's own active sessions. */
export const GET = route(async (req, { correlationId }) => {
  const s = await requireSession(req);
  return json(correlationId, { items: await listSessions(getDb(), s.user.id, s.sessionId) });
});
