import { getDb, getMyCommand } from '@trendpilot/db';
import { notFound } from '@trendpilot/domain';
import { json, route } from '@/server/http';
import { requireInvestor } from '@/server/session';

export const dynamic = 'force-dynamic';

/** GET /v1/me/commands/{id} (§10.1): status of the investor's own close command. */
export const GET = route<{ id: string }>(async (req, { correlationId, params }) => {
  const { user } = await requireInvestor(req);
  const c = await getMyCommand(getDb(), user.id, params.id);
  if (!c) throw notFound();
  return json(correlationId, c);
});
