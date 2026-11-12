// CFG-03, CFG-04, AT-05 (seven weekdays persist), OPS-02 (live disabled), OPS-04 (audit).
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WEEKDAYS } from '@trendpilot/domain';
import { schema } from '@trendpilot/db';
import * as blocks from '@/app/v1/me/order-blocks/route';
import * as block from '@/app/v1/me/order-blocks/[id]/route';
import * as pause from '@/app/v1/me/order-blocks/[id]/pause/route';
import * as resume from '@/app/v1/me/order-blocks/[id]/resume/route';
import { blockBody, call, direct, ETH, resetAndSeed, signIn, teardown, TEST_VERSION, USERS, XRP_DISABLED } from '../helpers';

let a: string;
let blk: any;

const create = (body: unknown, cookie = a) => call(blocks.POST, { method: 'POST', path: '/v1/me/order-blocks', cookie, body });
const patch = (id: string, rev: number | string | undefined, body: unknown) =>
  call(block.PATCH, { method: 'PATCH', path: `/v1/me/order-blocks/${id}`, cookie: a, params: { id }, ifMatch: rev, body });

beforeAll(async () => {
  await resetAndSeed();
  a = await signIn(USERS.investorA.email);
  const r = await create(blockBody());
  expect(r.status).toBe(201);
  blk = r.body;
});
afterAll(teardown);

describe('create', () => {
  it('starts paused, with all seven days and Asia/Dhaka', () => {
    expect(blk).toMatchObject({ status: 'PAUSED', revision: 1, weekdays: [...WEEKDAYS], timezone: 'Asia/Dhaka', mode: 'PAPER', exchange: 'MEXC' });
  });

  it('a second block for the same pair and mode is 409 DUPLICATE_BLOCK', async () => {
    const r = await create(blockBody());
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('DUPLICATE_BLOCK');
  });

  it('a LIVE block can be saved but not activated without a verified MEXC connection', async () => {
    const r = await create(blockBody({ instrumentId: ETH, strategyVersionId: TEST_VERSION, mode: 'LIVE' }));
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ mode: 'LIVE', status: 'PAUSED' });
    const res = await call(resume.POST, { method: 'POST', path: '/x', cookie: a, params: { id: r.body.id }, ifMatch: r.body.revision });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('RESUME_BLOCKED');
    expect(res.body.message).toMatch(/MEXC/);
  });

  it('validates leverage and pair against the catalog', async () => {
    const lev = await create(blockBody({ instrumentId: ETH, strategyVersionId: TEST_VERSION, leverage: 100 }));
    expect(lev.status).toBe(400);
    expect(lev.body.issues.map((i: any) => i.path)).toContain('leverage');
    const disabled = await create(blockBody({ instrumentId: XRP_DISABLED, leverage: 5 }));
    expect(disabled.status).toBe(400);
    expect(disabled.body.issues.map((i: any) => i.path)).toContain('instrumentId');
  });

  it('rejects malformed input with field issues', async () => {
    const r = await create(blockBody({ instrumentId: ETH, strategyVersionId: TEST_VERSION, orderCostUsdt: '-5', weekdays: ['MON', 'HOLIDAY'] }));
    expect(r.status).toBe(400);
    expect(r.body.issues.map((i: any) => i.path)).toEqual(expect.arrayContaining(['orderCostUsdt', 'weekdays.1']));
  });

  it('rejects a non-JSON body', async () => {
    const req = new Request('http://localhost:3000/v1/me/order-blocks', { method: 'POST', headers: { cookie: a, 'content-type': 'text/plain' }, body: 'hi' });
    const res = await blocks.POST(req, { params: Promise.resolve({}) });
    expect(res.status).toBe(400);
  });
});

describe('seven weekday controls persist', () => {
  const subsets: string[][] = [...WEEKDAYS.map((d) => [d]), [...WEEKDAYS], [], ['SAT', 'SUN', 'WED']];

  it.each(subsets.map((s) => [s.join(',') || '(none)', s]))('round-trips %s', async (_label, days) => {
    const current = (await call(block.GET, { path: `/v1/me/order-blocks/${blk.id}`, cookie: a, params: { id: blk.id } })).body;
    const r = await patch(blk.id, current.revision, { weekdays: days });
    expect(r.status).toBe(200);
    const expected = WEEKDAYS.filter((d) => (days as string[]).includes(d));
    expect(r.body.weekdays).toEqual(expected);
    const [row] = await direct.db.select().from(schema.orderBlocks).where(eq(schema.orderBlocks.id, blk.id));
    expect(row!.weekdays).toEqual(expected);
  });
});

