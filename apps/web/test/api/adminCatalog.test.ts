// UI-05, CFG-02, CFG-03, EXE-01, IAM-02, OPS-04: admin catalog, version pinning, preview, access.
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema } from '@trendpilot/db';
import { PAPER_TEMPLATE } from '@trendpilot/domain';
import * as users from '@/app/v1/admin/users/route';
import * as resend from '@/app/v1/admin/users/[id]/resend-invite/route';
import * as suspend from '@/app/v1/admin/users/[id]/suspend/route';
import * as reactivate from '@/app/v1/admin/users/[id]/reactivate/route';
import * as adminReset from '@/app/v1/admin/users/[id]/reset-password/route';
import * as adminRevoke from '@/app/v1/admin/users/[id]/revoke-sessions/route';
import * as instruments from '@/app/v1/admin/instruments/route';
import * as validate from '@/app/v1/admin/instruments/validate/route';
import * as instrument from '@/app/v1/admin/instruments/[id]/route';
import * as packages from '@/app/v1/admin/strategy-packages/route';
import * as versions from '@/app/v1/admin/strategy-packages/[id]/versions/route';
import * as version from '@/app/v1/admin/strategy-versions/[id]/route';
import * as publish from '@/app/v1/admin/strategy-versions/[id]/publish/route';
import * as audit from '@/app/v1/admin/audit/route';
import * as publicInstruments from '@/app/v1/instruments/route';
import * as publicVersions from '@/app/v1/strategy-versions/route';
import * as blocks from '@/app/v1/me/order-blocks/route';
import * as block from '@/app/v1/me/order-blocks/[id]/route';
import * as pause from '@/app/v1/me/order-blocks/[id]/pause/route';
import * as resume from '@/app/v1/me/order-blocks/[id]/resume/route';
import * as previewDraft from '@/app/v1/me/order-blocks/preview/route';
import * as previewSaved from '@/app/v1/me/order-blocks/[id]/preview/route';
import { BTC, blockBody, call, direct, ETH, resetAndSeed, signIn, teardown, userId, USERS, VERSION } from '../helpers';

let admin: string;
let a: string;
let b: string;
const SUGGEST = { suggestedStopPct: '2.5', suggestedTakeProfitPct: '5', suggestedTrailingEnabled: false, suggestedTrailingPct: '2' };
const post = (h: any, o: Record<string, unknown> = {}) => call(h.POST, { method: 'POST', path: '/x', ...o });

beforeAll(async () => {
  await resetAndSeed();
  admin = await signIn(USERS.admin.email);
  a = await signIn(USERS.investorA.email);
  b = await signIn(USERS.investorB.email);
});
afterAll(teardown);

describe('investors cannot use admin actions (direct requests)', () => {
  const id = '0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f';
  const cases: [string, any, Record<string, unknown>][] = [
    ['GET users', users.GET, {}],
    ['POST users (invite)', users.POST, { method: 'POST', body: { name: 'Evil Person', email: 'evil@trendpilot.local' } }],
    ['resend invite', resend.POST, { method: 'POST', params: { id } }],
    ['suspend', suspend.POST, { method: 'POST', params: { id }, ifMatch: 1 }],
    ['reactivate', reactivate.POST, { method: 'POST', params: { id }, ifMatch: 1 }],
    ['reset password', adminReset.POST, { method: 'POST', params: { id } }],
    ['revoke sessions', adminRevoke.POST, { method: 'POST', params: { id } }],
    ['GET instruments', instruments.GET, {}],
    ['POST instrument', instruments.POST, { method: 'POST', body: { symbol: 'SOLUSDT', ...SUGGEST } }],
    ['validate ticker', validate.POST, { method: 'POST', body: { symbol: 'SOLUSDT' } }],
    ['PATCH instrument', instrument.PATCH, { method: 'PATCH', params: { id: BTC }, ifMatch: 1, body: { status: 'DISABLED' } }],
    ['GET packages', packages.GET, {}],
    ['POST package', packages.POST, { method: 'POST', body: { name: 'Evil package' } }],
    ['POST version draft', versions.POST, { method: 'POST', params: { id }, body: { ...PAPER_TEMPLATE, instrumentIds: [BTC] } }],
    ['PATCH version', version.PATCH, { method: 'PATCH', params: { id: VERSION }, ifMatch: 1, body: { ...PAPER_TEMPLATE, instrumentIds: [BTC] } }],
    ['publish version', publish.POST, { method: 'POST', params: { id: VERSION }, ifMatch: 1 }],
    ['GET audit', audit.GET, {}]
  ];

  it.each(cases)('%s → 403 for an investor, 401 without a session', async (_n, handler, opts) => {
    const before = await direct.db.select().from(schema.users);
    const r = await call(handler, { path: '/v1/admin/x', cookie: a, ...opts });
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('FORBIDDEN');
    expect((await call(handler, { path: '/v1/admin/x', ...opts })).status).toBe(401);
    expect(await direct.db.select().from(schema.users)).toHaveLength(before.length);
  });

  it('nothing changed: BTC still published, no extra packages, v1 untouched', async () => {
    const [btc] = await direct.db.select().from(schema.instruments).where(eq(schema.instruments.id, BTC));
    expect(btc!.status).toBe('PUBLISHED');
    expect((await direct.db.select().from(schema.strategyPackages)).map((p) => p.name)).not.toContain('Evil package');
  });
});

