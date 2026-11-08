import { getDb, getMyTrade } from '@trendpilot/db';
import { notFound } from '@trendpilot/domain';
import { json, route } from '@/server/http';
import { requireInvestor } from '@/server/session';

export const dynamic = 'force-dynamic';

/** GET /v1/me/trades/{id}: position, opening order, fills, stop and ledger. Unowned IDs are 404. */
export const GET = route<{ id: string }>(async (req, { correlationId, params }) => {
  const { user } = await requireInvestor(req);
  const trade = await getMyTrade(getDb(), user.id, params.id);
  if (!trade) throw notFound();
  return json(correlationId, trade);
});
