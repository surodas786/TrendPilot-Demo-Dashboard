import { createSignalRoute, getDb, getInstrument, listIngress, listSignalRoutes, recordAudit } from '@trendpilot/db';
import { DomainError, ErrorCode, signalRouteCreateSchema } from '@trendpilot/domain';
import { json, parseBody, route, validationError } from '@/server/http';
import { requireAdmin } from '@/server/session';

export const dynamic = 'force-dynamic';

export const GET = route(async (req, { correlationId }) => {
  await requireAdmin(req);
  return json(correlationId, { items: await listSignalRoutes(getDb()) });
});

/** SIG-04: map a TradingView source tuple to an approved contract and strategy lineage. */
export const POST = route(async (req, { correlationId }) => {
  const { user } = await requireAdmin(req);
  const input = await parseBody(req, signalRouteCreateSchema);
  const db = getDb();
  const inst = await getInstrument(db, input.instrumentId);
  if (!inst || inst.status !== 'PUBLISHED') throw validationError([{ path: 'instrumentId', message: 'Select a published pair.' }]);
  const [ingress] = await listIngress(db);
  if (!ingress) throw new DomainError(409, ErrorCode.CONFLICT, 'Create the TradingView webhook first.');
  const id = await db.transaction(async (tx) => {
    const routeId = await createSignalRoute(tx, ingress.id, input, user.id);
    await recordAudit(tx, { actorUserId: user.id, action: 'ADMIN_SIGNAL_ROUTE_CREATE', targetType: 'signal_route', targetId: routeId, result: 'SUCCESS', after: input, correlationId });
    return routeId;
  });
  return json(correlationId, { id }, 201);
});
