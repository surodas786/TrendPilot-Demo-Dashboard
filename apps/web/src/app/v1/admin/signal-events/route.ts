import { getDb, listRecentRejections, listRecentSignalEvents } from '@trendpilot/db';
import { json, route } from '@/server/http';
import { requireAdmin } from '@/server/session';

export const dynamic = 'force-dynamic';

/** Operations view: accepted events with outcome counts (no investor identity) and rejections. */
export const GET = route(async (req, { correlationId }) => {
  await requireAdmin(req);
  const db = getDb();
  const [events, rejections] = await Promise.all([listRecentSignalEvents(db, 50), listRecentRejections(db, 50)]);
  return json(correlationId, { events, rejections });
});
