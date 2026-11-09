import { deactivatePilot, getDb } from '@trendpilot/db';
import { json, route } from '@/server/http';
import { requireInvestor } from '@/server/session';

export const dynamic = 'force-dynamic';

/** The investor withdraws: no new entries; closing and protection stay available. */
export const POST = route(async (req, { correlationId }) => {
  const { user } = await requireInvestor(req);
  const p = await deactivatePilot(getDb(), user.id, correlationId);
  return json(correlationId, { status: p.status, investorActivatedAt: p.investorActivatedAt });
});
