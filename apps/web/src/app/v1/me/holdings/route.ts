import { getDb, getMyPaperAccount, listMyHoldings, listMyOrders } from '@trendpilot/db';
import { DomainError, ErrorCode } from '@trendpilot/domain';
import { now } from '@/server/clock';
import { json, route } from '@/server/http';
import { requireInvestor } from '@/server/session';

export const dynamic = 'force-dynamic';

/**
 * GET /v1/me/holdings[?mode=PAPER|LIVE] (UI-02, REP-04): own balances (Paper and Live separately),
 * open positions priced from the newest public quote (current and mark price, unrealized P&L,
 * stop coverage, liquidation: estimated for Paper, synced from MEXC for Live) and active orders.
 * Every position and order carries its mode. A position without a price shows null (unavailable).
 */
export const GET = route(async (req, { correlationId }) => {
  const { user } = await requireInvestor(req);
  const q = (new URL(req.url).searchParams.get('mode') ?? '').toUpperCase();
  if (q && q !== 'PAPER' && q !== 'LIVE') throw new DomainError(422, ErrorCode.VALIDATION_FAILED, 'mode must be PAPER or LIVE.');
  const mode = (q || undefined) as 'PAPER' | 'LIVE' | undefined;
  const db = getDb();
  const at = now();
  const [paper, live, positions, orders] = await Promise.all([getMyPaperAccount(db, user.id, 'PAPER'), getMyPaperAccount(db, user.id, 'LIVE'), listMyHoldings(db, user.id, at, mode), listMyOrders(db, user.id)]);
  const unresolved = ['INTENT', 'SUBMITTING', 'ACKNOWLEDGED', 'PARTIALLY_FILLED', 'UNKNOWN'];
  return json(correlationId, {
    mode: mode ?? 'ALL',
    asOf: at.toISOString(),
    account: paper,
    accounts: { paper, live },
    positions,
    activeOrders: orders.filter((o) => unresolved.includes(o.state) && (!mode || o.mode === mode)),
    dataSource: 'PAPER_SIMULATOR and MEXC (Live)'
  });
});
