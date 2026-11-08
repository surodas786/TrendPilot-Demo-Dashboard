import { getDb, getMyOrder } from '@trendpilot/db';
import { notFound } from '@trendpilot/domain';
import { json, route } from '@/server/http';
import { requireInvestor } from '@/server/session';

export const dynamic = 'force-dynamic';

/** One order intent with its fills. Another investor's order ID is 404, like an unknown ID. */
export const GET = route<{ id: string }>(async (req, { correlationId, params }) => {
  const { user } = await requireInvestor(req);
  const order = await getMyOrder(getDb(), user.id, params.id);
  if (!order) throw notFound();
  return json(correlationId, order);
});
