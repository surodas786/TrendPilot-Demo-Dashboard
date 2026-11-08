import { publishVersion } from '@/server/adminCatalog';
import { etag, json, requireRevision, route } from '@/server/http';
import { requireAdmin } from '@/server/session';

export const dynamic = 'force-dynamic';

export const POST = route<{ id: string }>(async (req, { correlationId, params }) => {
  const { user } = await requireAdmin(req);
  const v = await publishVersion(user, params.id, requireRevision(req), correlationId);
  return json(correlationId, v, 200, { etag: etag(v.revision) });
});
