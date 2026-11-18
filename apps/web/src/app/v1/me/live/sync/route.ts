import { bitunixRequesterFor, connectionDto, connectionFor, getDb, recordAudit, syncBitunixConnection, syncLiveAccount } from '@trendpilot/db';
import { DomainError, ErrorCode, exchangeLabel, isExchangeId } from '@trendpilot/domain';
import { bitunixLines, manualSyncUnavailable, mexcLines, type InvestorSyncResult } from '@/server/investorSync';
import { now } from '@/server/clock';
import { json, route } from '@/server/http';
import { requireInvestor } from '@/server/session';

export const dynamic = 'force-dynamic';

/**
 * POST /v1/me/live/sync?exchange=MEXC|BITUNIX — "Sync with <exchange>" on My Trades / My Holdings → Live.
 * Syncs the signed-in investor's OWN connection to the selected exchange (never another exchange,
 * never another investor) through that exchange's own sync path:
 *   MEXC    → syncLiveAccount (balances, positions, manual closes, fills, stop coverage, drift)
 *   BITUNIX → syncBitunixConnection (read-only Bitunix mirror: wallet, positions, closes, fills)
 *   LIGHTER → refused with the reason (the worker reconciles Lighter on its schedule)
 * Read-only towards the exchange: no order is placed, cancelled or retried, no signal replayed.
 * Without `exchange` it syncs MEXC (older clients).
 */
export const POST = route(async (req, { correlationId }) => {
  const { user } = await requireInvestor(req);
  const raw = (new URL(req.url).searchParams.get('exchange') ?? 'MEXC').toUpperCase();
  if (!isExchangeId(raw)) throw new DomainError(400, ErrorCode.VALIDATION_FAILED, 'exchange must be MEXC, BITUNIX or LIGHTER.');
  const exchange = raw;
  const db = getDb();
  const c = await connectionFor(db, user.id, exchange);
  if (!c || c.status === 'REVOKED') throw new DomainError(404, ErrorCode.NOT_FOUND, `No ${exchangeLabel(exchange)} connection is set up.`);
  const unavailable = manualSyncUnavailable(exchange);
  if (unavailable) throw new DomainError(409, ErrorCode.CONFLICT, unavailable);

  let ok: boolean;
  let busy = false;
  let error: string | null;
  let lines: string[];
  let drift: InvestorSyncResult['drift'] = [];
  let sync: unknown;
  let metadata: Record<string, unknown>;
  if (exchange === 'BITUNIX') {
    if (c.status !== 'VERIFIED') throw new DomainError(409, ErrorCode.CONFLICT, 'Verify your Bitunix connection on the Live Trading page first.');
    const r = await syncBitunixConnection(db, c.id, bitunixRequesterFor(c));
    ({ ok } = r);
    busy = !!r.busy;
    error = r.error ?? null;
    lines = bitunixLines(r);
    sync = r;
    metadata = { exchange, closed: r.closed, closePending: r.closePending, error };
  } else {
    const r = await syncLiveAccount(db, user.id, now());
    ({ ok } = r);
    busy = !!(r as { busy?: boolean }).busy;
    error = r.error ?? null;
    lines = mexcLines(r);
    drift = r.drift;
    sync = r;
    metadata = { exchange, exitsRecorded: r.exitsRecorded, closes: r.closes.map((x) => `${x.result} ${x.symbol}`), drift: r.drift.length, skipped: r.skipped.length, error };
  }
  await recordAudit(db, { actorUserId: user.id, action: 'INVESTOR_LIVE_SYNC', targetType: 'exchange_connection', targetId: c.id, result: ok ? 'SUCCESS' : 'FAILED', metadata, correlationId });
  const after = (await connectionFor(db, user.id, exchange))!;
  if (exchange === 'BITUNIX') drift = (after.drift ?? []) as InvestorSyncResult['drift'];
  const result: InvestorSyncResult = {
    exchange,
    connectionId: c.id,
    ok,
    busy,
    error,
    lines,
    drift,
    lastSyncAt: after.lastSyncAt?.toISOString() ?? null,
    lastSyncOkAt: after.lastSyncOkAt?.toISOString() ?? null,
    lastSyncError: after.lastSyncError
  };
  return json(correlationId, { exchange, result, sync, connection: connectionDto(after) });
});
