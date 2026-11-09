// Step 10 (UI-05 Operations, OPS): health endpoint, service liveness, failed jobs and feed state in
// the operations view, and retention that never touches live work.
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { enqueueJob, heartbeat, markStopped, processNextJob, pruneRetention, schema } from '@trendpilot/db';
import { startWorker } from '../../../worker/src/worker';
import * as health from '@/app/v1/health/route';
import * as ops from '@/app/v1/admin/operations/route';
import * as rotate from '@/app/v1/admin/webhook/rotate/route';
import * as routes from '@/app/v1/admin/signal-routes/route';
import { BTC, call, direct, resetAndSeed, signIn, teardown, USERS } from '../helpers';
import { testDatabaseUrl } from '../testDb';

let admin = '';
let investor = '';
const view = async () => (await call(ops.GET, { path: '/x', cookie: admin })).body;

beforeAll(async () => {
  await resetAndSeed();
  admin = await signIn(USERS.admin.email);
  investor = await signIn(USERS.investorA.email);
});
afterAll(teardown);

describe('health endpoint', () => {
  it('GET /v1/health: web and database up, Paper, live transport disabled; no data', async () => {
    const r = await health.GET();
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ status: 'ok', web: 'up', database: 'up', mode: 'PAPER', liveOrderTransport: 'disabled' });
  });
});

describe('operations view', () => {
  it('is admin-only', async () => {
    expect((await call(ops.GET, { path: '/x', cookie: investor })).status).toBe(403);
    expect((await call(ops.GET, { path: '/x' })).status).toBe(401);
  });

  it('flags a worker and feed that never started', async () => {
    const d = await view();
    expect(d).toMatchObject({ mode: 'PAPER', liveOrderTransport: 'disabled', database: { ok: true }, serviceSummary: { worker: 'NEVER_STARTED', 'market-feed': 'NEVER_STARTED' } });
    expect(d.alerts.map((a: any) => a.message).join('\n')).toMatch(/Worker has never reported/);
  });

  it('a running worker reports; a stopped one is shown as stopped; a silent one as not reporting', async () => {
    const w = await startWorker({ env: { ...process.env, DATABASE_URL: testDatabaseUrl(), LIVE_ORDER_TRANSPORT: 'disabled', SIGNAL_TEST_CLOCK: '' }, processJobs: false, log: () => {} });
    let d = await view();
    expect(d.serviceSummary.worker).toBe('REPORTING');
    expect(d.services.find((s: any) => s.service === 'worker')).toMatchObject({ instance: w.workerId, state: 'REPORTING' });
    await w.stop();
    d = await view();
    expect(d.services.find((s: any) => s.instance === w.workerId).state).toBe('STOPPED');

    await heartbeat(direct.db, { service: 'market-feed', instance: 'feed-test', startedAt: new Date() });
    await direct.db.update(schema.serviceHeartbeats).set({ lastSeenAt: new Date(Date.now() - 5 * 60_000) }).where(eq(schema.serviceHeartbeats.instance, 'feed-test'));
    d = await view();
    expect(d.serviceSummary['market-feed']).toBe('NOT_REPORTING');
    expect(d.alerts.some((a: any) => /Market feed is not reporting/.test(a.message))).toBe(true);
    await markStopped(direct.db, 'market-feed', 'feed-test');
  });

  it('a permanently failed job surfaces with its error', async () => {
    await direct.db.execute(sql`DELETE FROM jobs`);
    const { id } = await enqueueJob(direct.db, { kind: 'market.tick', dedupeKey: 'ops-broken-tick', payload: { instrumentId: 'not-a-uuid', quote: { bid: '1', ask: '2', mark: '1', last: '1' } }, runAfter: new Date(0) });
    await direct.db.update(schema.jobs).set({ maxAttempts: 1 }).where(eq(schema.jobs.id, id));
    const r = await processNextJob(direct.db, { workerId: 'ops-test', now: new Date() });
    expect(r.outcome).toBe('DEAD');
    const d = await view();
    expect(d.jobs.dead).toBe(1);
    expect(d.jobs.recentFailures[0]).toMatchObject({ id, kind: 'market.tick', status: 'DEAD', attempts: 1 });
    expect(d.jobs.recentFailures[0].lastError).toMatch(/uuid/i);
    expect(d.alerts.some((a: any) => a.level === 'ERROR' && /1 job\(s\) failed permanently/.test(a.message))).toBe(true);
  });

  it('a feed disconnect on a published contract surfaces as a warning', async () => {
    await direct.db
      .insert(schema.marketFeedStatus)
      .values({ instrumentId: BTC, source: 'MEXC_PUBLIC', exchangeSymbol: 'BTC_USDT', state: 'DOWN', consecutiveFailures: 3, lastError: 'GET /api/v1/contract/ticker: fetch failed' });
    const d = await view();
    expect(d.alerts.some((a: any) => a.level === 'WARN' && /BTCUSDT feed DOWN: GET \/api\/v1\/contract\/ticker: fetch failed/.test(a.message))).toBe(true);
    expect(d.feed.contracts.find((c: any) => c.symbol === 'BTCUSDT').feed).toMatchObject({ state: 'DOWN', consecutiveFailures: 3 });
  });
});