describe('trading pairs (local MEXC contract fixtures)', () => {
  let sol: any;

  it('validates a ticker only against the fixture catalogue, clearly labelled', async () => {
    const ok = await post(validate, { cookie: admin, body: { symbol: 'solusdt' } });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ symbol: 'SOLUSDT', exchangeSymbol: 'SOL_USDT', source: 'FIXTURE' });
    expect(ok.body.fixtureLabel).toMatch(/fixture/i);
    const unknown = await post(validate, { cookie: admin, body: { symbol: 'NOTREALUSDT' } });
    expect(unknown.status).toBe(400);
    expect(unknown.body.issues[0].path).toBe('symbol');
  });

  it('publishes a pair with suggested exits; a duplicate is 409', async () => {
    const r = await post(instruments, { cookie: admin, body: { symbol: 'SOLUSDT', ...SUGGEST } });
    expect(r.status).toBe(201);
    sol = r.body;
    expect(sol).toMatchObject({ symbol: 'SOLUSDT', status: 'PUBLISHED', isFixture: true, suggested: { stopPct: '2.5', takeProfitPct: '5' } });
    expect((await post(instruments, { cookie: admin, body: { symbol: 'SOLUSDT', ...SUGGEST } })).status).toBe(409);
    const visible = await call(publicInstruments.GET, { path: '/v1/instruments', cookie: a });
    expect(visible.body.items.map((i: any) => i.symbol)).toContain('SOLUSDT');
  });

  it('edits are revision-checked; disabling hides the pair from investors', async () => {
    const stale = await call(instrument.PATCH, { method: 'PATCH', path: '/x', cookie: admin, params: { id: sol.id }, ifMatch: sol.revision + 5, body: { suggestedStopPct: '3' } });
    expect(stale.status).toBe(409);
    const off = await call(instrument.PATCH, { method: 'PATCH', path: '/x', cookie: admin, params: { id: sol.id }, ifMatch: sol.revision, body: { status: 'DISABLED' } });
    expect(off.status).toBe(200);
    const visible = await call(publicInstruments.GET, { path: '/v1/instruments', cookie: a });
    expect(visible.body.items.map((i: any) => i.symbol)).not.toContain('SOLUSDT');
  });
});

