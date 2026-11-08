import { getDb, listPublishedInstruments } from '@trendpilot/db';
import { json, route } from '@/server/http';
import { requireSession } from '@/server/session';

export const dynamic = 'force-dynamic';

/** Published instruments only. Fixture metadata is flagged with isFixture. */
export const GET = route(async (req, { correlationId }) => {
  await requireSession(req);
  return json(correlationId, { items: await listPublishedInstruments(getDb()) });
});
