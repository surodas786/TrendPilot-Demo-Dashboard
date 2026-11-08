// SIG-01…SIG-05, ARC-01: TradingView intake → durable job → private per-investor outcomes.
// A controlled clock makes every timing rule deterministic.
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { claimNextJob, closeDb, completeJob, FenceLostError, processNextJob, schema } from '@trendpilot/db';
import { buildTradingViewPayload, type SignalAction } from '@trendpilot/domain';
import * as webhook from '@/app/v1/webhooks/tradingview/[ingressToken]/route';
import * as blocks from '@/app/v1/me/order-blocks/route';
import * as resume from '@/app/v1/me/order-blocks/[id]/resume/route';
import * as signals from '@/app/v1/me/signals/route';
import * as signal from '@/app/v1/me/signals/[id]/route';
import * as adminEvents from '@/app/v1/admin/signal-events/route';
import * as adminRoutes from '@/app/v1/admin/signal-routes/route';
import * as adminWebhook from '@/app/v1/admin/webhook/route';
import * as rotate from '@/app/v1/admin/webhook/rotate/route';
import { setTestClock } from '@/server/clock';
import { BTC, blockBody, call, direct, resetAndSeed, signIn, teardown, userId, USERS } from '../helpers';
import { testDatabaseUrl } from '../testDb';

const TOKEN = process.env.DEV_INGRESS_TOKEN!;
const bar = (iso: string) => new Date(iso);
const B1 = bar('2026-11-08T09:15:00Z'); // closes 09:30Z (Sunday 15:30 Asia/Dhaka)
const B2 = bar('2026-11-08T09:30:00Z');
const B3 = bar('2026-11-08T09:45:00Z');
const B4 = bar('2026-11-08T10:00:00Z');
const close = (b: Date) => new Date(b.getTime() + 15 * 60_000);
const plus = (d: Date, s: number) => new Date(d.getTime() + s * 1000);

let clock = plus(close(B1), 3);
let a: string;
let b: string;
let admin: string;
let aBlock: any;
let bBlock: any;
const logged: string[] = [];

const body = (barOpen: Date, action: SignalAction = 'BULLISH_FLIP', o: Record<string, unknown> = {}) =>
  JSON.stringify({
    ...buildTradingViewPayload({ action, exchange: 'MEXC', symbol: 'BTCUSDT.P', interval: '15', barOpen, firedAt: plus(close(barOpen), 1), referencePrice: '65000.5' }),
    ...o
  });

async function deliver(raw: string, opts: { token?: string; contentType?: string } = {}) {
  const token = opts.token ?? TOKEN;
  const req = new Request(`http://localhost:3000/v1/webhooks/tradingview/${token}`, { method: 'POST', headers: { 'content-type': opts.contentType ?? 'application/json' }, body: raw });
  const res = await webhook.POST(req, { params: Promise.resolve({ ingressToken: token }) });
  return { status: res.status, body: await res.json() };
}

const count = async (t: typeof schema.signalEvents | typeof schema.jobs | typeof schema.signalDecisions | typeof schema.signalRejections) => (await direct.db.select().from(t)).length;
const decisionsFor = async (eventId: string) => direct.db.select().from(schema.signalDecisions).where(eq(schema.signalDecisions.eventId, eventId));
const runWorker = (now = clock, hooks?: Parameters<typeof processNextJob>[1]['hooks']) => processNextJob(direct.db, { workerId: 'test-worker', now, hooks });

beforeAll(async () => {
  await resetAndSeed();
  setTestClock(() => clock);
  for (const m of ['log', 'error', 'warn', 'info'] as const) {
    const orig = console[m];
    vi.spyOn(console, m).mockImplementation((...args: unknown[]) => {
      logged.push(args.map(String).join(' '));
      void orig;
    });
  }
  a = await signIn(USERS.investorA.email);
  b = await signIn(USERS.investorB.email);
  admin = await signIn(USERS.admin.email);
  // Two investors, same contract (BTCUSDT), same strategy lineage, different settings.
  aBlock = (await call(blocks.POST, { method: 'POST', path: '/x', cookie: a, body: blockBody({ orderCostUsdt: '100', leverage: 10 }) })).body;
  bBlock = (await call(blocks.POST, { method: 'POST', path: '/x', cookie: b, body: blockBody({ orderCostUsdt: '25', leverage: 3 }) })).body;
  aBlock = (await call(resume.POST, { method: 'POST', path: '/x', cookie: a, params: { id: aBlock.id }, ifMatch: aBlock.revision })).body;
  expect(aBlock.status).toBe('ACTIVE');
  expect(bBlock.status).toBe('PAUSED'); // Investor B is paused.
});

