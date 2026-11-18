import { getDb, getMyDashboard } from '@trendpilot/db';
import { DomainError, ErrorCode, isIsoDate } from '@trendpilot/domain';
import { now } from '@/server/clock';
import { json, route } from '@/server/http';
import { requireInvestor } from '@/server/session';

export const dynamic = 'force-dynamic';

/**
 * GET /v1/me/dashboard[?date=YYYY-MM-DD][&mode=PAPER|LIVE][&exchange=MEXC|BITUNIX] (UI-01): the signed-in
 * investor's own balances for one mode and, for Live, one exchange (MEXC by default). Paper, MEXC Live
 * and Bitunix Live are separate accounts, reported separately and never summed;
 * daily realized P&L in their reporting timezone, unrealized P&L, data freshness and a ledger
 * reconciliation. Owner-scoped: there is no parameter that selects another investor.
 */
export const GET = route(async (req, { correlationId }) => {
  const { user } = await requireInvestor(req);
  const q = new URL(req.url).searchParams;
  const date = q.get('date') ?? undefined;
  if (date !== undefined && !isIsoDate(date)) throw new DomainError(422, ErrorCode.VALIDATION_FAILED, 'date must be YYYY-MM-DD.');
  const mode = (q.get('mode') ?? 'PAPER').toUpperCase();
  if (mode !== 'PAPER' && mode !== 'LIVE') throw new DomainError(422, ErrorCode.VALIDATION_FAILED, 'mode must be PAPER or LIVE.');
  const exchange = (q.get('exchange') ?? 'MEXC').toUpperCase();
  if (exchange !== 'MEXC' && exchange !== 'BITUNIX' && exchange !== 'LIGHTER') throw new DomainError(422, ErrorCode.VALIDATION_FAILED, 'exchange must be MEXC, BITUNIX or LIGHTER.');
  if (exchange === 'LIGHTER' && mode !== 'PAPER') throw new DomainError(422, ErrorCode.VALIDATION_FAILED, 'Lighter is reported in Paper only.');
  if (exchange === 'BITUNIX' && mode !== 'LIVE') throw new DomainError(422, ErrorCode.VALIDATION_FAILED, 'Bitunix is reported in Live only.');
  return json(correlationId, await getMyDashboard(getDb(), { id: user.id, timezone: user.timezone }, { now: now(), date, mode, exchange }));
});
