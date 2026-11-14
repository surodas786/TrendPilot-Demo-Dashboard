import { connectionDto, connectionFor, getDb, recordAudit, syncLiveAccount } from '@trendpilot/db';
import { DomainError, ErrorCode } from '@trendpilot/domain';
import { now } from '@/server/clock';
import { json, route } from '@/server/http';
import { requireInvestor } from '@/server/session';

export const dynamic = 'force-dynamic';

/**
 * POST: "Sync with MEXC" on My Trades → Live. Runs the same private sync as the worker for the
 * signed-in investor's own account only: balances, positions, manual closes on MEXC, fills and stop
 * coverage. Read-only towards MEXC — this run never sends, replaces or cancels an order (no
 * protective close), never replays a signal and never opens an entry.
 */
export const POST = route(async (req, { correlationId }) => {
  const { user } = await requireInvestor(req);
  const db = getDb();
  const c = await connectionFor(db, user.id);
  if (!c || c.status === 'REVOKED') throw new DomainError(404, ErrorCode.NOT_FOUND, 'No exchange connection is set up.');
  const r = await syncLiveAccount(db, user.id, now(), { protectiveClose: false });
  await recordAudit(db, {
    actorUserId: user.id,
    action: 'INVESTOR_LIVE_SYNC',
    targetType: 'exchange_connection',
    targetId: c.id,
    result: r.ok ? 'SUCCESS' : 'FAILED',
    metadata: { exitsRecorded: r.exitsRecorded, closes: r.closes.map((x) => `${x.result} ${x.symbol}`), drift: r.drift.length, skipped: r.skipped.length, error: r.error ?? null },
    correlationId
  });
  return json(correlationId, { sync: r, connection: connectionDto((await connectionFor(db, user.id))!) });
});