afterAll(async () => {
  setTestClock(null);
  vi.restoreAllMocks();
  await teardown();
});

let event1: string;

describe('one alert, two investors on the same contract', () => {
  it('202 only after the event and its dispatch job are committed together', async () => {
    const r = await deliver(body(B1));
    expect(r.status).toBe(202);
    expect(r.body).toMatchObject({ status: 'accepted', disposition: 'DISPATCH' });
    event1 = r.body.eventId;
    const [ev] = await direct.db.select().from(schema.signalEvents).where(eq(schema.signalEvents.id, event1));
    const [job] = await direct.db.select().from(schema.jobs);
    expect(job).toMatchObject({ kind: 'signal.dispatch', status: 'PENDING', dedupeKey: `signal.dispatch:${event1}` });
    expect(job!.createdAt.getTime()).toBe(ev!.createdAt.getTime()); // same transaction timestamp
  });

  it('records bar open, derived bar close, alert firing and receipt separately', async () => {
    const [ev] = await direct.db.select().from(schema.signalEvents).where(eq(schema.signalEvents.id, event1));
    expect(ev).toMatchObject({
      action: 'BULLISH_FLIP',
      sourceExchange: 'MEXC',
      sourceSymbol: 'BTCUSDT.P',
      interval: '15',
      instrumentId: BTC,
      barOpenAt: B1,
      barCloseAt: close(B1),
      alertFiredAt: plus(close(B1), 1),
      receivedAt: plus(close(B1), 3),
      status: 'ACCEPTED'
    });
    expect(Number(ev!.referencePrice)).toBe(65000.5);
  });

  it('the worker advances Investor A and records PAUSED for Investor B', async () => {
    const r = await runWorker(plus(close(B1), 5));
    expect(r.outcome).toBe('DONE');
    expect(r.summary).toMatchObject({ evaluated: 2, inserted: 2, ready: 1, skipped: 1 });
    const ds = await decisionsFor(event1);
    const byOwner = Object.fromEntries(ds.map((d) => [d.ownerId, d]));
    const aId = await userId(USERS.investorA.email);
    const bId = await userId(USERS.investorB.email);
    expect(byOwner[aId]).toMatchObject({ status: 'READY_FOR_EVALUATION', reason: null, orderBlockId: aBlock.id });
    expect(byOwner[bId]).toMatchObject({ status: 'SKIPPED', reason: 'PAUSED', orderBlockId: bBlock.id });
    expect((byOwner[aId]!.detail as { note: string }).note).toMatch(/Not an approved entry and not a fill/);
    const [ev] = await direct.db.select().from(schema.signalEvents).where(eq(schema.signalEvents.id, event1));
    expect(ev!.status).toBe('DISPATCHED');
  });
});

describe('duplicates and retries', () => {
  it('a duplicate delivery returns 200 with the same event and creates no job', async () => {
    clock = plus(close(B1), 20);
    const r = await deliver(body(B1));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: 'duplicate', eventId: event1 });
    expect(await count(schema.signalEvents)).toBe(1);
    expect(await count(schema.jobs)).toBe(1);
  });

  it('a duplicate is recognised even after the signal would be stale', async () => {
    clock = plus(close(B1), 600);
    expect((await deliver(body(B1))).status).toBe(200);
  });

  it('retrying the completed job produces no second outcome per investor', async () => {
    await direct.db.update(schema.jobs).set({ status: 'PENDING', claimToken: null, runAfter: new Date(0) });
    const r = await runWorker(plus(close(B1), 6));
    expect(r.outcome).toBe('DONE');
    expect(r.summary).toMatchObject({ evaluated: 2, inserted: 0 });
    expect(await decisionsFor(event1)).toHaveLength(2);
  });

  it('an expired claim is reclaimed and the stale worker cannot complete it (fencing)', async () => {
    await direct.db.update(schema.jobs).set({ status: 'PENDING', claimToken: null, runAfter: new Date(0) });
    const t0 = plus(close(B1), 10);
    const first = await claimNextJob(direct.db, { workerId: 'w1', now: t0, leaseMs: 1000 });
    expect(await claimNextJob(direct.db, { workerId: 'w2', now: plus(t0, 0.5), leaseMs: 1000 })).toBeNull(); // still leased
    const second = await claimNextJob(direct.db, { workerId: 'w2', now: plus(t0, 5), leaseMs: 30_000 });
    expect(second!.id).toBe(first!.id);
    expect(second!.claimToken).not.toBe(first!.claimToken);
    await expect(completeJob(direct.db, first!)).rejects.toBeInstanceOf(FenceLostError);
    await completeJob(direct.db, second!);
    expect(await decisionsFor(event1)).toHaveLength(2);
  });
});