describe('strategy versions: drafts, immutability and pinning', () => {
  let aBlock: any;
  let v2: any;

  it('investor A saves a block pinned to v1', async () => {
    const r = await post(blocks, { cookie: a, body: blockBody() });
    expect(r.status).toBe(201);
    aBlock = r.body;
    expect(aBlock.strategyVersionId).toBe(VERSION);
  });

  it('admin drafts v2 (5m, EMA 200, close-and-reverse); only one open draft per package', async () => {
    const pkgs = await call(packages.GET, { path: '/x', cookie: admin });
    const pkgId = pkgs.body.items.find((p: any) => p.versions.some((v: any) => v.id === VERSION)).id;
    const body = { ...PAPER_TEMPLATE, timeframe: '5m', emaFilter: 'EMA200', oppositePolicy: 'CLOSE_AND_REVERSE', atrLength: 14, atrFactor: '2.5', instrumentIds: [BTC, ETH] };
    const r = await post(versions, { cookie: admin, params: { id: pkgId }, body });
    expect(r.status).toBe(201);
    v2 = r.body;
    expect(v2).toMatchObject({ version: 2, status: 'DRAFT', timeframe: '5m', emaFilter: 'EMA200', oppositePolicy: 'CLOSE_AND_REVERSE', atrLength: 14, atrFactor: '2.5' });
    expect((await post(versions, { cookie: admin, params: { id: pkgId }, body })).status).toBe(409);
  });

  it('investors cannot select an unpublished draft', async () => {
    const r = await call(block.PATCH, { method: 'PATCH', path: '/x', cookie: a, params: { id: aBlock.id }, ifMatch: aBlock.revision, body: { strategyVersionId: v2.id } });
    expect(r.status).toBe(400);
    expect(r.body.issues.map((i: any) => i.path)).toContain('strategyVersionId');
  });

  it('a draft can be edited (revision-checked), then published', async () => {
    const edit = await call(version.PATCH, { method: 'PATCH', path: '/x', cookie: admin, params: { id: v2.id }, ifMatch: v2.revision, body: { ...PAPER_TEMPLATE, timeframe: '5m', emaFilter: 'EMA200', oppositePolicy: 'CLOSE_AND_REVERSE', atrLength: 12, atrFactor: '2.5', instrumentIds: [BTC, ETH] } });
    expect(edit.status).toBe(200);
    expect(edit.body.atrLength).toBe(12);
    expect((await call(publish.POST, { method: 'POST', path: '/x', cookie: admin, params: { id: v2.id }, ifMatch: v2.revision })).status).toBe(409);
    const pub = await call(publish.POST, { method: 'POST', path: '/x', cookie: admin, params: { id: v2.id }, ifMatch: edit.body.revision });
    expect(pub.status).toBe(200);
    v2 = pub.body;
    expect(v2).toMatchObject({ status: 'PUBLISHED', isLatest: true });
  });

  it('published versions are immutable: API 409 and the database trigger', async () => {
    const r = await call(version.PATCH, { method: 'PATCH', path: '/x', cookie: admin, params: { id: v2.id }, ifMatch: v2.revision, body: { ...PAPER_TEMPLATE, instrumentIds: [BTC] } });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('IMMUTABLE');
    await expect(direct.pool.query('UPDATE strategy_versions SET atr_length = 99 WHERE id = $1', [VERSION])).rejects.toThrow(/immutable/);
    await expect(direct.pool.query('DELETE FROM strategy_version_instruments WHERE version_id = $1', [VERSION])).rejects.toThrow(/immutable/);
    const [v1] = await direct.db.select().from(schema.strategyVersions).where(eq(schema.strategyVersions.id, VERSION));
    expect(v1!.atrLength).toBe(10);
  });

  it('existing settings stay pinned to v1 after v2 is published', async () => {
    const r = await call(block.GET, { path: '/x', cookie: a, params: { id: aBlock.id } });
    expect(r.body.strategyVersionId).toBe(VERSION);
    expect(r.body.revision).toBe(aBlock.revision);
    const list = await call(publicVersions.GET, { path: '/x', cookie: a });
    const byId = Object.fromEntries(list.body.items.map((v: any) => [v.id, v]));
    expect(byId[VERSION]).toMatchObject({ version: 1, isLatest: false, timeframe: '15m' });
    expect(byId[v2.id]).toMatchObject({ version: 2, isLatest: true, timeframe: '5m' });
  });

  it('moving a block to v2 is an explicit investor edit', async () => {
    const r = await call(block.PATCH, { method: 'PATCH', path: '/x', cookie: a, params: { id: aBlock.id }, ifMatch: aBlock.revision, body: { strategyVersionId: v2.id } });
    expect(r.status).toBe(200);
    expect(r.body.strategyVersionId).toBe(v2.id);
    aBlock = r.body;
  });

  it('a version not approved for the pair is rejected (compatibility)', async () => {
    // v1 is approved for BTCUSDT only.
    const r = await post(blocks, { cookie: b, body: blockBody({ instrumentId: ETH, strategyVersionId: VERSION, leverage: 5 }) });
    expect(r.status).toBe(400);
    expect(r.body.issues.find((i: any) => i.path === 'strategyVersionId').message).toMatch(/not approved/);
  });
});

