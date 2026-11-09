import { and, count, desc, eq, isNotNull, ne, sql } from 'drizzle-orm';
import type { SignalRouteCreate } from '@trendpilot/domain';
import type { Executor } from '../client';
import { instruments, positions, signalEvents, signalRejections, signalRoutes, strategyPackages, strategyVersionInstruments, strategyVersions } from '../schema';

/**
 * UI-05 route maintenance (edit, delete) and its safety rules. Pure reads and single-row writes;
 * the web layer runs them in one transaction with the route row locked and audits the outcome.
 */

export type SignalRouteRow = typeof signalRoutes.$inferSelect;

/** Newest published version of a package: the strategy a route's signals are judged against. */
export async function latestPublishedVersion(db: Executor, packageId: string): Promise<{ id: string; version: number; timeframe: '5m' | '15m'; instrumentIds: string[] } | null> {
  const [v] = await db
    .select({ id: strategyVersions.id, version: strategyVersions.version, timeframe: strategyVersions.timeframe })
    .from(strategyVersions)
    .where(and(eq(strategyVersions.packageId, packageId), isNotNull(strategyVersions.publishedAt)))
    .orderBy(desc(strategyVersions.version))
    .limit(1);
  if (!v) return null;
  const maps = await db.select({ i: strategyVersionInstruments.instrumentId }).from(strategyVersionInstruments).where(eq(strategyVersionInstruments.versionId, v.id));
  return { ...v, instrumentIds: maps.map((m) => m.i) };
}

/**
 * An actionable route must match its strategy: the package's newest published version uses the
 * route's interval and approves the route's contract. Returns field issues (empty = compatible).
 * Information-only routes never trade, so they are not checked.
 */
export async function routeStrategyIssues(db: Executor, r: Pick<SignalRouteCreate, 'kind' | 'packageId' | 'instrumentId' | 'interval'>): Promise<{ path: string; message: string }[]> {
  if (r.kind !== 'ACTIONABLE') return [];
  const [pkg] = await db.select({ name: strategyPackages.name }).from(strategyPackages).where(eq(strategyPackages.id, r.packageId));
  if (!pkg) return [{ path: 'packageId', message: 'Unknown strategy lineage.' }];
  const v = await latestPublishedVersion(db, r.packageId);
  if (!v) return [{ path: 'packageId', message: `${pkg.name} has no published version yet. Publish one before routing signals to it.` }];
  const issues: { path: string; message: string }[] = [];
  if (v.timeframe !== `${r.interval}m`) {
    issues.push({ path: 'interval', message: `${pkg.name}: its newest published version v${v.version} uses ${v.timeframe}, but this route is ${r.interval}m. Choose ${v.timeframe.replace('m', '')}m or a lineage whose current version uses ${r.interval}m.` });
  }
  if (!v.instrumentIds.includes(r.instrumentId)) {
    const [inst] = await db.select({ symbol: instruments.symbol }).from(instruments).where(eq(instruments.id, r.instrumentId));
    issues.push({ path: 'instrumentId', message: `${pkg.name} v${v.version} does not approve ${inst?.symbol ?? 'this contract'}. Approve it in a new strategy version or pick an approved contract.` });
  }
  return issues;
}

/** Signal history that makes a route undeletable (events reference it; rejections record it). */
export async function routeHistory(db: Executor, routeId: string): Promise<{ events: number; rejections: number }> {
  // Sequential: inside a transaction all queries share one connection.
  const [e] = await db.select({ n: count() }).from(signalEvents).where(eq(signalEvents.routeId, routeId));
  const [r] = await db.select({ n: count() }).from(signalRejections).where(eq(signalRejections.routeId, routeId));
  return { events: Number(e?.n ?? 0), rejections: Number(r?.n ?? 0) };
}

/** Open positions whose exits arrive through routes for this contract and strategy lineage. */
export async function openPositionsFor(db: Executor, instrumentId: string, packageId: string): Promise<number> {
  const [r] = await db
    .select({ n: count() })
    .from(positions)
    .innerJoin(strategyVersions, eq(strategyVersions.id, positions.strategyVersionId))
    .where(and(eq(positions.instrumentId, instrumentId), eq(strategyVersions.packageId, packageId), eq(positions.status, 'OPEN')));
  return Number(r?.n ?? 0);
}

