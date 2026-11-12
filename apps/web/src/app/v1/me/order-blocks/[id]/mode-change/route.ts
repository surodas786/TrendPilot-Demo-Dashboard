import { json, route } from '@/server/http';
import { modeChangeStatus } from '@/server/orderBlocks';
import { requireInvestor } from '@/server/session';

export const dynamic = 'force-dynamic';

type Params = { id: string };

/** GET ?to=PAPER|LIVE — whether this block may switch to that mode now, and the reason if not. Changes nothing. */
export const GET = route<Params>(async (req, { correlationId, params }) => {
  const { user } = await requireInvestor(req);
  return json(correlationId, await modeChangeStatus(user, params.id, new URL(req.url).searchParams.get('to')));
});
