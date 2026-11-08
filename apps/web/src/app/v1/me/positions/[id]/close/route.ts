import { and, eq } from 'drizzle-orm';
import { getDb, recordAudit, requestExit, schema } from '@trendpilot/db';
import { DomainError, ErrorCode, notFound } from '@trendpilot/domain';
import { now } from '@/server/clock';
import { json, route } from '@/server/http';
import { requireInvestor } from '@/server/session';

export const dynamic = 'force-dynamic';

const KEY = /^[A-Za-z0-9_.:-]{8,100}$/;

/**
 * POST /v1/me/positions/{id}/close (§10.1, EXT-05): full managed-position market close.
 * Requires an Idempotency-Key. Returns 202 with the command ID; the worker rechecks ownership
 * and the confirmed remaining quantity before sending a reduce-only close.
 */
export const POST = route<{ id: string }>(async (req, { correlationId, params }) => {
  const { user } = await requireInvestor(req);
  const key = req.headers.get('idempotency-key')?.trim();
  if (!key || !KEY.test(key)) throw new DomainError(400, ErrorCode.IDEMPOTENCY_KEY_REQUIRED, 'Send an Idempotency-Key header (8–100 characters).');
  if (!/^[0-9a-f-]{36}$/i.test(params.id)) throw notFound();

  const db = getDb();
  const result = await db.transaction(async (tx) => {
    // Same key again: same command, provided the input (position) is the same.
    const [prior] = await tx
      .select()
      .from(schema.orderIntents)
      .where(and(eq(schema.orderIntents.ownerId, user.id), eq(schema.orderIntents.idempotencyKey, key)));
    if (prior) {
      if (prior.positionId !== params.id) throw new DomainError(422, ErrorCode.IDEMPOTENCY_KEY_REUSED, 'This Idempotency-Key was already used for a different request.');
      return { commandId: prior.id, state: prior.state, replayed: true };
    }
    // IAM-02: the position must belong to the session user; otherwise it does not exist for them.
    const [pos] = await tx
      .select()
      .from(schema.positions)
      .where(and(eq(schema.positions.id, params.id), eq(schema.positions.ownerId, user.id)))
      .for('update');
    if (!pos) throw notFound();
    if (pos.status !== 'OPEN') throw new DomainError(409, ErrorCode.POSITION_NOT_OPEN, 'This position is already closed.');
    const r = await requestExit(tx, { position: pos, reason: 'MANUAL_CLOSE', now: now(), idempotencyKey: key, requestedBy: user.id });
    if (r.status === 'IN_PROGRESS') throw new DomainError(409, ErrorCode.EXIT_IN_PROGRESS, 'Another exit for this position is already in progress.');
    if (r.status === 'NOT_OPEN') throw new DomainError(409, ErrorCode.POSITION_NOT_OPEN, 'This position is already closed.');
    await recordAudit(tx, {
      actorUserId: user.id,
      action: 'POSITION_MANUAL_CLOSE_REQUEST',
      targetType: 'position',
      targetId: pos.id,
      result: 'SUCCESS',
      metadata: { commandId: r.intentId, contracts: pos.contracts, mode: pos.mode },
      correlationId
    });
    return { commandId: r.intentId, state: 'INTENT', replayed: false };
  });
  return json(correlationId, { commandId: result.commandId, positionId: params.id, state: result.state, replayed: result.replayed }, 202, { location: `/v1/me/commands/${result.commandId}` });
});
