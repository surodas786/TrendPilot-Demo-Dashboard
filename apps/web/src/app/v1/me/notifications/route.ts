import { getDb, notificationsFor } from '@trendpilot/db';
import { json, route } from '@/server/http';
import { requireSession } from '@/server/session';

export const dynamic = 'force-dynamic';

/** GET /v1/me/notifications — the signed-in user's own in-app notifications. */
export const GET = route(async (req, { correlationId }) => {
  const { user } = await requireSession(req);
  return json(correlationId, { items: await notificationsFor(getDb(), user.id).list(50) });
});
