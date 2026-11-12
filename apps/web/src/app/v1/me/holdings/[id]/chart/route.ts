import { getDb, getMyHoldingChart } from '@trendpilot/db';
import { notFound } from '@trendpilot/domain';
import { now } from '@/server/clock';
import { json, route } from '@/server/http';
import { requireInvestor } from '@/server/session';

export const dynamic = 'force-dynamic';

/**
 * GET /v1/me/holdings/{id}/chart: TrendPilot's stored exchange candles for this position's exact
 * contract, plus the average-entry and stop-loss price lines. Owner-scoped (another investor's
 * position is a 404). Served from TrendPilot only, so no position data leaves it.
 */
export const GET = route<{ id: string }>(async (req, { correlationId, params }) => {
  const { user } = await requireInvestor(req);
  const chart = await getMyHoldingChart(getDb(), user.id, params.id, { now: now() });
  if (!chart) throw notFound();
  return json(correlationId, chart);
});