describe('ordering, conflicts and rejections (SIG-03/05)', () => {
  it('rejects the opposite flip for an already-accepted bar (conflicting same-bar)', async () => {
    clock = plus(close(B1), 30);
    const r = await deliver(body(B1, 'BEARISH_FLIP'));
    expect(r.status).toBe(422);
    expect(r.body.reason).toBe('CONFLICTING_SAME_BAR');
  });

  it.each([
    ['malformed JSON', 'not json', 400, 'MALFORMED'],
    ['unresolved placeholder', null, 400, 'MALFORMED'],
    ['unknown route', 'route', 422, 'ROUTE_NOT_FOUND'],
    ['misaligned bar', 'misaligned', 422, 'MISALIGNED_BAR'],
    ['pre-close alert', 'preclose', 422, 'PRE_CLOSE']
  ])('%s → %i %s, no event and no job', async (_n, kind, status, reason) => {
    clock = plus(close(B2), 3);
    const raw =
      kind === 'not json'
        ? 'BTC flipped bullish'
        : kind === null
          ? body(B2, 'BULLISH_FLIP', { source_symbol: '{{ticker}}' })
          : kind === 'route'
            ? body(B2, 'BULLISH_FLIP', { source_symbol: 'ETHUSDT.P' })
            : kind === 'misaligned'
              ? body(B2, 'BULLISH_FLIP', { bar_open_utc: '2026-11-08T09:31:00Z' })
              : body(B2, 'BULLISH_FLIP', { alert_fired_utc: '2026-11-08T09:40:00Z' });
    const events = await count(schema.signalEvents);
    const jobsBefore = await count(schema.jobs);
    const r = await deliver(raw);
    expect(r.status).toBe(status);
    expect(r.body.reason).toBe(reason);
    expect(await count(schema.signalEvents)).toBe(events);
    expect(await count(schema.jobs)).toBe(jobsBefore);
  });

  it('a stale alert is rejected at ingress', async () => {
    clock = plus(close(B2), 121);
    const r = await deliver(body(B2));
    expect(r.status).toBe(422);
    expect(r.body.reason).toBe('SIGNAL_STALE');
  });

  it('an invalid ingress token is 404 and is never stored or logged', async () => {
    clock = plus(close(B2), 3);
    const bad = 'tvw_this-is-not-the-real-ingress-token-xyz';
    const rejections = await count(schema.signalRejections);
    const r = await deliver(body(B2), { token: bad });
    expect(r.status).toBe(404);
    expect(r.body.reason).toBe('INVALID_INGRESS');
    expect(await count(schema.signalRejections)).toBe(rejections);
  });

  it('rejections are recorded for operations without the token', async () => {
    const rows = await direct.db.select().from(schema.signalRejections);
    expect(rows.map((r) => r.reason)).toEqual(expect.arrayContaining(['MALFORMED', 'ROUTE_NOT_FOUND', 'MISALIGNED_BAR', 'PRE_CLOSE', 'SIGNAL_STALE', 'CONFLICTING_SAME_BAR']));
    expect(JSON.stringify(rows)).not.toContain(TOKEN);
  });
});

