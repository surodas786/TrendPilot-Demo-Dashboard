import { getDb, getMyPaperAccount, listMyHoldings, listMyOrders } from '@trendpilot/db';
import { DomainError, ErrorCode } from '@trendpilot/domain';
import { now } from '@/server/clock';
import { json, route } from '@/server/http';
import { requireInvestor } from '@/server/session';

export const dynamic = 'force-dynamic';

/**
 * GET /v1/me/holdings[?mode=PAPER|LIVE][&exchange=MEXC|BITUNIX] (UI-02, REP-04): own balances (Paper, MEXC
 * Live and Bitunix Live separately; `exchange` limits positions and orders to one exchange),
 * open positions priced from the newest public quote (current and mark price, unrealized P&L,
 * stop coverage, liquidation: estimated for Paper, as reported by the exchange for Live) and active orders.
 * Every position and order carries its mode. A position without a price shows null (unavailable).
 */
export const GET = route(async (req, { correlationId }) => {
  const { user } = await requireInvestor(req);
  const q = (new URL(req.url).searchParams.get('mode') ?? '').toUpperCase();
  if (q && q !== 'PAPER' && q !== 'LIVE') throw new DomainError(422, ErrorCode.VALIDATION_FAILED, 'mode must be PAPER or LIVE.');
  const mode = (q || undefined) as 'PAPER' | 'LIVE' | undefined;
  const x = (new URL(req.url).searchParams.get('exchange') ?? '').toUpperCase();
  if (x && x !== 'MEXC' && x !== 'BITUNIX' && x !== 'LIGHTER') throw new DomainError(422, ErrorCode.VALIDATION_FAILED, 'exchange must be MEXC, BITUNIX or LIGHTER.');
  const exchange = (x || undefined) as 'MEXC' | 'BITUNIX' | 'LIGHTER' | undefined;
  const db = getDb();
  const at = now();
  const [paper, lighterPaper, live, bitunixLive, positions, orders] = await Promise.all([
    getMyPaperAccount(db, user.id, 'PAPER'),
    getMyPaperAccount(db, user.id, 'PAPER', 'LIGHTER'),
    getMyPaperAccount(db, user.id, 'LIVE'),
    getMyPaperAccount(db, user.id, 'LIVE', 'BITUNIX'),
    listMyHoldings(db, user.id, at, mode, exchange),
    listMyOrders(db, user.id)
  ]);
  const unresolved = ['INTENT', 'SUBMITTING', 'ACKNOWLEDGED', 'PARTIALLY_FILLED', 'UNKNOWN'];
  return json(correlationId, {
    mode: mode ?? 'ALL',
    asOf: at.toISOString(),
    account: paper,
    exchange: exchange ?? 'ALL',
    accounts: { paper, lighterPaper, live, bitunixLive },
    positions,
    activeOrders: orders.filter((o) => unresolved.includes(o.state) && (!mode || o.mode === mode) && (!exchange || o.exchange === exchange)),
    dataSource: 'PAPER_SIMULATOR (MEXC USDT and Lighter USDC accounts), MEXC (Live) and Bitunix (Live)'
  });
});
