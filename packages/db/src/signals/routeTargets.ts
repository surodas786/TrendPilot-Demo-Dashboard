import { and, asc, eq, inArray } from 'drizzle-orm';
import { DomainError, ErrorCode } from '@trendpilot/domain';
import type { Db, Executor } from '../client';
import { recordAudit } from '../repos/audit';
import { instruments, signalRouteTargets, signalRoutes } from '../schema';

/**
 * Bitunix signal routing (Step 4): a signal route keeps its primary (MEXC) instrument and may name,
 * explicitly, ONE Bitunix instrument as an additional target for the same contract. An accepted
 * alert on that route is then dispatched to the order blocks of both instruments — each block once,
 * on its own exchange. Without a target nothing changes: existing MEXC routes behave exactly as
 * before. A target is accepted only for the same contract (platform symbol) on Bitunix, so an alert
 * can never reach another market or another exchange's block by accident.
 */

export type RouteTargetRow = typeof signalRouteTargets.$inferSelect;

export interface RouteTargetDto {
  id: string;
  routeId: string;
  exchange: string;
  instrumentId: string;
  symbol: string;
  exchangeSymbol: string;
  instrumentStatus: string;
  enabled: boolean;
  revision: number;
}

export async function routeTargets(db: Executor, routeIds: string[]): Promise<RouteTargetDto[]> {
  if (!routeIds.length) return [];
  const rows = await db
    .select({ t: signalRouteTargets, symbol: instruments.symbol, exchangeSymbol: instruments.exchangeSymbol, status: instruments.status })
    .from(signalRouteTargets)
    .innerJoin(instruments, eq(instruments.id, signalRouteTargets.instrumentId))
    .where(inArray(signalRouteTargets.routeId, routeIds))
    .orderBy(asc(signalRouteTargets.exchange));
  return rows.map((r) => ({ id: r.t.id, routeId: r.t.routeId, exchange: r.t.exchange, instrumentId: r.t.instrumentId, symbol: r.symbol, exchangeSymbol: r.exchangeSymbol, instrumentStatus: r.status, enabled: r.t.enabled, revision: r.t.revision }));
}

/** Instrument IDs an accepted event on this route also dispatches to (enabled targets only). */
export async function enabledTargetInstrumentIds(db: Executor, routeId: string): Promise<string[]> {
  const rows = await db
    .select({ id: signalRouteTargets.instrumentId })
    .from(signalRouteTargets)
    .where(and(eq(signalRouteTargets.routeId, routeId), eq(signalRouteTargets.enabled, true)));
  return rows.map((r) => r.id);
}

/**
 * Sets (or replaces) the Bitunix target of a route, or disables it. Validates: the instrument is a
 * Bitunix instrument for the same contract as the route's primary instrument.
 */
export async function setBitunixRouteTarget(db: Db, adminId: string, routeId: string, input: { instrumentId: string | null; enabled?: boolean }, correlationId = 'route-target'): Promise<RouteTargetDto | null> {
  return db.transaction(async (tx) => {
    const [route] = await tx.select().from(signalRoutes).where(eq(signalRoutes.id, routeId)).for('update');
    if (!route) throw new DomainError(404, ErrorCode.NOT_FOUND, 'Signal route not found.');
    const [current] = await tx.select().from(signalRouteTargets).where(and(eq(signalRouteTargets.routeId, routeId), eq(signalRouteTargets.exchange, 'BITUNIX')));
    if (!input.instrumentId) {
      if (current) {
        await tx.delete(signalRouteTargets).where(eq(signalRouteTargets.id, current.id));
        await recordAudit(tx, { actorUserId: adminId, action: 'ADMIN_SIGNAL_ROUTE_TARGET_REMOVE', targetType: 'signal_route', targetId: routeId, result: 'SUCCESS', before: { instrumentId: current.instrumentId }, correlationId });
      }
      return null;
    }
    const [primary] = await tx.select().from(instruments).where(eq(instruments.id, route.instrumentId));
    const [inst] = await tx.select().from(instruments).where(eq(instruments.id, input.instrumentId));
    if (!inst) throw new DomainError(404, ErrorCode.NOT_FOUND, 'Instrument not found.');
    if (inst.exchange !== 'BITUNIX') throw new DomainError(400, ErrorCode.VALIDATION_FAILED, 'Only a Bitunix instrument can be added as a route target; the route’s own instrument stays its MEXC target.');
    if (!primary || inst.symbol !== primary.symbol) {
      throw new DomainError(409, ErrorCode.CONFLICT, `This route delivers ${primary?.symbol ?? 'another contract'} signals; ${inst.symbol} on Bitunix is a different contract.`);
    }
    const enabled = input.enabled ?? true;
    const [row] = current
      ? await tx.update(signalRouteTargets).set({ instrumentId: inst.id, enabled, revision: current.revision + 1, updatedAt: new Date() }).where(eq(signalRouteTargets.id, current.id)).returning()
      : await tx.insert(signalRouteTargets).values({ routeId, instrumentId: inst.id, exchange: 'BITUNIX', enabled, createdBy: adminId }).returning();
    await recordAudit(tx, {
      actorUserId: adminId,
      action: 'ADMIN_SIGNAL_ROUTE_TARGET_SET',
      targetType: 'signal_route',
      targetId: routeId,
      result: 'SUCCESS',
      before: current ? { instrumentId: current.instrumentId, enabled: current.enabled } : null,
      after: { exchange: 'BITUNIX', instrumentId: inst.id, symbol: inst.symbol, enabled },
      correlationId
    });
    return (await routeTargets(tx, [routeId])).find((t) => t.id === row!.id) ?? null;
  });
}

/** For a block's instrument: the TradingView routes that deliver signals to it (primary or target). */
export async function routesDeliveringTo(db: Executor, instrumentId: string): Promise<{ routeId: string; name: string; source: string; interval: string; action: string; enabled: boolean; via: 'PRIMARY' | 'BITUNIX_TARGET' }[]> {
  const primary = await db.select().from(signalRoutes).where(eq(signalRoutes.instrumentId, instrumentId));
  const targeted = await db
    .select({ r: signalRoutes, t: signalRouteTargets })
    .from(signalRouteTargets)
    .innerJoin(signalRoutes, eq(signalRoutes.id, signalRouteTargets.routeId))
    .where(eq(signalRouteTargets.instrumentId, instrumentId));
  return [
    ...primary.map((r) => ({ routeId: r.id, name: r.name, source: `${r.sourceExchange}:${r.sourceSymbol}`, interval: r.interval, action: r.action, enabled: r.enabled, via: 'PRIMARY' as const })),
    ...targeted.map(({ r, t }) => ({ routeId: r.id, name: r.name, source: `${r.sourceExchange}:${r.sourceSymbol}`, interval: r.interval, action: r.action, enabled: r.enabled && t.enabled, via: 'BITUNIX_TARGET' as const }))
  ];
}
