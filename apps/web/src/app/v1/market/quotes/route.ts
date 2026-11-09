import { getDb, listLatestQuotes } from '@trendpilot/db';
import { now } from '@/server/clock';
import { json, route } from '@/server/http';
import { requireSession } from '@/server/session';

export const dynamic = 'force-dynamic';

/**
 * TrendPilot's latest stored quote per contract (the Refresh button). Database read only: it never
 * calls MEXC, so refreshing cannot add to exchange rate limits.
 */
export const GET = route(async (req, { correlationId }) => {
  const s = await requireSession(req);
  const items = await listLatestQuotes(getDb(), now(), { publishedOnly: s.user.role !== 'ADMIN' });
  return json(correlationId, { items, serverTime: new Date().toISOString() });
});
