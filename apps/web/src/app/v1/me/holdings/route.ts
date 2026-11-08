import { getDb, getMyPaperAccount, listMyOrders, listMyPositions } from '@trendpilot/db';
import { json, route } from '@/server/http';
import { requireInvestor } from '@/server/session';

export const dynamic = 'force-dynamic';

/** GET /v1/me/holdings: own paper balance, open positions (with stop) and active orders. */
export const GET = route(async (req, { correlationId }) => {
  const { user } = await requireInvestor(req);
  const db = getDb();
  const [account, positions, orders] = await Promise.all([getMyPaperAccount(db, user.id), listMyPositions(db, user.id), listMyOrders(db, user.id)]);
  const unresolved = ['INTENT', 'SUBMITTING', 'ACKNOWLEDGED', 'PARTIALLY_FILLED', 'UNKNOWN'];
  return json(correlationId, {
    account,
    positions: positions.filter((p) => p.status === 'OPEN'),
    activeOrders: orders.filter((o) => unresolved.includes(o.state)),
    dataSource: 'PAPER_SIMULATOR'
  });
});
