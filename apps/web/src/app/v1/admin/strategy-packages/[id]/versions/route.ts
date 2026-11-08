import { createVersionDraft } from '@/server/adminCatalog';
import { etag, json, readJson, route } from '@/server/http';
import { requireAdmin } from '@/server/session';

export const dynamic = 'force-dynamic';

/** CFG-02: create the package's next version as an editable draft. */
export const POST = route<{ id: string }>(async (req, { correlationId, params }) => {
  const { user } = await requireAdmin(req);
  const v = await createVersionDraft(user, params.id, await readJson(req), correlationId);
  return json(correlationId, v, 201, { etag: etag(v.revision) });
});
