import { getDb, listMyPositions } from '@trendpilot/db';
import { json, route } from '@/server/http';
import { requireInvestor } from '@/server/session';

export const dynamic = 'force-dynamic';

/** GET /v1/me/trades: the investor's own paper positions. */
export const GET = route(async (req, { correlationId }) => {
  const { user } = await requireInvestor(req);
  return json(correlationId, { items: await listMyPositions(getDb(), user.id) });
});
