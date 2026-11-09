// CFG-02 package maintenance: rename (ID, versions, routes and investor settings untouched), create
// and edit drafts, delete unused drafts and never-published packages, refuse deleting published
// versions, archive (hidden from new selections, blocked while depended upon), admin-only, audited.
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FIXTURE_IDS, FIXTURE_STRATEGY, schema } from '@trendpilot/db';
import { PAPER_TEMPLATE } from '@trendpilot/domain';
import * as routes from '@/app/v1/admin/signal-routes/route';
import * as packages from '@/app/v1/admin/strategy-packages/route';
import * as pkgById from '@/app/v1/admin/strategy-packages/[id]/route';
import * as archive from '@/app/v1/admin/strategy-packages/[id]/archive/route';
import * as restore from '@/app/v1/admin/strategy-packages/[id]/restore/route';
import * as versions from '@/app/v1/admin/strategy-packages/[id]/versions/route';
import * as versionById from '@/app/v1/admin/strategy-versions/[id]/route';
import * as publish from '@/app/v1/admin/strategy-versions/[id]/publish/route';
import * as investorVersions from '@/app/v1/strategy-versions/route';
import * as blocks from '@/app/v1/me/order-blocks/route';
import { blockBody, BTC, call, direct, ETH, resetAndSeed, signIn, teardown, USERS, VERSION } from '../helpers';

const PKG = FIXTURE_IDS.package;
const NEW_NAME = 'Supertrend BTC trend (5m since v2)';

let admin: string;
let investor: string;
let v2: string;
let blockId: string;

const pkgRow = async (id: string) => (await direct.db.select().from(schema.strategyPackages).where(eq(schema.strategyPackages.id, id)))[0];
const versionRows = async (pkg: string) => (await direct.db.select().from(schema.strategyVersions).where(eq(schema.strategyVersions.packageId, pkg))).sort((a, b) => a.version - b.version);
const audit = async (action: string, id: string) => direct.db.select().from(schema.auditEvents).where(and(eq(schema.auditEvents.action, action), eq(schema.auditEvents.targetId, id)));
const listPkg = async (id: string) => (await call(packages.GET, { path: '/x', cookie: admin })).body.items.find((p: { id: string }) => p.id === id);
const draftBody = (o: Record<string, unknown> = {}) => ({ ...PAPER_TEMPLATE, instrumentIds: [BTC], ...o });

async function publishDraft(pkgId: string, o: Record<string, unknown> = {}) {
  const d = await call(versions.POST, { method: 'POST', path: '/x', cookie: admin, params: { id: pkgId }, body: draftBody(o) });
  expect(d.status).toBe(201);
  const p = await call(publish.POST, { method: 'POST', path: '/x', cookie: admin, params: { id: d.body.id }, ifMatch: d.body.revision });
  expect(p.status).toBe(200);
  return p.body;
}

beforeAll(async () => {
  await resetAndSeed();
  admin = await signIn(USERS.admin.email);
  investor = await signIn(USERS.investorA.email);
  // v2 of the fixture lineage runs on 5m; an investor stays pinned to v1.
  v2 = (await publishDraft(PKG, { timeframe: '5m' })).id;
  const b = await call(blocks.POST, { method: 'POST', path: '/x', cookie: investor, body: blockBody({ strategyVersionId: VERSION }) });
  expect(b.status).toBe(201);
  blockId = b.body.id;
});

afterAll(teardown);