describe('restart safety: a crash mid-dispatch leaves nothing half-written', () => {
  let event2: string;

  it('accepts the next bar (text/plain, as TradingView may send it)', async () => {
    clock = plus(close(B2), 2);
    const r = await deliver(body(B2), { contentType: 'text/plain; charset=utf-8' });
    expect(r.status).toBe(202);
    event2 = r.body.eventId;
  });

  it('a failure after the first outcome rolls back the whole step and schedules a retry', async () => {
    const r = await runWorker(plus(close(B2), 4), {
      afterDecision: (i) => {
        if (i === 0) throw new Error('simulated crash');
      }
    });
    expect(r.outcome).toBe('RETRY');
    expect(await decisionsFor(event2)).toHaveLength(0);
    const [job] = await direct.db.select().from(schema.jobs).where(eq(schema.jobs.dedupeKey, `signal.dispatch:${event2}`));
    expect(job).toMatchObject({ status: 'PENDING', attempts: 1 });
    expect(job!.lastError).toMatch(/simulated crash/);
  });

  it('the retry writes exactly one outcome per investor', async () => {
    expect((await runWorker(plus(close(B2), 4))).outcome).toBe('IDLE'); // backoff not elapsed
    const r = await runWorker(plus(close(B2), 10));
    expect(r.outcome).toBe('DONE');
    const ds = await decisionsFor(event2);
    expect(ds).toHaveLength(2);
    expect(ds.map((d) => d.status).sort()).toEqual(['READY_FOR_EVALUATION', 'SKIPPED']);
  });

  it('outcome rows are append-only in the database', async () => {
    await expect(direct.pool.query("UPDATE signal_decisions SET reason = 'X'")).rejects.toThrow(/append-only/);
    await expect(direct.pool.query('DELETE FROM signal_events')).rejects.toThrow(/cannot be deleted/);
  });
});

describe('per-investor rules after queue delay and settings', () => {
  it('a delayed dispatch records SIGNAL_STALE for the active investor (rechecked after the queue)', async () => {
    clock = plus(close(B3), 2);
    const r = await deliver(body(B3));
    expect(r.status).toBe(202);
    await runWorker(plus(close(B3), 300));
    const ds = await decisionsFor(r.body.eventId);
    expect(ds.find((d) => d.orderBlockId === aBlock.id)).toMatchObject({ status: 'SKIPPED', reason: 'SIGNAL_STALE' });
    expect(ds.find((d) => d.orderBlockId === bBlock.id)).toMatchObject({ status: 'SKIPPED', reason: 'PAUSED' });
  });

  it('a bearish flip on a long-only block is DIRECTION_DISABLED for that investor only', async () => {
    await direct.db.update(schema.orderBlocks).set({ direction: 'LONG_ONLY' }).where(eq(schema.orderBlocks.id, aBlock.id));
    clock = plus(close(B4), 2);
    const r = await deliver(body(B4, 'BEARISH_FLIP'));
    expect(r.status).toBe(202);
    await runWorker(plus(close(B4), 3));
    const ds = await decisionsFor(r.body.eventId);
    expect(ds.find((d) => d.orderBlockId === aBlock.id)).toMatchObject({ status: 'SKIPPED', reason: 'DIRECTION_DISABLED' });
    await direct.db.update(schema.orderBlocks).set({ direction: 'BOTH' }).where(eq(schema.orderBlocks.id, aBlock.id));
  });

  it('an older bar after a newer one is OUT_OF_ORDER', async () => {
    clock = plus(close(B4), 20);
    const older = new Date(B4.getTime() - 15 * 60_000 * 4); // 09:00Z, fresh timestamps but older bar
    const r = await deliver(body(older, 'BULLISH_FLIP', { alert_fired_utc: '2026-11-08T10:15:01Z' }));
    // Its bar closed long ago, so the age rule may fire first; ordering must reject it either way.
    expect(r.status).toBe(422);
    expect(['OUT_OF_ORDER', 'SIGNAL_STALE']).toContain(r.body.reason);
  });

  it('OUT_OF_ORDER specifically, with a generous route age policy', async () => {
    await direct.db.update(schema.signalRoutes).set({ maxSignalAgeSeconds: 3600 });
    clock = plus(close(B4), 20);
    const r = await deliver(body(B3, 'BEARISH_FLIP', { alert_fired_utc: '2026-11-08T10:15:01Z' }));
    expect(r.status).toBe(422);
    expect(r.body.reason).toBe('OUT_OF_ORDER');
    await direct.db.update(schema.signalRoutes).set({ maxSignalAgeSeconds: 120 });
  });
});

