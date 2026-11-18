import { connectionDto, getDb, verifyBitunixConnection, verifyConnection, verifyLighterConnection } from '@trendpilot/db';
import { json, readJson, route } from '@/server/http';
import { connectionExchangeOf } from '@/server/exchange';
import { lighterAccountView } from '@/server/live';
import { requireInvestor } from '@/server/session';

export const dynamic = 'force-dynamic';

/**
 * POST [?exchange=] [{ exchange }]: re-runs the verification for one exchange (default MEXC); no
 * order is sent. MEXC: signing, position mode, balances, positions, stops. Bitunix: position mode
 * and the USDT futures account. Lighter: account, API key registration and key match; permission
 * to trade is reported separately.
 */
export const POST = route(async (req, { correlationId }) => {
  const { user } = await requireInvestor(req);
  const body = (await readJson(req).catch(() => ({}))) as Record<string, unknown>;
  const exchange = connectionExchangeOf(req, body);
  const db = getDb();
  if (exchange === 'LIGHTER') {
    const c = await verifyLighterConnection(db, user.id, correlationId);
    return json(correlationId, { connection: connectionDto(c), account: lighterAccountView(c) });
  }
  const c = exchange === 'BITUNIX' ? await verifyBitunixConnection(db, user.id, correlationId) : await verifyConnection(db, user.id, correlationId);
  return json(correlationId, { connection: connectionDto(c) });
});
