// UI-05 signal route maintenance: edit (prefilled settings, uniqueness, strategy interval/contract
// compatibility), delete (only unused routes; routes with history are kept and can be disabled),
// open-position protection, server-side admin enforcement and auditing. Finally a fresh 5m
// BTCUSDT.P alert must match the enabled 5m route produced by an edit.
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FIXTURE_IDS, schema } from '@trendpilot/db';
import { buildTradingViewPayload, PAPER_TEMPLATE, type SignalAction, type SignalInterval } from '@trendpilot/domain';
import * as routes from '@/app/v1/admin/signal-routes/route';
import * as routeById from '@/app/v1/admin/signal-routes/[id]/route';
import * as versions from '@/app/v1/admin/strategy-packages/[id]/versions/route';
import * as publish from '@/app/v1/admin/strategy-versions/[id]/publish/route';
import * as webhook from '@/app/v1/webhooks/tradingview/[ingressToken]/route';
import { setTestClock } from '@/server/clock';
import { BTC, call, direct, ETH, resetAndSeed, signIn, teardown, USERS } from '../helpers';
import { clock, cookies as replayCookies, openFromAlert, plus } from '../paperReplay';

const PKG = FIXTURE_IDS.package;
const FIXTURE_ROUTE_TUPLE = { sourceExchange: 'MEXC', sourceSymbol: 'BTCUSDT.P', interval: '15', action: 'BULLISH_FLIP' } as const;

const routeRow = async (id: string) => (await direct.db.select().from(schema.signalRoutes).where(eq(schema.signalRoutes.id, id)))[0];
const fixtureRoute = async () =>
  (await direct.db.select().from(schema.signalRoutes).where(and(eq(schema.signalRoutes.sourceSymbol, 'BTCUSDT.P'), eq(schema.signalRoutes.interval, '15'), eq(schema.signalRoutes.action, 'BULLISH_FLIP'))))[0]!;
const audits = async (action: string, id: string) =>
  direct.db.select().from(schema.auditEvents).where(and(eq(schema.auditEvents.action, action), eq(schema.auditEvents.targetId, id)));

const bodyOf = (r: typeof schema.signalRoutes.$inferSelect, patch: Record<string, unknown> = {}) => ({
  name: r.name,
  sourceExchange: r.sourceExchange,
  sourceSymbol: r.sourceSymbol,
  interval: r.interval,
  action: r.action,
  kind: r.kind,
  instrumentId: r.instrumentId,
  packageId: r.packageId,
  maxSignalAgeSeconds: r.maxSignalAgeSeconds,
  clockToleranceSeconds: r.clockToleranceSeconds,
  ...patch
});

