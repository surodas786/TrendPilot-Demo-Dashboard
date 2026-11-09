import { json, readJson, route } from '@/server/http';
import { validateTicker } from '@/server/adminCatalog';
import { requireAdmin } from '@/server/session';

export const dynamic = 'force-dynamic';

export const POST = route(async (req, { correlationId }) => {
  await requireAdmin(req);
  return json(correlationId, await validateTicker(await readJson(req)));
});