describe('rename “Supertrend 15m — paper fixture”', () => {
  it('only administrators can rename (server-side)', async () => {
    const p = (await pkgRow(PKG))!;
    expect((await call(pkgById.PATCH, { method: 'PATCH', path: '/x', cookie: investor, params: { id: PKG }, ifMatch: p.revision, body: { name: 'x y z' } })).status).toBe(403);
    expect((await call(pkgById.PATCH, { method: 'PATCH', path: '/x', params: { id: PKG }, ifMatch: p.revision, body: { name: 'x y z' } })).status).toBe(401);
  });

  it('keeps the package ID, v1 at 15m, v2 at 5m, the webhook route and the investor’s pinned setting', async () => {
    const before = (await pkgRow(PKG))!;
    expect(before.name).toBe(FIXTURE_STRATEGY.packageName);
    const routesBefore = await direct.db.select().from(schema.signalRoutes).where(eq(schema.signalRoutes.packageId, PKG));
    expect(routesBefore.length).toBeGreaterThan(0);

    const r = await call(pkgById.PATCH, { method: 'PATCH', path: '/x', cookie: admin, params: { id: PKG }, ifMatch: before.revision, body: { name: NEW_NAME } });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ id: PKG, name: NEW_NAME, revision: before.revision + 1 });

    expect((await versionRows(PKG)).map((v) => [v.id, v.version, v.timeframe, v.publishedAt !== null])).toEqual([
      [VERSION, 1, '15m', true],
      [v2, 2, '5m', true]
    ]);
    const routesAfter = await direct.db.select().from(schema.signalRoutes).where(eq(schema.signalRoutes.packageId, PKG));
    expect(routesAfter.map((x) => [x.id, x.revision, x.interval])).toEqual(routesBefore.map((x) => [x.id, x.revision, x.interval]));
    const [block] = await direct.db.select().from(schema.orderBlocks).where(eq(schema.orderBlocks.id, blockId));
    expect(block!.strategyVersionId).toBe(VERSION);

    // New name everywhere, shown with the real version and timeframe.
    const list = await call(routes.GET, { path: '/x', cookie: admin });
    expect(list.body.items.find((x: { package: { id: string } }) => x.package.id === PKG).package).toMatchObject({ name: NEW_NAME, latest: { version: 2, timeframe: '5m' } });
    const inv = await call(investorVersions.GET, { path: '/x', cookie: investor });
    expect(inv.body.items.filter((v: { packageId: string }) => v.packageId === PKG).map((v: { packageName: string; version: number; timeframe: string }) => `${v.packageName} · v${v.version} · ${v.timeframe}`)).toEqual([
      `${NEW_NAME} · v2 · 5m`,
      `${NEW_NAME} · v1 · 15m`
    ]);

    const [a] = await audit('ADMIN_STRATEGY_PACKAGE_RENAME', PKG);
    expect(a).toMatchObject({ result: 'SUCCESS', before: { name: FIXTURE_STRATEGY.packageName }, after: { name: NEW_NAME } });
    // A stale revision is refused; a too-short name is a field error.
    expect((await call(pkgById.PATCH, { method: 'PATCH', path: '/x', cookie: admin, params: { id: PKG }, ifMatch: before.revision, body: { name: 'Again' } })).status).toBe(409);
    expect((await call(pkgById.PATCH, { method: 'PATCH', path: '/x', cookie: admin, params: { id: PKG }, ifMatch: before.revision + 1, body: { name: 'ab' } })).status).toBe(400);
  });
});

