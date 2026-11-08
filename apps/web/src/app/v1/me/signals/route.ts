import { getDb, listMyOutcomes } from '@trendpilot/db';
import { json, route } from '@/server/http';
import { requireInvestor } from '@/server/session';

export const dynamic = 'force-dynamic';

/** GET /v1/me/signals (section 10.1): the signed-in investor's own signal outcomes only. */
export const GET = route(async (req, { correlationId }) => {
  const { user } = await requireInvestor(req);
  const limit = Number(new URL(req.url).searchParams.get('limit') ?? 50);
  return json(correlationId, { items: await listMyOutcomes(getDb(), user.id, Number.isFinite(limit) ? limit : 50) });
});
