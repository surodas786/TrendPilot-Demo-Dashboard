import { bitunixRequesterFor, getDb, recordAudit, schema, syncBitunixConnection, syncLiveAccount } from '@trendpilot/db';
import { DomainError, ErrorCode } from '@trendpilot/domain';
import { eq } from 'drizzle-orm';
import { now } from '@/server/clock';
import { json, route } from '@/server/http';
import { requireAdmin } from '@/server/session';

export const dynamic = 'force-dynamic';

/** POST: runs the private sync for one connection now: MEXC (balances, positions, fills, stops, drift) or Bitunix (read-only mirror). */
export const POST = route<{ id: string }>(async (req, { correlationId, params }) => {
  const { user } = await requireAdmin(req);
  const db = getDb();
  const [c] = await db.select().from(schema.exchangeConnections).where(eq(schema.exchangeConnections.id, params.id));
  if (!c) throw new DomainError(404, ErrorCode.NOT_FOUND, 'Exchange connection not found.');
  if (c.exchange === 'BITUNIX') {
    // Read-only reconciliation of that investor's Bitunix account (queries only).
    if (c.status !== 'VERIFIED') throw new DomainError(409, ErrorCode.CONFLICT, 'Only a verified Bitunix connection is synced.');
    const r = await syncBitunixConnection(db, c.id, bitunixRequesterFor(c));
    await recordAudit(db, { actorUserId: user.id, action: 'ADMIN_LIVE_SYNC', targetType: 'exchange_connection', targetId: c.id, result: r.ok ? 'SUCCESS' : 'FAILED', metadata: { exchange: 'BITUNIX', closed: r.closed, closePending: r.closePending, error: r.error ?? null }, correlationId });
    return json(correlationId, { sync: r }, r.busy ? 409 : 200);
  }
  const r = await syncLiveAccount(db, c.ownerId, now());
  await recordAudit(db, { actorUserId: user.id, action: 'ADMIN_LIVE_SYNC', targetType: 'exchange_connection', targetId: c.id, result: r.ok ? 'SUCCESS' : 'FAILED', metadata: { exitsRecorded: r.exitsRecorded, drift: r.drift.length, error: r.error ?? null }, correlationId });
  return json(correlationId, { sync: r });
});
