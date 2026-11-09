import {
  conflictingRoute,
  deleteSignalRoute,
  getDb,
  getInstrument,
  lockSignalRoute,
  recordAudit,
  routeHistory,
  routeStrategyIssues,
  routingBreak,
  updateSignalRoute,
  type PublicUser,
  type SignalRouteRow
} from '@trendpilot/db';
import { DomainError, ErrorCode, notFound, type SignalRouteCreate } from '@trendpilot/domain';
import { validationError } from './http';
import { assertPackageActive } from './strategyPackages';

/**
 * UI-05 signal route maintenance. Every rule is enforced here, server-side, inside one transaction
 * with the route row locked: unique source tuple, strategy compatibility (interval and contract),
 * no routing break for open positions, delete only without history. Successful changes and
 * blocked attempts are audited.
 */

const routeView = (r: SignalRouteRow) => ({
  name: r.name,
  sourceExchange: r.sourceExchange,
  sourceSymbol: r.sourceSymbol,
  interval: r.interval as SignalRouteCreate['interval'], // DB check: '5' | '15'
  action: r.action,
  kind: r.kind,
  instrumentId: r.instrumentId,
  packageId: r.packageId,
  maxSignalAgeSeconds: r.maxSignalAgeSeconds,
  clockToleranceSeconds: r.clockToleranceSeconds,
  enabled: r.enabled
});

const conflict = () => new DomainError(409, ErrorCode.REVISION_CONFLICT, 'This route changed since you loaded it. Reload and try again.');
const duplicate = (name: string) => new DomainError(409, ErrorCode.DUPLICATE, `Another enabled route (“${name}”) already uses this source exchange, ticker, interval and action. Routes must be unambiguous.`);

async function denied(admin: PublicUser, action: string, id: string, reason: string, correlationId: string, detail: Record<string, unknown> = {}) {
  await recordAudit(getDb(), { actorUserId: admin.id, action, targetType: 'signal_route', targetId: id, result: 'DENIED', metadata: { reason, ...detail }, correlationId });
}

/** Contract must be a published pair; actionable routes must match their strategy. */
export async function checkRouteTarget(input: SignalRouteCreate): Promise<void> {
  const db = getDb();
  const inst = await getInstrument(db, input.instrumentId);
  if (!inst || inst.status !== 'PUBLISHED') throw validationError([{ path: 'instrumentId', message: 'Select a published pair.' }]);
  await assertPackageActive(input.packageId);
  const issues = await routeStrategyIssues(db, input);
  if (issues.length) throw validationError(issues);
}

export async function editSignalRoute(admin: PublicUser, id: string, revision: number, input: SignalRouteCreate, correlationId: string) {
  await checkRouteTarget(input);
  const outcome = await getDb().transaction(async (tx) => {
    const before = await lockSignalRoute(tx, id);
    if (!before) throw notFound();
    if (before.revision !== revision) throw conflict();
    if (before.enabled) {
      const dup = await conflictingRoute(tx, { id, ingressId: before.ingressId, ...input });
      if (dup) throw duplicate(dup.name);
    }
    const blocked = await routingBreak(tx, before, { ...input, enabled: before.enabled });
    if (blocked) return { blocked };
    const after = await updateSignalRoute(tx, id, revision, input);
    if (!after) throw conflict();
    await recordAudit(tx, { actorUserId: admin.id, action: 'ADMIN_SIGNAL_ROUTE_EDIT', targetType: 'signal_route', targetId: id, result: 'SUCCESS', before: routeView(before), after: routeView(after), correlationId });
    return { after };
  });
  if ('blocked' in outcome) {
    await denied(admin, 'ADMIN_SIGNAL_ROUTE_EDIT', id, 'OPEN_POSITIONS', correlationId);
    throw new DomainError(409, ErrorCode.CONFLICT, outcome.blocked!);
  }
  return { id, revision: outcome.after!.revision };
}

/** Enable/disable (existing control). Disabling is blocked when it would strand open positions. */
export async function setRouteEnabled(admin: PublicUser, id: string, revision: number, enabled: boolean, correlationId: string) {
  const outcome = await getDb().transaction(async (tx) => {
    const before = await lockSignalRoute(tx, id);
    if (!before) throw notFound();
    if (before.revision !== revision) throw conflict();
    if (enabled && !before.enabled) {
      const dup = await conflictingRoute(tx, before);
      if (dup) throw new DomainError(409, ErrorCode.DUPLICATE, 'Another enabled route already uses this source tuple.');
      if (before.kind === 'ACTIONABLE') {
        const issues = await routeStrategyIssues(tx, routeView(before));
        if (issues.length) throw validationError(issues);
      }
    }
    if (!enabled) {
      const blocked = await routingBreak(tx, before, null);
      if (blocked) return { blocked };
    }
    const after = await updateSignalRoute(tx, id, revision, { ...routeView(before), enabled });
    if (!after) throw conflict();
    await recordAudit(tx, { actorUserId: admin.id, action: 'ADMIN_SIGNAL_ROUTE_UPDATE', targetType: 'signal_route', targetId: id, result: 'SUCCESS', before: { enabled: before.enabled }, after: { enabled }, correlationId });
    return { after };
  });
  if ('blocked' in outcome) {
    await denied(admin, 'ADMIN_SIGNAL_ROUTE_UPDATE', id, 'OPEN_POSITIONS', correlationId, { enabled });
    throw new DomainError(409, ErrorCode.CONFLICT, outcome.blocked!);
  }
  return { id, enabled, revision: outcome.after!.revision };
}

/** Permanent deletion: only for a route without signal history that no open position depends on. */
export async function removeSignalRoute(admin: PublicUser, id: string, revision: number, correlationId: string) {
  const outcome = await getDb().transaction(async (tx) => {
    const before = await lockSignalRoute(tx, id);
    if (!before) throw notFound();
    if (before.revision !== revision) throw conflict();
    const history = await routeHistory(tx, id);
    if (history.events || history.rejections) return { history };
    const blocked = await routingBreak(tx, before, null);
    if (blocked) return { blocked };
    if (!(await deleteSignalRoute(tx, id, revision))) throw conflict();
    await recordAudit(tx, { actorUserId: admin.id, action: 'ADMIN_SIGNAL_ROUTE_DELETE', targetType: 'signal_route', targetId: id, result: 'SUCCESS', before: routeView(before), correlationId });
    return { deleted: true };
  });
  if ('history' in outcome) {
    const h = outcome.history!;
    await denied(admin, 'ADMIN_SIGNAL_ROUTE_DELETE', id, 'HAS_HISTORY', correlationId, h);
    throw new DomainError(
      409,
      ErrorCode.CONFLICT,
      `This route has signal history (${h.events} accepted event(s), ${h.rejections} rejection(s)) that must stay traceable, so it cannot be deleted. Disable it instead.`
    );
  }
  if ('blocked' in outcome) {
    await denied(admin, 'ADMIN_SIGNAL_ROUTE_DELETE', id, 'OPEN_POSITIONS', correlationId);
    throw new DomainError(409, ErrorCode.CONFLICT, outcome.blocked!);
  }
}