describe('fresh deployment (no seed): the first webhook', () => {
  it('an admin creates the TradingView webhook once; routes can then be added', async () => {
    await direct.db.execute(sql`TRUNCATE webhook_ingress CASCADE`);
    const pkgId = (await direct.db.select({ id: schema.strategyPackages.id }).from(schema.strategyPackages))[0]!.id;
    const body = { name: 'BTC 15m bearish', sourceExchange: 'MEXC', sourceSymbol: 'BTCUSDT.P', interval: '15', action: 'BEARISH_FLIP', kind: 'ACTIONABLE', instrumentId: BTC, packageId: pkgId, maxSignalAgeSeconds: 120, clockToleranceSeconds: 5 };
    expect((await call(routes.POST, { method: 'POST', path: '/x', cookie: admin, body })).status).toBe(409);
    expect((await call(rotate.POST, { method: 'POST', path: '/x', cookie: investor })).status).toBe(403);
    const r = await call(rotate.POST, { method: 'POST', path: '/x', cookie: admin });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ created: true });
    expect(r.body.url).toMatch(/\/v1\/webhooks\/tradingview\/tvw_[A-Za-z0-9_-]{40,}$/);
    expect((await direct.db.select().from(schema.auditEvents).where(eq(schema.auditEvents.action, 'ADMIN_WEBHOOK_CREATE'))).length).toBe(1);
    expect((await call(routes.POST, { method: 'POST', path: '/x', cookie: admin, body })).status).toBe(201);
    // A second call rotates instead of creating another webhook.
    const again = await call(rotate.POST, { method: 'POST', path: '/x', cookie: admin });
    expect(again.body.created).toBeUndefined();
    expect(await direct.db.select().from(schema.webhookIngress)).toHaveLength(1);
  });
});

describe('retention', () => {
  it('removes only finished jobs and quotes older than the window', async () => {
    const old = new Date(Date.now() - 10 * 86_400_000);
    const recent = new Date(Date.now() - 86_400_000);
    for (const [key, status, completedAt] of [
      ['old-done', 'DONE', old],
      ['new-done', 'DONE', recent],
      ['old-dead', 'DEAD', null],
      ['old-pending', 'PENDING', null]
    ] as const) {
      const { id } = await enqueueJob(direct.db, { kind: 'market.tick', dedupeKey: `ret-${key}`, payload: {}, runAfter: new Date('2100-01-01') });
      await direct.db.update(schema.jobs).set({ status, completedAt, createdAt: old }).where(eq(schema.jobs.id, id));
    }
    await direct.db.insert(schema.marketQuotes).values([
      { instrumentId: BTC, asOf: old, bid: '1', ask: '2', mark: '1', last: '1', source: 'FIXTURE' },
      { instrumentId: BTC, asOf: recent, bid: '1', ask: '2', mark: '1', last: '1', source: 'FIXTURE' }
    ]);
    const r = await pruneRetention(direct.db);
    expect(r).toEqual({ jobs: 1, quotes: 1 });
    const left = (await direct.db.select({ k: schema.jobs.dedupeKey }).from(schema.jobs)).map((x) => x.k).filter((k) => k.startsWith('ret-'));
    expect(left.sort()).toEqual(['ret-new-done', 'ret-old-dead', 'ret-old-pending']);
    expect((await direct.db.select().from(schema.marketQuotes).where(eq(schema.marketQuotes.instrumentId, BTC))).map((q) => q.asOf.getTime())).toEqual([recent.getTime()]);
  });
});
