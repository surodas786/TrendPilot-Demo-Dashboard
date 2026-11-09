import { getDb, getFeedTransport, listFeedEvents, listFeedHealth } from '@trendpilot/db';
import { now } from '@/server/clock';
import { json, route } from '@/server/http';
import { requireAdmin } from '@/server/session';

export const dynamic = 'force-dynamic';

/** MKT-02 operations view: per-contract feed health, current price source, ticker transport and recent feed events. Database only; never calls MEXC. */
export const GET = route(async (req, { correlationId }) => {
  await requireAdmin(req);
  const db = getDb();
  const at = now();
  const [items, events, transport] = await Promise.all([listFeedHealth(db, at), listFeedEvents(db, 50), getFeedTransport(db, at)]);
  return json(correlationId, { items, events, transport, checkedAt: at.toISOString() });
});
