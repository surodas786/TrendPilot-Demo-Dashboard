import { and, desc, eq, sql } from 'drizzle-orm';
import { DomainError, ErrorCode, type SignalRouteCreate } from '@trendpilot/domain';
import type { Executor } from '../client';
import { instruments, jobs, signalDecisions, signalEvents, signalRejections, signalRoutes, strategyPackages } from '../schema';

/** Operations views for administrators. Aggregates only: no investor identity or private settings. */

export interface SignalRouteDto {
  id: string;
  ingressId: string;
  name: string;
  sourceExchange: string;
  sourceSymbol: string;
  interval: string;
  action: string;
  kind: 'ACTIONABLE' | 'INFO_ONLY';
  instrument: { id: string; symbol: string };
  package: { id: string; name: string };
  maxSignalAgeSeconds: number;
  clockToleranceSeconds: number;
  enabled: boolean;
  revision: number;
}

export async function listSignalRoutes(db: Executor): Promise<SignalRouteDto[]> {
  const rows = await db
    .select({ r: signalRoutes, symbol: instruments.symbol, packageName: strategyPackages.name })
    .from(signalRoutes)
    .innerJoin(instruments, eq(instruments.id, signalRoutes.instrumentId))
    .innerJoin(strategyPackages, eq(strategyPackages.id, signalRoutes.packageId))
    .orderBy(signalRoutes.sourceSymbol, signalRoutes.interval, signalRoutes.action);
  return rows.map(({ r, symbol, packageName }) => ({
    id: r.id,
    ingressId: r.ingressId,
    name: r.name,
    sourceExchange: r.sourceExchange,
    sourceSymbol: r.sourceSymbol,
    interval: r.interval,
    action: r.action,
    kind: r.kind,
    instrument: { id: r.instrumentId, symbol },
    package: { id: r.packageId, name: packageName },
    maxSignalAgeSeconds: r.maxSignalAgeSeconds,
    clockToleranceSeconds: r.clockToleranceSeconds,
    enabled: r.enabled,
    revision: r.revision
  }));
}

export async function createSignalRoute(db: Executor, ingressId: string, input: SignalRouteCreate, createdBy: string | null): Promise<string> {
  try {
    const [row] = await db
      .insert(signalRoutes)
      .values({ ingressId, ...input, createdBy })
      .returning({ id: signalRoutes.id });
    return row!.id;
  } catch (e) {
    const code = (e as { code?: string; cause?: { code?: string } }).code ?? (e as { cause?: { code?: string } }).cause?.code;
    if (code === '23505') throw new DomainError(409, ErrorCode.DUPLICATE, 'An enabled route already exists for this source, interval and action. Routes must be unambiguous.');
    throw e;
  }
}

export async function setSignalRouteEnabled(db: Executor, id: string, revision: number, enabled: boolean): Promise<'OK' | 'NOT_FOUND' | 'REVISION_CONFLICT' | 'AMBIGUOUS'> {
  const [cur] = await db.select({ id: signalRoutes.id }).from(signalRoutes).where(eq(signalRoutes.id, id));
  if (!cur) return 'NOT_FOUND';
  try {
    const rows = await db
      .update(signalRoutes)
      .set({ enabled, revision: sql`${signalRoutes.revision} + 1`, updatedAt: sql`now()` })
      .where(and(eq(signalRoutes.id, id), eq(signalRoutes.revision, revision)))
      .returning({ id: signalRoutes.id });
    return rows.length ? 'OK' : 'REVISION_CONFLICT';
  } catch (e) {
    const code = (e as { code?: string }).code ?? (e as { cause?: { code?: string } }).cause?.code;
    if (code === '23505') return 'AMBIGUOUS';
    throw e;
  }
}

export interface SignalEventOpsDto {
  id: string;
  action: string;
  source: string;
  interval: string;
  barOpenAt: string;
  barCloseAt: string;
  alertFiredAt: string;
  receivedAt: string;
  referencePrice: string;
  disposition: string;
  status: string;
  job: { status: string; attempts: number; lastError: string | null } | null;
  /** Counts only — investor identity and settings are never shown to operations. */
  outcomes: Record<string, number>;
}

export async function listRecentSignalEvents(db: Executor, limit = 50): Promise<SignalEventOpsDto[]> {
  const events = await db.select().from(signalEvents).orderBy(desc(signalEvents.receivedAt)).limit(Math.min(limit, 200));
  if (!events.length) return [];
  const ids = events.map((e) => e.id);
  const counts = await db
    .select({ eventId: signalDecisions.eventId, key: sql<string>`${signalDecisions.status} || coalesce(':' || ${signalDecisions.reason}, '')`, n: sql<number>`count(*)::int` })
    .from(signalDecisions)
    .where(sql`${signalDecisions.eventId} IN (${sql.join(ids.map((i) => sql`${i}::uuid`), sql`, `)})`)
    .groupBy(signalDecisions.eventId, sql`2`);
  const jobRows = await db
    .select({ key: jobs.dedupeKey, status: jobs.status, attempts: jobs.attempts, lastError: jobs.lastError })
    .from(jobs)
    .where(sql`${jobs.dedupeKey} IN (${sql.join(ids.map((i) => sql`${'signal.dispatch:' + i}`), sql`, `)})`);
  return events.map((e) => {
    const j = jobRows.find((x) => x.key === `signal.dispatch:${e.id}`);
    return {
      id: e.id,
      action: e.action,
      source: `${e.sourceExchange}:${e.sourceSymbol}`,
      interval: e.interval,
      barOpenAt: e.barOpenAt.toISOString(),
      barCloseAt: e.barCloseAt.toISOString(),
      alertFiredAt: e.alertFiredAt.toISOString(),
      receivedAt: e.receivedAt.toISOString(),
      referencePrice: e.referencePrice.replace(/\.?0+$/, ''),
      disposition: e.disposition,
      status: e.status,
      job: j ? { status: j.status, attempts: j.attempts, lastError: j.lastError } : null,
      outcomes: Object.fromEntries(counts.filter((c) => c.eventId === e.id).map((c) => [c.key, Number(c.n)]))
    };
  });
}

export async function listRecentRejections(db: Executor, limit = 50) {
  const rows = await db.select().from(signalRejections).orderBy(desc(signalRejections.receivedAt)).limit(Math.min(limit, 200));
  return rows.map((r) => ({ id: r.id, reason: r.reason, httpStatus: r.httpStatus, detail: r.detail, receivedAt: r.receivedAt.toISOString(), correlationId: r.correlationId }));
}
