import { json, route } from '@/server/http';
import { liveStatusFor } from '@/server/live';
import { requireInvestor } from '@/server/session';

export const dynamic = 'force-dynamic';

/**
 * GET /v1/me/live: the signed-in investor's Live status — platform switches, their own MEXC
 * connection (never the key or secret), the contracts allowed for Live, and why Live entries are
 * (not) possible right now. Owner-scoped.
 */
export const GET = route(async (req, { correlationId }) => {
  const { user } = await requireInvestor(req);
  return json(correlationId, await liveStatusFor(user.id));
});
