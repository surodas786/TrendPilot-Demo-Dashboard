import { json, readJson, route } from '@/server/http';
import { previewDraft } from '@/server/orderBlocks';
import { requireInvestor } from '@/server/session';

export const dynamic = 'force-dynamic';

/** EXE-01 preview of unsaved settings using fixture quotes. Places no orders and saves nothing. */
export const POST = route(async (req, { correlationId }) => {
  await requireInvestor(req);
  return json(correlationId, await previewDraft(await readJson(req)));
});
