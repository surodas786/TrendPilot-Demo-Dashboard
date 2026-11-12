import { and, desc, eq, inArray, lt, ne, sql } from 'drizzle-orm';
import { assertLiveTransportAllowed } from '@trendpilot/domain';
import type { Db, Executor } from './client';
import { exchangeConnections, jobs, marketQuotes, serviceHeartbeats, users } from './schema';
import { getLiveControl } from './live/liveMode';
import { listFeedEvents, listFeedHealth, type FeedEventDto, type FeedHealthDto } from './market/health';

/**
 * Operations (UI-05 Operations, OPS): service liveness, the durable job queue, the public market
 * feed, the release mode and Live account health (status and drift only; never balances or keys).
 */

export type ServiceName = 'worker' | 'market-feed';
/** A service that has not reported for this long is shown as not reporting. */
export const HEARTBEAT_STALE_MS = 90_000;

export async function heartbeat(db: Executor, h: { service: ServiceName; instance: string; startedAt: Date; detail?: Record<string, unknown> }): Promise<void> {
  const now = new Date();
  await db
    .insert(serviceHeartbeats)
    .values({ service: h.service, instance: h.instance, startedAt: h.startedAt, lastSeenAt: now, detail: h.detail ?? {}, stoppedAt: null })
    .onConflictDoUpdate({ target: [serviceHeartbeats.service, serviceHeartbeats.instance], set: { lastSeenAt: now, detail: h.detail ?? {}, stoppedAt: null, startedAt: h.startedAt } });
}

export async function markStopped(db: Executor, service: ServiceName, instance: string): Promise<void> {
  await db
    .update(serviceHeartbeats)
    .set({ stoppedAt: new Date() })
    .where(and(eq(serviceHeartbeats.service, service), eq(serviceHeartbeats.instance, instance)));
}

export const RETENTION_DEFAULTS = { jobDays: 7, quoteDays: 7 } as const;

/**
 * Retention for high-volume rows. Only finished jobs (DONE) and old quotes are removed; PENDING,
 * RUNNING and DEAD jobs stay for operators. Candles, fills, exits, funding and the ledger are
 * never pruned.
 */
export async function pruneRetention(db: Db, o: { now?: Date; jobDays?: number; quoteDays?: number } = {}): Promise<{ jobs: number; quotes: number }> {
  const now = o.now ?? new Date();
  const jobCut = new Date(now.getTime() - (o.jobDays ?? RETENTION_DEFAULTS.jobDays) * 86_400_000);
  const quoteCut = new Date(now.getTime() - (o.quoteDays ?? RETENTION_DEFAULTS.quoteDays) * 86_400_000);
  const j = await db.delete(jobs).where(and(eq(jobs.status, 'DONE'), lt(jobs.completedAt, jobCut))).returning({ id: jobs.id });
  const q = await db.delete(marketQuotes).where(lt(marketQuotes.asOf, quoteCut)).returning({ id: marketQuotes.instrumentId });
  return { jobs: j.length, quotes: q.length };
}

export interface OperationsDto {
  checkedAt: string;
  mode: 'PAPER' | 'PAPER_AND_LIVE';
  liveOrderTransport: 'disabled' | 'enabled' | 'MISCONFIGURED';
  live: {
    platformEnabled: boolean;
    entriesHalted: boolean;
    haltReason: string | null;
    connections: { ownerEmail: string; status: string; approved: boolean; liveEnabled: boolean; entriesHalted: boolean; haltReason: string | null; lastSyncAt: string | null; lastSyncError: string | null; drift: number }[];
    openPositions: number;
    unprotectedPositions: number;
    unresolvedOrders: number;
  };
  database: { ok: boolean; latencyMs: number | null; error: string | null };
  services: { service: string; instance: string; startedAt: string; lastSeenAt: string; ageSeconds: number; state: 'REPORTING' | 'NOT_REPORTING' | 'STOPPED'; detail: Record<string, unknown> }[];
  /** Overall per service: REPORTING if any instance reports, else NOT_REPORTING / NEVER_STARTED. */
  serviceSummary: Record<ServiceName, 'REPORTING' | 'NOT_REPORTING' | 'NEVER_STARTED'>;
  jobs: {
    pending: number;
    running: number;
    dead: number;
    /** Pending jobs already due (run_after ≤ now). */
    dueBacklog: number;
    oldestDueSeconds: number | null;
    retrying: number;
    recentFailures: { id: string; kind: string; status: string; attempts: number; maxAttempts: number; lastError: string | null; updatedAt: string }[];
  };
  feed: { contracts: FeedHealthDto[]; events: FeedEventDto[] };
  alerts: { level: 'ERROR' | 'WARN'; message: string }[];
}

