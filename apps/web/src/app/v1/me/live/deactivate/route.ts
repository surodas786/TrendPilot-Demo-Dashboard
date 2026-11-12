import { connectionDto, getDb, setLiveActivation } from '@trendpilot/db';
import { json, route } from '@/server/http';
import { requireInvestor } from '@/server/session';

export const dynamic = 'force-dynamic';

/** POST: the investor switches Live trading off: no new Live entries; protection and closes continue. */
export const POST = route(async (req, { correlationId }) => {
  const { user } = await requireInvestor(req);
  return json(correlationId, { connection: connectionDto(await setLiveActivation(getDb(), user.id, false, correlationId)) });
});
