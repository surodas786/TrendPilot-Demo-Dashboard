import { getDb, getMyOutcome } from '@trendpilot/db';
import { notFound } from '@trendpilot/domain';
import { json, route } from '@/server/http';
import { requireInvestor } from '@/server/session';

export const dynamic = 'force-dynamic';

/** One outcome. Another investor's outcome ID answers exactly like an unknown ID (404). */
export const GET = route<{ id: string }>(async (req, { correlationId, params }) => {
  const { user } = await requireInvestor(req);
  const outcome = await getMyOutcome(getDb(), user.id, params.id);
  if (!outcome) throw notFound();
  return json(correlationId, outcome);
});