describe('information-only routes and concurrency', () => {
  it('an information-only route stores the event but creates no job and no outcomes', async () => {
    const pkg = (await direct.db.select().from(schema.strategyPackages))[0]!;
    const r = await call(adminRoutes.POST, {
      method: 'POST',
      path: '/x',
      cookie: admin,
      body: { name: 'BTC 5m bullish (info)', sourceExchange: 'mexc', sourceSymbol: 'btcusdt.p', interval: '5', action: 'BULLISH_FLIP', kind: 'INFO_ONLY', instrumentId: BTC, packageId: pkg.id, maxSignalAgeSeconds: 120, clockToleranceSeconds: 5 }
    });
    expect(r.status).toBe(201);
    const fiveMin = new Date('2026-11-08T10:10:00Z');
    clock = new Date('2026-11-08T10:15:03Z');
    const jobsBefore = await count(schema.jobs);
    const raw = JSON.stringify(buildTradingViewPayload({ action: 'BULLISH_FLIP', exchange: 'MEXC', symbol: 'BTCUSDT.P', interval: '5', barOpen: fiveMin, firedAt: new Date('2026-11-08T10:15:01Z'), referencePrice: '65010' }));
    const res = await deliver(raw);
    expect(res.status).toBe(202);
    expect(res.body.disposition).toBe('INFO_ONLY');
    expect(await count(schema.jobs)).toBe(jobsBefore);
    expect(await decisionsFor(res.body.eventId)).toHaveLength(0);
  });

  it('ambiguous routes cannot be configured', async () => {
    const pkg = (await direct.db.select().from(schema.strategyPackages))[0]!;
    const r = await call(adminRoutes.POST, {
      method: 'POST',
      path: '/x',
      cookie: admin,
      body: { name: 'Duplicate', sourceExchange: 'MEXC', sourceSymbol: 'BTCUSDT.P', interval: '15', action: 'BULLISH_FLIP', kind: 'ACTIONABLE', instrumentId: BTC, packageId: pkg.id, maxSignalAgeSeconds: 120, clockToleranceSeconds: 5 }
    });
    expect(r.status).toBe(409);
  });

  it('five simultaneous deliveries of one alert: one 202, four 200, one event, one job', async () => {
    const B5 = new Date('2026-11-08T10:15:00Z');
    clock = plus(close(B5), 2);
    const events = await count(schema.signalEvents);
    const jobsBefore = await count(schema.jobs);
    const results = await Promise.all(Array.from({ length: 5 }, () => deliver(body(B5))));
    expect(results.map((r) => r.status).sort()).toEqual([200, 200, 200, 200, 202]);
    expect(new Set(results.map((r) => r.body.eventId)).size).toBe(1);
    expect(await count(schema.signalEvents)).toBe(events + 1);
    expect(await count(schema.jobs)).toBe(jobsBefore + 1);
  });
});

