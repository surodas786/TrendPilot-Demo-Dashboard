import { json, route } from '@/server/http';
import { adminLiveData } from '@/server/live';
import { requireAdmin } from '@/server/session';

export const dynamic = 'force-dynamic';

/** GET /v1/admin/live: the platform switch, capability evidence, every connection (no secrets) and the contract allowlist. */
export const GET = route(async (req, { correlationId }) => {
  await requireAdmin(req);
  return json(correlationId, await adminLiveData());
});
