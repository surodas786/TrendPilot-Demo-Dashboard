import { bitunixAccountView, bitunixRequesterFor, connectionDto, connectionFor, getDb, syncBitunixConnection, syncLighterConnection } from '@trendpilot/db';
import { DomainError, ErrorCode } from '@trendpilot/domain';
import { json, route } from '@/server/http';
import { connectionExchangeOf } from '@/server/exchange';
import { lighterAccountView } from '@/server/live';
import { requireInvestor } from '@/server/session';

export const dynamic = 'force-dynamic';

/**
 * POST ?exchange=BITUNIX|LIGHTER: reconciliation of the investor's OWN connection now. Nothing is
 * sent to the exchange except reads (Lighter: plus a stop resize for a remainder, only when that
 * capability is verified). MEXC keeps its own sync (POST /v1/me/live/sync).
 */
export const POST = route(async (req, { correlationId }) => {
  const { user } = await requireInvestor(req);
  const exchange = connectionExchangeOf(req);
  if (exchange === 'MEXC') throw new DomainError(400, ErrorCode.VALIDATION_FAILED, 'Use POST /v1/me/live/sync for the MEXC account.');
  const db = getDb();
  const name = exchange === 'LIGHTER' ? 'Lighter' : 'Bitunix';
  const conn = await connectionFor(db, user.id, exchange);
  if (!conn || conn.status === 'REVOKED') throw new DomainError(404, ErrorCode.NOT_FOUND, `No ${name} connection is set up.`);
  if (conn.status !== 'VERIFIED') throw new DomainError(409, ErrorCode.CONFLICT, `Check the ${name} connection first; only a verified key is synced.`);
  if (exchange === 'LIGHTER') {
    const sync = await syncLighterConnection(db, conn.id, new Date());
    const fresh = (await connectionFor(db, user.id, 'LIGHTER'))!;
    return json(correlationId, { sync, connection: connectionDto(fresh), account: lighterAccountView(fresh) }, sync.busy ? 409 : 200);
  }
  const sync = await syncBitunixConnection(db, conn.id, bitunixRequesterFor(conn));
  const fresh = (await connectionFor(db, user.id, 'BITUNIX'))!;
  return json(correlationId, { sync, connection: connectionDto(fresh), account: await bitunixAccountView(db, fresh) }, sync.busy ? 409 : 200);
});