describe('outcomes are private (IAM-02)', () => {
  it('each investor lists only their own outcomes', async () => {
    const la = await call(signals.GET, { path: '/v1/me/signals', cookie: a });
    const lb = await call(signals.GET, { path: '/v1/me/signals', cookie: b });
    expect(la.status).toBe(200);
    expect(la.body.items.length).toBeGreaterThan(0);
    expect(la.body.items.every((o: any) => o.orderBlockId === aBlock.id)).toBe(true);
    expect(lb.body.items.every((o: any) => o.orderBlockId === bBlock.id)).toBe(true);
    const bFirst = lb.body.items.find((o: any) => o.signal.eventId === event1);
    expect(bFirst).toMatchObject({ status: 'SKIPPED', reason: 'PAUSED', reasonText: 'This order block is paused.' });
    const aFirst = la.body.items.find((o: any) => o.signal.eventId === event1);
    expect(aFirst).toMatchObject({ status: 'READY_FOR_EVALUATION', side: 'LONG', signal: { action: 'BULLISH_FLIP', barOpenAt: B1.toISOString(), barCloseAt: close(B1).toISOString() } });
  });

  it('A cannot retrieve B\'s outcome by ID, and vice versa (same 404 as unknown)', async () => {
    const [bDecision] = await direct.db
      .select()
      .from(schema.signalDecisions)
      .where(and(eq(schema.signalDecisions.eventId, event1), eq(schema.signalDecisions.orderBlockId, bBlock.id)));
    const [aDecision] = await direct.db
      .select()
      .from(schema.signalDecisions)
      .where(and(eq(schema.signalDecisions.eventId, event1), eq(schema.signalDecisions.orderBlockId, aBlock.id)));
    const aReadsB = await call(signal.GET, { path: '/x', cookie: a, params: { id: bDecision!.id } });
    const bReadsA = await call(signal.GET, { path: '/x', cookie: b, params: { id: aDecision!.id } });
    const unknown = await call(signal.GET, { path: '/x', cookie: a, params: { id: '0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f' } });
    for (const r of [aReadsB, bReadsA, unknown]) {
      expect(r.status).toBe(404);
      expect(Object.keys(r.body).sort()).toEqual(['code', 'correlationId', 'message']);
    }
    expect((await call(signal.GET, { path: '/x', cookie: b, params: { id: bDecision!.id } })).status).toBe(200);
  });

  it('admins get counts only; investors cannot use the admin view; admins have no /me outcomes', async () => {
    const ops = await call(adminEvents.GET, { path: '/x', cookie: admin });
    expect(ops.status).toBe(200);
    const first = ops.body.events.find((e: any) => e.id === event1);
    expect(first.outcomes).toEqual({ READY_FOR_EVALUATION: 1, 'SKIPPED:PAUSED': 1 });
    const dump = JSON.stringify(ops.body);
    for (const id of [await userId(USERS.investorA.email), await userId(USERS.investorB.email), aBlock.id, bBlock.id]) expect(dump).not.toContain(id);
    expect((await call(adminEvents.GET, { path: '/x', cookie: a })).status).toBe(403);
    expect((await call(signals.GET, { path: '/x', cookie: admin })).status).toBe(403);
  });
});

describe('SIG-05 persistence failure', () => {
  it('returns 503 and acknowledges nothing when the database is unavailable', async () => {
    const good = testDatabaseUrl();
    const events = await count(schema.signalEvents);
    await closeDb();
    process.env.DATABASE_URL = 'postgres://nobody:nothing@127.0.0.1:1/none';
    try {
      clock = plus(close(new Date('2026-11-08T10:30:00Z')), 2);
      const r = await deliver(body(new Date('2026-11-08T10:30:00Z')));
      expect(r.status).toBe(503);
      expect(r.body.reason).toBe('PERSISTENCE_UNAVAILABLE');
    } finally {
      await closeDb();
      process.env.DATABASE_URL = good;
    }
    expect(await count(schema.signalEvents)).toBe(events);
  });
});

let rotatedToken = '';

describe('SIG-01 token rotation', () => {
  it('rotation shows the new URL once, invalidates the old token and keeps deduplication', async () => {
    expect((await call(rotate.POST, { method: 'POST', path: '/x', cookie: a })).status).toBe(403);
    const r = await call(rotate.POST, { method: 'POST', path: '/x', cookie: admin });
    expect(r.status).toBe(200);
    rotatedToken = r.body.url.split('/v1/webhooks/tradingview/')[1];
    expect(rotatedToken).toMatch(/^tvw_[A-Za-z0-9_-]{40,}$/);
    expect(rotatedToken).not.toBe(TOKEN);
    expect(r.body.tokenHint).toBe(`${rotatedToken.slice(0, 8)}…`);

    clock = plus(close(B1), 700);
    expect((await deliver(body(B1))).status).toBe(404); // the old token stops working immediately
    expect((await deliver(body(B1), { token: rotatedToken })).status).toBe(200); // same namespace: still a duplicate

    const meta = await call(adminWebhook.GET, { path: '/x', cookie: admin });
    expect(JSON.stringify(meta.body)).not.toContain(rotatedToken.slice(0, 12));
    const audit = await direct.db.select().from(schema.auditEvents).where(eq(schema.auditEvents.action, 'ADMIN_WEBHOOK_TOKEN_ROTATE'));
    expect(audit).toHaveLength(1);
    expect(JSON.stringify(audit)).not.toContain(rotatedToken);
  });
});

describe('token redaction', () => {
  it('no ingress token (original or rotated) ever appeared in any log line', () => {
    const all = logged.join('\n');
    expect(all).not.toContain(TOKEN);
    expect(rotatedToken).not.toBe('');
    expect(all).not.toContain(rotatedToken);
  });
});
