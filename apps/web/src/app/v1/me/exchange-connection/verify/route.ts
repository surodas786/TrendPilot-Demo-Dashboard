import { connectionDto, getDb, verifyBitunixConnection, verifyConnection } from '@trendpilot/db';
import { json, readJson, route } from '@/server/http';
import { exchangeOf } from '@/server/exchange';
import { requireInvestor } from '@/server/session';

export const dynamic = 'force-dynamic';

/**
 * POST [?exchange=] [{ exchange }]: re-runs the read-only verification for one exchange (default
 * MEXC). MEXC: signing, position mode, balances, positions, stops. Bitunix: position mode and the
 * USDT futures account.
 */
export const POST = route(async (req, { correlationId }) => {
  const { user } = await requireInvestor(req);
  const body = (await readJson(req).catch(() => ({}))) as Record<string, unknown>;
  const exchange = exchangeOf(req, body);
  const c = exchange === 'BITUNIX' ? await verifyBitunixConnection(getDb(), user.id, correlationId) : await verifyConnection(getDb(), user.id, correlationId);
  return json(correlationId, { connection: connectionDto(c) });
});