describe('optimistic concurrency', () => {
  it('a stale If-Match is 409, a missing one is 428', async () => {
    const current = (await call(block.GET, { path: `/v1/me/order-blocks/${blk.id}`, cookie: a, params: { id: blk.id } })).body;
    const stale = await patch(blk.id, current.revision - 1, { orderCostUsdt: '42' });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('REVISION_CONFLICT');
    const missing = await patch(blk.id, undefined, { orderCostUsdt: '42' });
    expect(missing.status).toBe(428);
    const after = (await call(block.GET, { path: `/v1/me/order-blocks/${blk.id}`, cookie: a, params: { id: blk.id } })).body;
    expect(after.revision).toBe(current.revision);
    expect(after.orderCostUsdt).not.toBe('42');
  });

  it('an edit is validated as a whole after merging', async () => {
    const current = (await call(block.GET, { path: `/v1/me/order-blocks/${blk.id}`, cookie: a, params: { id: blk.id } })).body;
    const r = await patch(blk.id, current.revision, { trailing: { enabled: true, activationPct: null, distancePct: null, basis: 'MARK' } });
    expect(r.status).toBe(400);
    expect(r.body.issues.map((i: any) => i.path)).toContain('trailing.distancePct');
  });
});

describe('pause and resume', () => {
  it('resume then pause, each revision-checked', async () => {
    let cur = (await call(block.GET, { path: `/v1/me/order-blocks/${blk.id}`, cookie: a, params: { id: blk.id } })).body;
    const r1 = await call(resume.POST, { method: 'POST', path: `/v1/me/order-blocks/${blk.id}/resume`, cookie: a, params: { id: blk.id }, ifMatch: cur.revision });
    expect(r1.status).toBe(200);
    expect(r1.body.status).toBe('ACTIVE');
    cur = r1.body;
    const stale = await call(pause.POST, { method: 'POST', path: `/v1/me/order-blocks/${blk.id}/pause`, cookie: a, params: { id: blk.id }, ifMatch: cur.revision - 1 });
    expect(stale.status).toBe(409);
    const r2 = await call(pause.POST, { method: 'POST', path: `/v1/me/order-blocks/${blk.id}/pause`, cookie: a, params: { id: blk.id }, ifMatch: cur.revision });
    expect(r2.status).toBe(200);
    expect(r2.body.status).toBe('PAUSED');
  });

  it('resume is blocked when the pair is no longer published', async () => {
    const eth = await create(blockBody({ instrumentId: ETH, strategyVersionId: TEST_VERSION, leverage: 5 }));
    expect(eth.status).toBe(201);
    await direct.db.update(schema.instruments).set({ status: 'DISABLED' }).where(eq(schema.instruments.id, ETH));
    const r = await call(resume.POST, { method: 'POST', path: `/v1/me/order-blocks/${eth.body.id}/resume`, cookie: a, params: { id: eth.body.id }, ifMatch: eth.body.revision });
    expect(r.status).toBe(422);
    expect(r.body.code).toBe('RESUME_BLOCKED');
    await direct.db.update(schema.instruments).set({ status: 'PUBLISHED' }).where(eq(schema.instruments.id, ETH));
  });
});

describe('audit trail', () => {
  it('records create, update, pause and resume with actor and diff', async () => {
    const events = await direct.db
      .select()
      .from(schema.auditEvents)
      .where(and(eq(schema.auditEvents.targetId, blk.id), eq(schema.auditEvents.result, 'SUCCESS')));
    const actions = new Set(events.map((e) => e.action));
    expect([...actions]).toEqual(expect.arrayContaining(['ORDER_BLOCK_CREATE', 'ORDER_BLOCK_UPDATE', 'ORDER_BLOCK_RESUME', 'ORDER_BLOCK_PAUSE']));
    const update = events.find((e) => e.action === 'ORDER_BLOCK_UPDATE')!;
    expect(update.actorUserId).toBeTruthy();
    expect(update.correlationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(update.after).toHaveProperty('weekdays');
  });

  it('audit rows cannot be updated or deleted', async () => {
    await expect(direct.pool.query("UPDATE audit_events SET action = 'X'")).rejects.toThrow(/append-only/);
    await expect(direct.pool.query('DELETE FROM audit_events')).rejects.toThrow(/append-only/);
  });
});
