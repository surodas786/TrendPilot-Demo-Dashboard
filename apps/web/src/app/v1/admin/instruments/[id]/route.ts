import { updatePair } from '@/server/adminCatalog';
import { etag, json, readJson, requireRevision, route } from '@/server/http';
import { requireAdmin } from '@/server/session';

export const dynamic = 'force-dynamic';

/** Edit suggested exits or publish/disable a pair. Revision-checked. */
export const PATCH = route<{ id: string }>(async (req, { correlationId, params }) => {
  const { user } = await requireAdmin(req);
  const inst = await updatePair(user, params.id, requireRevision(req), await readJson(req), correlationId);
  return json(correlationId, inst, 200, { etag: etag(inst.revision) });
});