describe('order preview (fixture data, no orders)', () => {
  it('previews unsaved settings with labelled fixture quotes', async () => {
    const r = await post(previewDraft, { cookie: a, body: blockBody({ orderCostUsdt: '100', leverage: 10 }) });
    expect(r.status).toBe(200);
    expect(r.body.quote.source).toBe('FIXTURE');
    expect(r.body.instrument.fixtureLabel).toMatch(/fixture/i);
    const long = r.body.sides.find((s: any) => s.side === 'LONG');
    expect(long).toMatchObject({ entryPrice: '65000', contracts: '153', estimatedMarginUsdt: '99.45', ok: true });
  });

  it('validates like a save (400 with field issues)', async () => {
    const r = await post(previewDraft, { cookie: a, body: blockBody({ orderCostUsdt: '-1' }) });
    expect(r.status).toBe(400);
  });

  it('a saved block preview is owner-scoped: B previewing A\'s block is 404', async () => {
    const own = await call(blocks.GET, { path: '/x', cookie: a });
    const id = own.body.items[0].id;
    expect((await post(previewSaved, { cookie: a, params: { id } })).status).toBe(200);
    const theirs = await post(previewSaved, { cookie: b, params: { id } });
    expect(theirs.status).toBe(404);
    expect(theirs.body.code).toBe('NOT_FOUND');
    expect((await post(previewSaved, { cookie: admin, params: { id } })).status).toBe(403);
  });

  it('placed no orders and changed nothing', async () => {
    const own = await call(blocks.GET, { path: '/x', cookie: a });
    expect(own.body.items).toHaveLength(1);
  });
});

describe('pause and resume persist across sign-in', () => {
  it('a paused block is still paused after signing in again, and resumed after resuming', async () => {
    let cur = (await call(blocks.GET, { path: '/x', cookie: a })).body.items[0];
    const res = await post(resume, { cookie: a, params: { id: cur.id }, ifMatch: cur.revision });
    expect(res.body.status).toBe('ACTIVE');
    cur = res.body;
    const p = await post(pause, { cookie: a, params: { id: cur.id }, ifMatch: cur.revision });
    expect(p.body.status).toBe('PAUSED');

    const again = await signIn(USERS.investorA.email);
    expect((await call(blocks.GET, { path: '/x', cookie: again })).body.items[0].status).toBe('PAUSED');
    const r2 = await post(resume, { cookie: again, params: { id: cur.id }, ifMatch: p.body.revision });
    expect(r2.body.status).toBe('ACTIVE');
    const third = await signIn(USERS.investorA.email);
    expect((await call(blocks.GET, { path: '/x', cookie: third })).body.items[0].status).toBe('ACTIVE');
  });
});

describe('audit history', () => {
  it('admin sees actor, time and action for catalog changes, newest first, paginated', async () => {
    const first = await call(audit.GET, { path: '/v1/admin/audit?action=ADMIN_&limit=3', cookie: admin });
    expect(first.status).toBe(200);
    expect(first.body.items).toHaveLength(3);
    expect(first.body.nextCursor).toBeTruthy();
    for (const e of first.body.items) {
      expect(e.action).toMatch(/^ADMIN_/);
      expect(e.actor.email).toBe(USERS.admin.email);
      expect(new Date(e.at).getTime()).toBeGreaterThan(0);
    }
    const next = await call(audit.GET, { path: `/v1/admin/audit?action=ADMIN_&limit=3&cursor=${first.body.nextCursor}`, cookie: admin });
    const ids = new Set([...first.body.items, ...next.body.items].map((e: any) => e.id));
    expect(ids.size).toBe(first.body.items.length + next.body.items.length);
    const all = await call(audit.GET, { path: '/v1/admin/audit?limit=200', cookie: admin });
    const actions = all.body.items.map((e: any) => e.action);
    for (const act of ['ADMIN_INSTRUMENT_CREATE', 'ADMIN_INSTRUMENT_UPDATE', 'ADMIN_STRATEGY_DRAFT_CREATE', 'ADMIN_STRATEGY_DRAFT_UPDATE', 'ADMIN_STRATEGY_PUBLISH', 'ORDER_BLOCK_CREATE', 'ORDER_BLOCK_UPDATE', 'ORDER_BLOCK_PAUSE', 'ORDER_BLOCK_RESUME']) {
      expect(actions, act).toContain(act);
    }
    const update = all.body.items.find((e: any) => e.action === 'ORDER_BLOCK_UPDATE');
    expect(update.actor.id).toBe(await userId(USERS.investorA.email));
    expect(update.after).toHaveProperty('strategyVersionId');
  });
});
