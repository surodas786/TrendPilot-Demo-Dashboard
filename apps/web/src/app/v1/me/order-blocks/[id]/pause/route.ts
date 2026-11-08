import { etag, json, requireRevision, route } from '@/server/http';
import { setBlockStatus } from '@/server/orderBlocks';
import { requireInvestor } from '@/server/session';

export const dynamic = 'force-dynamic';

export const POST = route<{ id: string }>(async (req, { correlationId, params }) => {
  const { user } = await requireInvestor(req);
  const block = await setBlockStatus(user, params.id, requireRevision(req), 'PAUSED', correlationId);
  return json(correlationId, block, 200, { etag: etag(block.revision) });
});
