import { connectionDto, getDb, verifyConnection } from '@trendpilot/db';
import { json, route } from '@/server/http';
import { requireInvestor } from '@/server/session';

export const dynamic = 'force-dynamic';

/** POST: re-runs the read-only verification (signing, position mode, balances, positions, stops). */
export const POST = route(async (req, { correlationId }) => {
  const { user } = await requireInvestor(req);
  return json(correlationId, { connection: connectionDto(await verifyConnection(getDb(), user.id, correlationId)) });
});