async function alert(action: SignalAction, interval: SignalInterval, barOpen: Date, symbol = 'BTCUSDT.P') {
  const token = process.env.DEV_INGRESS_TOKEN!;
  const ms = Number(interval) * 60_000;
  const raw = JSON.stringify(buildTradingViewPayload({ action, exchange: 'MEXC', symbol, interval, barOpen, firedAt: plus(new Date(barOpen.getTime() + ms), 1), referencePrice: '65000.5' }));
  const res = await webhook.POST(new Request(`http://localhost/v1/webhooks/tradingview/${token}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: raw }), { params: Promise.resolve({ ingressToken: token }) });
  return { status: res.status, body: await res.json() };
}

afterAll(async () => {
  setTestClock(null);
  await teardown();
});

describe('a route that open positions depend on is protected', () => {
  let admin: string;
  let route: typeof schema.signalRoutes.$inferSelect;

  beforeAll(async () => {
    await openFromAlert(); // investors A and B hold open BTC positions under the fixture lineage
    admin = replayCookies.admin;
    route = await fixtureRoute();
    expect((await direct.db.select().from(schema.positions).where(eq(schema.positions.status, 'OPEN'))).length).toBe(2);
  });

  it('disabling, re-pointing or deleting it is blocked with an explanation; nothing changes', async () => {
    const off = await call(routeById.PATCH, { method: 'PATCH', path: '/x', cookie: admin, params: { id: route.id }, ifMatch: route.revision, body: { enabled: false } });
    expect(off.status).toBe(409);
    expect(off.body.message).toMatch(/2 open position\(s\) on BTCUSDT under .*no other enabled route delivers them/);
    const repoint = await call(routeById.PUT, { method: 'PUT', path: '/x', cookie: admin, params: { id: route.id }, ifMatch: route.revision, body: bodyOf(route, { sourceSymbol: 'BTCUSDT' }) });
    expect(repoint.status).toBe(409);
    expect(repoint.body.message).toMatch(/This change would stop BULLISH_FLIP signals/);
    const del = await call(routeById.DELETE, { method: 'DELETE', path: '/x', cookie: admin, params: { id: route.id }, ifMatch: route.revision });
    expect(del.status).toBe(409); // it also has history
    expect(await routeRow(route.id)).toMatchObject({ enabled: true, sourceSymbol: 'BTCUSDT.P', revision: route.revision });
    expect((await audits('ADMIN_SIGNAL_ROUTE_UPDATE', route.id)).map((a) => a.result)).toEqual(['DENIED']);
    expect((await audits('ADMIN_SIGNAL_ROUTE_EDIT', route.id)).map((a) => a.result)).toEqual(['DENIED']);
  });

  it('non-routing settings (name, max age, clock tolerance) can still be edited', async () => {
    const r = await call(routeById.PUT, { method: 'PUT', path: '/x', cookie: admin, params: { id: route.id }, ifMatch: route.revision, body: bodyOf(route, { name: 'BTC 15m bullish (renamed)', maxSignalAgeSeconds: 90, clockToleranceSeconds: 3 }) });
    expect(r.status).toBe(200);
    expect(await routeRow(route.id)).toMatchObject({ name: 'BTC 15m bullish (renamed)', maxSignalAgeSeconds: 90, clockToleranceSeconds: 3, revision: route.revision + 1 });
  });

  it('with a replacement route delivering the same action to the same contract and lineage, disabling is allowed', async () => {
    const add = await call(routes.POST, { method: 'POST', path: '/x', cookie: admin, body: { ...bodyOf(route), name: 'BTC 15m bullish (MEXC chart)', sourceSymbol: 'BTCUSDT' } });
    expect(add.status).toBe(201);
    const cur = (await routeRow(route.id))!;
    const off = await call(routeById.PATCH, { method: 'PATCH', path: '/x', cookie: admin, params: { id: route.id }, ifMatch: cur.revision, body: { enabled: false } });
    expect(off.status).toBe(200);
  });
});

describe('edit, duplicate, delete and history on a fresh deployment', () => {
  let admin: string;
  let investor: string;
  let fixture: typeof schema.signalRoutes.$inferSelect;

  beforeAll(async () => {
    await resetAndSeed();
    clock.now = new Date('2026-11-08T10:05:03Z');
    setTestClock(() => clock.now);
    admin = await signIn(USERS.admin.email);
    investor = await signIn(USERS.investorA.email);
    fixture = await fixtureRoute();
  });

  it('only administrators can edit or delete routes (server-side)', async () => {
    expect((await call(routeById.PUT, { method: 'PUT', path: '/x', cookie: investor, params: { id: fixture.id }, ifMatch: fixture.revision, body: bodyOf(fixture) })).status).toBe(403);
    expect((await call(routeById.DELETE, { method: 'DELETE', path: '/x', cookie: investor, params: { id: fixture.id }, ifMatch: fixture.revision })).status).toBe(403);
    expect((await call(routeById.PUT, { method: 'PUT', path: '/x', params: { id: fixture.id }, ifMatch: fixture.revision, body: bodyOf(fixture) })).status).toBe(401);
  });

  it('the route list shows the lineage’s actual current timeframe next to its name', async () => {
    const list = await call(routes.GET, { path: '/x', cookie: admin });
    const r = list.body.items.find((x: { id: string }) => x.id === fixture.id);
    expect(r.package).toMatchObject({ id: PKG, latest: { version: 1, timeframe: '15m' } });
    expect(r.history).toEqual({ events: 0, rejections: 0 });
  });

  it('an edit must match the strategy: interval and contract are checked against its current version', async () => {
    // v2 of the lineage switches to 5m (BTC only), like “Supertrend 15m — paper fixture” v2.
    const d = await call(versions.POST, { method: 'POST', path: '/x', cookie: admin, params: { id: PKG }, body: { ...PAPER_TEMPLATE, timeframe: '5m', instrumentIds: [BTC] } });
    expect(d.status).toBe(201);
    const p = await call(publish.POST, { method: 'POST', path: '/x', cookie: admin, params: { id: d.body.id }, ifMatch: d.body.revision });
    expect(p.status).toBe(200);
    const list = await call(routes.GET, { path: '/x', cookie: admin });
    expect(list.body.items.find((x: { id: string }) => x.id === fixture.id).package.latest).toEqual({ version: 2, timeframe: '5m' });

    const keep15 = await call(routeById.PUT, { method: 'PUT', path: '/x', cookie: admin, params: { id: fixture.id }, ifMatch: fixture.revision, body: bodyOf(fixture, { name: 'BTC bullish' }) });
    expect(keep15.status).toBe(400);
    expect(keep15.body.issues).toEqual([{ path: 'interval', message: expect.stringMatching(/v2 uses 5m, but this route is 15m/) }]);
    const eth = await call(routeById.PUT, { method: 'PUT', path: '/x', cookie: admin, params: { id: fixture.id }, ifMatch: fixture.revision, body: bodyOf(fixture, { interval: '5', instrumentId: ETH }) });
    expect(eth.status).toBe(400);
    expect(eth.body.issues).toEqual([{ path: 'instrumentId', message: expect.stringMatching(/v2 does not approve ETHUSDT/) }]);
    expect(await routeRow(fixture.id)).toMatchObject({ interval: '15', revision: fixture.revision });
  });

  it('editing the route to 5m updates every field, bumps the revision and audits before/after', async () => {
    const r = await call(routeById.PUT, {
      method: 'PUT',
      path: '/x',
      cookie: admin,
      params: { id: fixture.id },
      ifMatch: fixture.revision,
      body: bodyOf(fixture, { name: 'BTC 5m bullish', sourceExchange: 'mexc', sourceSymbol: 'btcusdt.p', interval: '5', maxSignalAgeSeconds: 60, clockToleranceSeconds: 4 })
    });
    expect(r.status).toBe(200);
    expect(await routeRow(fixture.id)).toMatchObject({ name: 'BTC 5m bullish', sourceExchange: 'MEXC', sourceSymbol: 'BTCUSDT.P', interval: '5', maxSignalAgeSeconds: 60, clockToleranceSeconds: 4, enabled: true, revision: fixture.revision + 1 });
    const [a] = await audits('ADMIN_SIGNAL_ROUTE_EDIT', fixture.id);
    expect(a).toMatchObject({ result: 'SUCCESS', before: { interval: '15', name: fixture.name }, after: { interval: '5', name: 'BTC 5m bullish' } });
    // A stale revision is refused.
    expect((await call(routeById.PUT, { method: 'PUT', path: '/x', cookie: admin, params: { id: fixture.id }, ifMatch: fixture.revision, body: bodyOf(fixture, { interval: '5' }) })).status).toBe(409);
  });

  it('an edit that would duplicate another enabled route is rejected', async () => {
    const other = await call(routes.POST, { method: 'POST', path: '/x', cookie: admin, body: { ...bodyOf(fixture), name: 'BTC 5m bearish', interval: '5', action: 'BEARISH_FLIP' } });
    expect(other.status).toBe(201);
    const row = (await routeRow(other.body.id))!;
    const dup = await call(routeById.PUT, { method: 'PUT', path: '/x', cookie: admin, params: { id: row.id }, ifMatch: row.revision, body: bodyOf(row, { action: 'BULLISH_FLIP' }) });
    expect(dup.status).toBe(409);
    expect(dup.body).toMatchObject({ code: 'DUPLICATE', message: expect.stringMatching(/“BTC 5m bullish”/) });
    expect(await routeRow(row.id)).toMatchObject({ action: 'BEARISH_FLIP', revision: row.revision });
  });

  it('an unused route is deleted permanently after confirmation, and audited', async () => {
    const created = await call(routes.POST, { method: 'POST', path: '/x', cookie: admin, body: { ...bodyOf(fixture), name: 'Typo route', sourceSymbol: 'BTCUSTD.P', interval: '5' } });
    const row = (await routeRow(created.body.id))!;
    expect((await call(routeById.DELETE, { method: 'DELETE', path: '/x', cookie: admin, params: { id: row.id } })).status).toBe(428); // revision required
    const del = await call(routeById.DELETE, { method: 'DELETE', path: '/x', cookie: admin, params: { id: row.id }, ifMatch: row.revision });
    expect(del.status).toBe(204);
    expect(await routeRow(row.id)).toBeUndefined();
    const [a] = await audits('ADMIN_SIGNAL_ROUTE_DELETE', row.id);
    expect(a).toMatchObject({ result: 'SUCCESS', before: { sourceSymbol: 'BTCUSTD.P', name: 'Typo route' } });
  });

  it('a fresh 5m BTCUSDT.P alert matches the enabled 5m route after the change', async () => {
    const bar = new Date('2026-11-08T10:00:00Z'); // closes 10:05; received 10:05:03
    const r = await alert('BULLISH_FLIP', '5', bar);
    expect(r.status).toBe(202);
    const [ev] = await direct.db.select().from(schema.signalEvents).where(eq(schema.signalEvents.id, r.body.eventId));
    expect(ev).toMatchObject({ routeId: fixture.id, interval: '5', sourceSymbol: 'BTCUSDT.P', instrumentId: BTC, packageId: PKG, disposition: 'DISPATCH' });
    // The old 15m tuple no longer routes.
    const old = await alert('BULLISH_FLIP', '15', new Date('2026-11-08T09:45:00Z'));
    expect(old.status).toBe(422);
    expect(old.body.reason).toBe('ROUTE_NOT_FOUND');
  });

  it('a route with signal history is preserved: delete is refused (Disable offered), disable works', async () => {
    const row = (await routeRow(fixture.id))!;
    const del = await call(routeById.DELETE, { method: 'DELETE', path: '/x', cookie: admin, params: { id: row.id }, ifMatch: row.revision });
    expect(del.status).toBe(409);
    expect(del.body.message).toMatch(/signal history \(1 accepted event\(s\), 0 rejection\(s\)\).*Disable it instead/);
    expect(await routeRow(row.id)).toBeDefined();
    expect((await audits('ADMIN_SIGNAL_ROUTE_DELETE', row.id)).map((a) => a.result)).toEqual(['DENIED']);
    const list = await call(routes.GET, { path: '/x', cookie: admin });
    expect(list.body.items.find((x: { id: string }) => x.id === row.id).history).toEqual({ events: 1, rejections: 0 });
    const off = await call(routeById.PATCH, { method: 'PATCH', path: '/x', cookie: admin, params: { id: row.id }, ifMatch: row.revision, body: { enabled: false } });
    expect(off.status).toBe(200);
    expect(await routeRow(row.id)).toMatchObject({ enabled: false });
    expect((await direct.db.select().from(schema.signalEvents).where(eq(schema.signalEvents.routeId, row.id))).length).toBe(1);
  });

  it('creating a route is held to the same strategy rule', async () => {
    const bad = await call(routes.POST, { method: 'POST', path: '/x', cookie: admin, body: { ...bodyOf(fixture), ...FIXTURE_ROUTE_TUPLE, name: 'BTC 15m bullish again' } });
    expect(bad.status).toBe(400);
    expect(bad.body.issues[0]).toMatchObject({ path: 'interval' });
  });
});
