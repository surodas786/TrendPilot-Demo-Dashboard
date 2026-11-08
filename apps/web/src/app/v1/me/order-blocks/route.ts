import { etag, json, readJson, route } from '@/server/http';
import { createBlock, listBlocks } from '@/server/orderBlocks';
import { requireInvestor } from '@/server/session';

export const dynamic = 'force-dynamic';

/** GET /v1/me/order-blocks — the signed-in investor's blocks only. */
export const GET = route(async (req, { correlationId }) => {
  const { user } = await requireInvestor(req);
  return json(correlationId, { items: await listBlocks(user) });
});

/** POST /v1/me/order-blocks — create a block owned by the session user. */
export const POST = route(async (req, { correlationId }) => {
  const { user } = await requireInvestor(req);
  const block = await createBlock(user, await readJson(req), correlationId);
  return json(correlationId, block, 201, { etag: etag(block.revision), location: `/v1/me/order-blocks/${block.id}` });
});
