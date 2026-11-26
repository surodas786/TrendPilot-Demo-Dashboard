import { json, readJson, route } from '@/server/http';
import { previewApply } from '@/server/commonExit';
import { requireAdmin } from '@/server/session';

export const dynamic = 'force-dynamic';

/** POST /v1/admin/common-exit-definition/preview — validate a draft plan and dry-run it on linked open positions (nothing is written). */
export const POST = route(async (req, { correlationId }) => {
  await requireAdmin(req);
  const body = (await readJson(req)) as { plan?: unknown } | null;
  return json(correlationId, await previewApply(body?.plan));
});
