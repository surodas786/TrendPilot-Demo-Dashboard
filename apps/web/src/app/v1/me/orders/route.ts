import { getDb, listMyOrders } from '@trendpilot/db';
import { json, route } from '@/server/http';
import { requireInvestor } from '@/server/session';

export const dynamic = 'force-dynamic';

/** The investor's own paper order intents and their fills. */
export const GET = route(async (req, { correlationId }) => {
  const { user } = await requireInvestor(req);
  return json(correlationId, { items: await listMyOrders(getDb(), user.id) });
});
