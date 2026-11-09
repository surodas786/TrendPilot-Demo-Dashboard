import { json, requireRevision, route } from '@/server/http';
import { requireAdmin } from '@/server/session';
import { restoreStrategyPackage } from '@/server/strategyPackages';

export const dynamic = 'force-dynamic';

/** Restore an archived package to new selections. */
export const POST = route<{ id: string }>(async (req, { correlationId, params }) => {
  const { user } = await requireAdmin(req);
  return json(correlationId, await restoreStrategyPackage(user, params.id, requireRevision(req), correlationId));
});
