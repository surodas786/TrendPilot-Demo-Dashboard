import { json, route } from '@/server/http';
import { previewSaved } from '@/server/orderBlocks';
import { requireInvestor } from '@/server/session';

export const dynamic = 'force-dynamic';

/** POST /v1/me/order-blocks/{id}/preview (section 10.1). Owner-scoped; places no orders. */
export const POST = route<{ id: string }>(async (req, { correlationId, params }) => {
  const { user } = await requireInvestor(req);
  return json(correlationId, await previewSaved(user, params.id));
});
