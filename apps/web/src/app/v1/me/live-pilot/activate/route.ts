import { activatePilot, getDb } from '@trendpilot/db';
import { json, route } from '@/server/http';
import { requireInvestor } from '@/server/session';

export const dynamic = 'force-dynamic';

/** Explicit investor activation of the approved pilot. */
export const POST = route(async (req, { correlationId }) => {
  const { user } = await requireInvestor(req);
  const p = await activatePilot(getDb(), user.id, correlationId);
  return json(correlationId, { status: p.status, investorActivatedAt: p.investorActivatedAt });
});
