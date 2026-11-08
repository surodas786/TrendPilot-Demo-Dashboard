import { getDb, listPublishedVersions } from '@trendpilot/db';
import { json, route } from '@/server/http';
import { requireSession } from '@/server/session';

export const dynamic = 'force-dynamic';

export const GET = route(async (req, { correlationId }) => {
  await requireSession(req);
  return json(correlationId, { items: await listPublishedVersions(getDb()) });
});