const ROUTING_FIELDS = ['sourceExchange', 'sourceSymbol', 'interval', 'action', 'kind', 'instrumentId', 'packageId'] as const;

/**
 * Would replacing `before` with `after` (null = delete or disable) cut off signals to open positions?
 * A route matters to open positions when it is enabled and actionable. It may change freely when
 * only non-routing fields change, or when another enabled actionable route still delivers the same
 * action to the same contract and lineage. Returns an explanation when the change must be blocked.
 */
export async function routingBreak(db: Executor, before: SignalRouteRow, after: (Pick<SignalRouteRow, (typeof ROUTING_FIELDS)[number]> & { enabled: boolean }) | null): Promise<string | null> {
  if (!before.enabled || before.kind !== 'ACTIONABLE') return null;
  if (after && after.enabled && ROUTING_FIELDS.every((k) => after[k] === before[k])) return null;
  const open = await openPositionsFor(db, before.instrumentId, before.packageId);
  if (!open) return null;
  const [other] = await db
    .select({ id: signalRoutes.id })
    .from(signalRoutes)
    .where(
      and(
        ne(signalRoutes.id, before.id),
        eq(signalRoutes.enabled, true),
        eq(signalRoutes.kind, 'ACTIONABLE'),
        eq(signalRoutes.instrumentId, before.instrumentId),
        eq(signalRoutes.packageId, before.packageId),
        eq(signalRoutes.action, before.action)
      )
    )
    .limit(1);
  if (other) return null;
  const [names] = await db
    .select({ symbol: instruments.symbol, pkg: strategyPackages.name })
    .from(instruments)
    .innerJoin(strategyPackages, eq(strategyPackages.id, before.packageId))
    .where(eq(instruments.id, before.instrumentId));
  const what = after === null ? 'Removing or disabling this route' : 'This change';
  return `${what} would stop ${before.action} signals from ${before.sourceExchange}:${before.sourceSymbol} ${before.interval}m reaching ${open} open position(s) on ${names?.symbol ?? 'this contract'} under ${names?.pkg ?? 'this lineage'}, and no other enabled route delivers them. Close those positions first, or add and enable a replacement route for the same contract, lineage and action, then try again.`;
}

export async function lockSignalRoute(db: Executor, id: string): Promise<SignalRouteRow | null> {
  const [row] = await db.select().from(signalRoutes).where(eq(signalRoutes.id, id)).for('update');
  return row ?? null;
}

/** Another ENABLED route with the same source tuple (routes must stay unambiguous). */
export async function conflictingRoute(db: Executor, r: { id?: string; ingressId: string; sourceExchange: string; sourceSymbol: string; interval: string; action: string }): Promise<{ id: string; name: string } | null> {
  const [row] = await db
    .select({ id: signalRoutes.id, name: signalRoutes.name })
    .from(signalRoutes)
    .where(
      and(
        r.id ? ne(signalRoutes.id, r.id) : sql`true`,
        eq(signalRoutes.ingressId, r.ingressId),
        eq(signalRoutes.sourceExchange, r.sourceExchange),
        eq(signalRoutes.sourceSymbol, r.sourceSymbol),
        eq(signalRoutes.interval, r.interval),
        eq(signalRoutes.action, r.action as SignalRouteRow['action']),
        eq(signalRoutes.enabled, true)
      )
    )
    .limit(1);
  return row ?? null;
}

/** Full update of a route's settings (revision-checked). The caller holds the row lock. */
export async function updateSignalRoute(db: Executor, id: string, revision: number, input: SignalRouteCreate & { enabled?: boolean }): Promise<SignalRouteRow | null> {
  const [row] = await db
    .update(signalRoutes)
    .set({ ...input, revision: sql`${signalRoutes.revision} + 1`, updatedAt: sql`now()` })
    .where(and(eq(signalRoutes.id, id), eq(signalRoutes.revision, revision)))
    .returning();
  return row ?? null;
}

export async function deleteSignalRoute(db: Executor, id: string, revision: number): Promise<boolean> {
  const rows = await db
    .delete(signalRoutes)
    .where(and(eq(signalRoutes.id, id), eq(signalRoutes.revision, revision)))
    .returning({ id: signalRoutes.id });
  return rows.length > 0;
}