describe('create, edit and delete drafts', () => {
  let pkgId: string;
  let draftId: string;

  it('a new package gets a first draft with every setting configurable', async () => {
    const p = await call(packages.POST, { method: 'POST', path: '/x', cookie: admin, body: { name: 'Momentum 5m' } });
    expect(p.status).toBe(201);
    pkgId = p.body.id;
    const d = await call(versions.POST, {
      method: 'POST',
      path: '/x',
      cookie: admin,
      params: { id: pkgId },
      body: { timeframe: '5m', atrLength: 14, atrFactor: '2.5', permittedDirections: 'LONG_ONLY', emaFilter: 'EMA200', oppositePolicy: 'CLOSE_ONLY', signalMaxAgeSeconds: 90, maxPriceDeviationPct: '0.3', instrumentIds: [BTC] }
    });
    expect(d.status).toBe(201);
    draftId = d.body.id;
    expect(d.body).toMatchObject({ version: 1, status: 'DRAFT', timeframe: '5m', atrLength: 14, atrFactor: '2.5', emaFilter: 'EMA200', permittedDirections: 'LONG_ONLY', oppositePolicy: 'CLOSE_ONLY', signalMaxAgeSeconds: 90, maxPriceDeviationPct: '0.3', instrumentIds: [BTC] });
  });

  it('Edit draft saves changes (revision-checked) and is audited', async () => {
    const cur = (await listPkg(pkgId)).versions[0];
    const r = await call(versionById.PATCH, { method: 'PATCH', path: '/x', cookie: admin, params: { id: draftId }, ifMatch: cur.revision, body: draftBody({ timeframe: '15m', atrLength: 12, instrumentIds: [BTC, ETH] }) });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ timeframe: '15m', atrLength: 12, status: 'DRAFT' });
    expect([...r.body.instrumentIds].sort()).toEqual([BTC, ETH].sort());
    expect((await audit('ADMIN_STRATEGY_DRAFT_UPDATE', draftId)).length).toBe(1);
  });

  it('an unused draft is deleted (confirmed in the UI), and audited; the package can then be deleted', async () => {
    const cur = (await listPkg(pkgId)).versions[0];
    expect((await call(versionById.DELETE, { method: 'DELETE', path: '/x', cookie: investor, params: { id: draftId }, ifMatch: cur.revision })).status).toBe(403);
    const del = await call(versionById.DELETE, { method: 'DELETE', path: '/x', cookie: admin, params: { id: draftId }, ifMatch: cur.revision });
    expect(del.status).toBe(204);
    expect(await versionRows(pkgId)).toEqual([]);
    expect((await audit('ADMIN_STRATEGY_DRAFT_DELETE', draftId)).map((a) => a.result)).toEqual(['SUCCESS']);
    const p = (await pkgRow(pkgId))!;
    expect((await call(pkgById.DELETE, { method: 'DELETE', path: '/x', cookie: admin, params: { id: pkgId }, ifMatch: p.revision })).status).toBe(204);
    expect(await pkgRow(pkgId)).toBeUndefined();
    expect((await audit('ADMIN_STRATEGY_PACKAGE_DELETE', pkgId)).map((a) => a.result)).toEqual(['SUCCESS']);
  });

  it('a published version cannot be deleted; a package with published versions cannot be deleted', async () => {
    const del = await call(versionById.DELETE, { method: 'DELETE', path: '/x', cookie: admin, params: { id: v2 }, ifMatch: 2 });
    expect(del.status).toBe(409);
    expect(del.body).toMatchObject({ code: 'IMMUTABLE', message: expect.stringMatching(/v2 of .* is published.*Archive the package/) });
    expect((await versionRows(PKG)).map((v) => v.id)).toContain(v2);
    expect((await audit('ADMIN_STRATEGY_DRAFT_DELETE', v2)).map((a) => a.result)).toEqual(['DENIED']);
    const p = (await pkgRow(PKG))!;
    const pkgDel = await call(pkgById.DELETE, { method: 'DELETE', path: '/x', cookie: admin, params: { id: PKG }, ifMatch: p.revision });
    expect(pkgDel.status).toBe(409);
    expect(pkgDel.body.message).toMatch(/2 published versions.*archive the package/);
  });

  it('“Create draft from this version” = a new draft prefilled from a published one; publishing makes a new version and investors stay pinned', async () => {
    const v1 = (await listPkg(PKG)).versions.find((v: { version: number }) => v.version === 1);
    const { id: _id, ...settings } = { id: v1.id, timeframe: v1.timeframe, atrLength: v1.atrLength, atrFactor: v1.atrFactor, permittedDirections: v1.permittedDirections, emaFilter: v1.emaFilter, oppositePolicy: v1.oppositePolicy, signalMaxAgeSeconds: v1.signalMaxAgeSeconds, maxPriceDeviationPct: v1.maxPriceDeviationPct, instrumentIds: v1.instrumentIds };
    const v3 = await publishDraft(PKG, { ...settings, atrFactor: '3.5' });
    expect(v3).toMatchObject({ version: 3, timeframe: '15m', atrFactor: '3.5', isLatest: true });
    const [block] = await direct.db.select().from(schema.orderBlocks).where(eq(schema.orderBlocks.id, blockId));
    expect(block!.strategyVersionId).toBe(VERSION);
    expect((await audit('ADMIN_STRATEGY_PUBLISH', v3.id)).length).toBe(1);
  });
});

