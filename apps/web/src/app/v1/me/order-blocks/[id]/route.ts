import { etag, json, readJson, requireRevision, route } from '@/server/http';
import { getBlock, updateBlock } from '@/server/orderBlocks';
import { requireInvestor } from '@/server/session';

export const dynamic = 'force-dynamic';

type Params = { id: string };

/** Unknown and unowned IDs both answer 404 NOT_FOUND (§10.1). */
export const GET = route<Params>(async (req, { correlationId, params }) => {
  const { user } = await requireInvestor(req);
  const block = await getBlock(user, params.id);
  return json(correlationId, block, 200, { etag: etag(block.revision) });
});

/** PATCH with If-Match revision; edits apply to future entries (CFG-05). */
export const PATCH = route<Params>(async (req, { correlationId, params }) => {
  const { user } = await requireInvestor(req);
  const revision = requireRevision(req);
  const block = await updateBlock(user, params.id, revision, await readJson(req), correlationId);
  return json(correlationId, block, 200, { etag: etag(block.revision) });
});
