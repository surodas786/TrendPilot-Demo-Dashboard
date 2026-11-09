import { json, empty, readJson, requireRevision, route } from '@/server/http';
import { requireAdmin } from '@/server/session';
import { deleteStrategyPackage, renameStrategyPackage } from '@/server/strategyPackages';

export const dynamic = 'force-dynamic';

/** Rename a package. Its ID, versions, routes and investor settings are unchanged. */
export const PATCH = route<{ id: string }>(async (req, { correlationId, params }) => {
  const { user } = await requireAdmin(req);
  return json(correlationId, await renameStrategyPackage(user, params.id, requireRevision(req), await readJson(req), correlationId));
});

/** Delete a never-published package that nothing depends on. Published packages are archived instead. */
export const DELETE = route<{ id: string }>(async (req, { correlationId, params }) => {
  const { user } = await requireAdmin(req);
  await deleteStrategyPackage(user, params.id, requireRevision(req), correlationId);
  return empty(correlationId);
});