describe('archive', () => {
  it('is blocked while an enabled route or an investor setting depends on the package, and says what to resolve', async () => {
    const p = (await pkgRow(PKG))!;
    const r = await call(archive.POST, { method: 'POST', path: '/x', cookie: admin, params: { id: PKG }, ifMatch: p.revision });
    expect(r.status).toBe(409);
    expect(r.body.message).toMatch(/cannot be archived yet\. Still depending on it: \d+ enabled signal routes? .*; 1 investor order block using one of its versions/);
    expect((await pkgRow(PKG))!.archivedAt).toBeNull();
    expect((await audit('ADMIN_STRATEGY_PACKAGE_ARCHIVE', PKG)).map((a) => a.result)).toEqual(['DENIED']);
  });

  it('a published, unused package is archived: hidden from new routes, drafts and investor settings; history kept; restorable', async () => {
    const pkg = await call(packages.POST, { method: 'POST', path: '/x', cookie: admin, body: { name: 'Old breakout 15m' } });
    const v1 = await publishDraft(pkg.body.id);
    const neverPublished = await call(packages.POST, { method: 'POST', path: '/x', cookie: admin, body: { name: 'Idea only' } });
    const np = (await pkgRow(neverPublished.body.id))!;
    expect((await call(archive.POST, { method: 'POST', path: '/x', cookie: admin, params: { id: np.id }, ifMatch: np.revision })).body.message).toMatch(/never been published\. Delete it instead/);

    const row = (await pkgRow(pkg.body.id))!;
    expect((await call(archive.POST, { method: 'POST', path: '/x', cookie: investor, params: { id: row.id }, ifMatch: row.revision })).status).toBe(403);
    const a = await call(archive.POST, { method: 'POST', path: '/x', cookie: admin, params: { id: row.id }, ifMatch: row.revision });
    expect(a.status).toBe(200);
    expect((await pkgRow(row.id))!.archivedAt).not.toBeNull();
    expect((await audit('ADMIN_STRATEGY_PACKAGE_ARCHIVE', row.id)).map((x) => x.result)).toEqual(['SUCCESS']);
    expect((await versionRows(row.id)).map((v) => v.version)).toEqual([1]); // history kept

    const route = await call(routes.POST, {
      method: 'POST',
      path: '/x',
      cookie: admin,
      body: { name: 'Archived lineage', sourceExchange: 'MEXC', sourceSymbol: 'BTCUSDT.P', interval: '15', action: 'BEARISH_FLIP', kind: 'ACTIONABLE', instrumentId: BTC, packageId: row.id, maxSignalAgeSeconds: 120, clockToleranceSeconds: 5 }
    });
    expect(route.status).toBe(400);
    expect(route.body.issues[0].message).toMatch(/is archived/);
    expect((await call(versions.POST, { method: 'POST', path: '/x', cookie: admin, params: { id: row.id }, body: draftBody() })).status).toBe(400);
    const blk = await call(blocks.POST, { method: 'POST', path: '/x', cookie: await signIn(USERS.investorB.email), body: blockBody({ strategyVersionId: v1.id }) });
    expect(blk.status).toBe(400);
    expect(blk.body.issues.find((i: { path: string }) => i.path === 'strategyVersionId').message).toMatch(/archived/);
    const inv = await call(investorVersions.GET, { path: '/x', cookie: investor });
    expect(inv.body.items.find((v: { id: string }) => v.id === v1.id)).toMatchObject({ packageArchived: true });

    const cur = (await pkgRow(row.id))!;
    expect((await call(restore.POST, { method: 'POST', path: '/x', cookie: admin, params: { id: row.id }, ifMatch: cur.revision })).status).toBe(200);
    expect((await pkgRow(row.id))!.archivedAt).toBeNull();
    expect((await call(versions.POST, { method: 'POST', path: '/x', cookie: admin, params: { id: row.id }, body: draftBody() })).status).toBe(201);
  });
});
