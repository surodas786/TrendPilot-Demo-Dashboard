import { bitunixAccountView, bitunixRequesterFor, connectionDto, connectionFor, getDb, syncBitunixConnection } from '@trendpilot/db';
import { DomainError, ErrorCode } from '@trendpilot/domain';
import { json, route } from '@/server/http';
import { exchangeOf } from '@/server/exchange';
import { requireInvestor } from '@/server/session';

export const dynamic = 'force-dynamic';

/**
 * POST ?exchange=BITUNIX: read-only reconciliation of the investor's OWN Bitunix connection now
 * (balance, position mode, positions, pending orders, TP/SL, fills and history). Nothing is sent
 * to Bitunix except allowlisted queries. MEXC keeps its own sync (POST /v1/me/live/sync).
 */
export const POST = route(async (req, { correlationId }) => {
  const { user } = await requireInvestor(req);
  const exchange = exchangeOf(req);
  if (exchange !== 'BITUNIX') throw new DomainError(400, ErrorCode.VALIDATION_FAILED, 'Use POST /v1/me/live/sync for the MEXC account.');
  const db = getDb();
  const conn = await connectionFor(db, user.id, 'BITUNIX');
  if (!conn || conn.status === 'REVOKED') throw new DomainError(404, ErrorCode.NOT_FOUND, 'No Bitunix connection is set up.');
  if (conn.status !== 'VERIFIED') throw new DomainError(409, ErrorCode.CONFLICT, 'Check the Bitunix connection first; only a verified key is synced.');
  const sync = await syncBitunixConnection(db, conn.id, bitunixRequesterFor(conn));
  const fresh = (await connectionFor(db, user.id, 'BITUNIX'))!;
  return json(correlationId, { sync, connection: connectionDto(fresh), account: await bitunixAccountView(db, fresh) }, sync.busy ? 409 : 200);
});
