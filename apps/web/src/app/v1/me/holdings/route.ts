import { getDb, getMyPaperAccount, listMyHoldings, listMyOrders } from '@trendpilot/db';
import { now } from '@/server/clock';
import { json, route } from '@/server/http';
import { requireInvestor } from '@/server/session';

export const dynamic = 'force-dynamic';

/**
 * GET /v1/me/holdings (UI-02, REP-04): own paper balance, open positions priced from the newest
 * quote (current and mark price, unrealized P&L, stop coverage, estimated liquidation where
 * supported) and active orders. A position without a price shows null (unavailable).
 */
export const GET = route(async (req, { correlationId }) => {
  const { user } = await requireInvestor(req);
  const db = getDb();
  const at = now();
  const [account, positions, orders] = await Promise.all([getMyPaperAccount(db, user.id), listMyHoldings(db, user.id, at), listMyOrders(db, user.id)]);
  const unresolved = ['INTENT', 'SUBMITTING', 'ACKNOWLEDGED', 'PARTIALLY_FILLED', 'UNKNOWN'];
  return json(correlationId, {
    mode: 'PAPER',
    asOf: at.toISOString(),
    account,
    positions,
    activeOrders: orders.filter((o) => unresolved.includes(o.state)),
    dataSource: 'PAPER_SIMULATOR'
  });
});