export async function getOperationsStatus(db: Db, now: Date = new Date(), env: Record<string, string | undefined> = process.env): Promise<OperationsDto> {
  let database: OperationsDto['database'];
  const t0 = Date.now();
  try {
    await db.execute(sql`select 1`);
    database = { ok: true, latencyMs: Date.now() - t0, error: null };
  } catch (e) {
    database = { ok: false, latencyMs: null, error: (e as Error).message };
  }
  let liveOrderTransport: OperationsDto['liveOrderTransport'] = 'disabled';
  try {
    liveOrderTransport = assertLiveTransportAllowed(env);
  } catch {
    liveOrderTransport = 'MISCONFIGURED';
  }
  const control = await getLiveControl(db);
  const conns = await db.select({ c: exchangeConnections, email: users.email }).from(exchangeConnections).innerJoin(users, eq(users.id, exchangeConnections.ownerId)).where(ne(exchangeConnections.status, 'REVOKED'));
  const [lp] = (
    await db.execute<{ open: string; unprotected: string; unresolved: string }>(sql`
      SELECT
        (SELECT count(*) FROM positions WHERE mode = 'LIVE' AND status = 'OPEN') AS open,
        (SELECT count(*) FROM positions WHERE mode = 'LIVE' AND status = 'OPEN' AND protection_status <> 'PROTECTED') AS unprotected,
        (SELECT count(*) FROM order_intents WHERE mode = 'LIVE' AND state IN ('INTENT', 'SUBMITTING', 'ACKNOWLEDGED', 'PARTIALLY_FILLED', 'UNKNOWN')) AS unresolved`)
  ).rows;
  const live: OperationsDto['live'] = {
    platformEnabled: control.liveEnabled,
    entriesHalted: control.entriesHalted,
    haltReason: control.haltReason,
    connections: conns.map(({ c, email }) => ({
      ownerEmail: email,
      status: c.status,
      approved: !!c.approvedAt,
      liveEnabled: c.liveEnabled,
      entriesHalted: c.entriesHalted,
      haltReason: c.haltReason,
      lastSyncAt: c.lastSyncAt?.toISOString() ?? null,
      lastSyncError: c.lastSyncError,
      drift: (c.drift as unknown[]).length
    })),
    openPositions: Number(lp!.open),
    unprotectedPositions: Number(lp!.unprotected),
    unresolvedOrders: Number(lp!.unresolved)
  };

  const hb = await db.select().from(serviceHeartbeats).orderBy(desc(serviceHeartbeats.lastSeenAt));
  const wall = Date.now();
  const services = hb.map((h) => {
    const age = Math.max(0, Math.round((wall - h.lastSeenAt.getTime()) / 1000));
    const state: 'REPORTING' | 'NOT_REPORTING' | 'STOPPED' = h.stoppedAt ? 'STOPPED' : age * 1000 <= HEARTBEAT_STALE_MS ? 'REPORTING' : 'NOT_REPORTING';
    return { service: h.service, instance: h.instance, startedAt: h.startedAt.toISOString(), lastSeenAt: h.lastSeenAt.toISOString(), ageSeconds: age, state, detail: (h.detail as Record<string, unknown>) ?? {} };
  });
  const summary = (s: ServiceName) => {
    const mine = services.filter((x) => x.service === s);
    if (!mine.length) return 'NEVER_STARTED' as const;
    return mine.some((x) => x.state === 'REPORTING') ? ('REPORTING' as const) : ('NOT_REPORTING' as const);
  };

  const [counts] = (
    await db.execute<{ pending: string; running: string; dead: string; due: string; oldest: string | null; retrying: string }>(sql`
      SELECT
        count(*) FILTER (WHERE status = 'PENDING') AS pending,
        count(*) FILTER (WHERE status = 'RUNNING') AS running,
        count(*) FILTER (WHERE status = 'DEAD') AS dead,
        count(*) FILTER (WHERE status = 'PENDING' AND run_after <= now()) AS due,
        extract(epoch FROM now() - min(run_after) FILTER (WHERE status = 'PENDING' AND run_after <= now())) AS oldest,
        count(*) FILTER (WHERE status = 'PENDING' AND last_error IS NOT NULL) AS retrying
      FROM jobs`)
  ).rows;
  const failures = await db
    .select()
    .from(jobs)
    .where(inArray(jobs.status, ['DEAD', 'PENDING', 'RUNNING']))
    .orderBy(desc(jobs.updatedAt))
    .limit(200);
  const recentFailures = failures
    .filter((j) => j.status === 'DEAD' || j.lastError)
    .slice(0, 20)
    .map((j) => ({ id: j.id, kind: j.kind, status: j.status, attempts: j.attempts, maxAttempts: j.maxAttempts, lastError: j.lastError, updatedAt: j.updatedAt.toISOString() }));

  const [contracts, events] = await Promise.all([listFeedHealth(db, now), listFeedEvents(db, 20)]);
  const jobsDto = {
    pending: Number(counts!.pending),
    running: Number(counts!.running),
    dead: Number(counts!.dead),
    dueBacklog: Number(counts!.due),
    oldestDueSeconds: counts!.oldest === null ? null : Math.round(Number(counts!.oldest)),
    retrying: Number(counts!.retrying),
    recentFailures
  };
  const serviceSummary = { worker: summary('worker'), 'market-feed': summary('market-feed') };

  const alerts: OperationsDto['alerts'] = [];
  if (!database.ok) alerts.push({ level: 'ERROR', message: `Database unreachable: ${database.error}` });
  if (liveOrderTransport === 'MISCONFIGURED') alerts.push({ level: 'ERROR', message: 'LIVE_ORDER_TRANSPORT has an invalid value, or "enabled" outside a production process.' });
  if (live.openPositions > 0 && liveOrderTransport !== 'enabled') alerts.push({ level: 'ERROR', message: `${live.openPositions} Live position(s) are open but LIVE_ORDER_TRANSPORT is not enabled: TrendPilot cannot close them. Their MEXC stops still protect them; see the runbook.` });
  if (live.unprotectedPositions > 0) alerts.push({ level: 'ERROR', message: `${live.unprotectedPositions} Live position(s) are not verified as protected by a MEXC stop.` });
  for (const c of live.connections) {
    if (c.drift) alerts.push({ level: 'ERROR', message: `Live account ${c.ownerEmail}: MEXC and TrendPilot disagree (${c.drift} item(s)); new entries halted.` });
    else if (c.entriesHalted && c.liveEnabled) alerts.push({ level: 'WARN', message: `Live account ${c.ownerEmail}: new entries halted (${c.haltReason ?? 'no reason'}).` });
    if (c.lastSyncError && c.liveEnabled) alerts.push({ level: 'WARN', message: `Live account ${c.ownerEmail}: private sync failed (${c.lastSyncError}).` });
  }
  if (live.platformEnabled && live.entriesHalted) alerts.push({ level: 'WARN', message: `All new Live entries are halted: ${live.haltReason ?? 'operator'}.` });
  if (serviceSummary.worker !== 'REPORTING') alerts.push({ level: 'ERROR', message: `Worker ${serviceSummary.worker === 'NEVER_STARTED' ? 'has never reported' : 'is not reporting'}: signals, fills and exits are not processed.` });
  if (serviceSummary['market-feed'] !== 'REPORTING') alerts.push({ level: 'WARN', message: `Market feed ${serviceSummary['market-feed'] === 'NEVER_STARTED' ? 'has never reported' : 'is not reporting'}: public prices are not updating.` });
  for (const c of contracts) {
    if (c.instrumentStatus !== 'PUBLISHED' || !c.feed) continue;
    if (c.feed.state !== 'HEALTHY') alerts.push({ level: 'WARN', message: `${c.symbol} feed ${c.feed.state}${c.feed.lastError ? `: ${c.feed.lastError}` : ''}` });
    else if (c.latestQuote?.freshness === 'STALE') alerts.push({ level: 'WARN', message: `${c.symbol}: newest price is ${c.latestQuote.ageSeconds} s old` });
  }
  if (jobsDto.dead > 0) alerts.push({ level: 'ERROR', message: `${jobsDto.dead} job(s) failed permanently (DEAD). See recent failures.` });
  if (jobsDto.oldestDueSeconds !== null && jobsDto.oldestDueSeconds > 60) alerts.push({ level: 'WARN', message: `Job backlog: oldest due job waiting ${jobsDto.oldestDueSeconds} s.` });

  return { checkedAt: now.toISOString(), mode: live.platformEnabled && liveOrderTransport === 'enabled' ? 'PAPER_AND_LIVE' : 'PAPER', liveOrderTransport, live, database, services, serviceSummary, jobs: jobsDto, feed: { contracts, events }, alerts };
}
