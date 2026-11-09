import { json, requireRevision, route } from '@/server/http';
import { requireAdmin } from '@/server/session';
import { archiveStrategyPackage } from '@/server/strategyPackages';

export const dynamic = 'force-dynamic';

/** Archive: hidden from new selections, version history kept. Blocked while routes, investor settings or open positions depend on it. */
export const POST = route<{ id: string }>(async (req, { correlationId, params }) => {
  const { user } = await requireAdmin(req);
  return json(correlationId, await archiveStrategyPackage(user, params.id, requireRevision(req), correlationId));
});
