import { editVersionDraft } from '@/server/adminCatalog';
import { empty, etag, json, readJson, requireRevision, route } from '@/server/http';
import { deleteStrategyDraft } from '@/server/strategyPackages';
import { requireAdmin } from '@/server/session';

export const dynamic = 'force-dynamic';

/** Edit a draft. Published versions are immutable (409 IMMUTABLE, and a DB trigger). */
export const PATCH = route<{ id: string }>(async (req, { correlationId, params }) => {
  const { user } = await requireAdmin(req);
  const v = await editVersionDraft(user, params.id, requireRevision(req), await readJson(req), correlationId);
  return json(correlationId, v, 200, { etag: etag(v.revision) });
});

/** Delete an unused draft. Published versions are permanent (409 IMMUTABLE). */
export const DELETE = route<{ id: string }>(async (req, { correlationId, params }) => {
  const { user } = await requireAdmin(req);
  await deleteStrategyDraft(user, params.id, requireRevision(req), correlationId);
  return empty(correlationId);
});
