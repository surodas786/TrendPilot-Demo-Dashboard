// AT-01 (SCP-02, IAM-02): two investors, same token, private settings; cross-owner access denied.
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema } from '@trendpilot/db';
import * as blocks from '@/app/v1/me/order-blocks/route';
import * as block from '@/app/v1/me/order-blocks/[id]/route';
import * as pause from '@/app/v1/me/order-blocks/[id]/pause/route';
import * as resume from '@/app/v1/me/order-blocks/[id]/resume/route';
import { blockBody, call, direct, resetAndSeed, signIn, teardown, userId, USERS } from '../helpers';

let a: string;
let b: string;
let aBlock: any;
let bBlock: any;

const rowOf = async (id: string) => (await direct.db.select().from(schema.orderBlocks).where(eq(schema.orderBlocks.id, id)))[0];

beforeAll(async () => {
  await resetAndSeed();
  a = await signIn(USERS.investorA.email);
  b = await signIn(USERS.investorB.email);

  const ra = await call(blocks.POST, {
    method: 'POST',
    path: '/v1/me/order-blocks',
    cookie: a,
    body: blockBody({ orderCostUsdt: '100', leverage: 10, stop: { type: 'PERCENT', value: '1.5', basis: 'MARK' }, weekdays: ['MON', 'TUE', 'WED', 'THU', 'FRI'] })
  });
  const rb = await call(blocks.POST, {
    method: 'POST',
    path: '/v1/me/order-blocks',
    cookie: b,
    body: blockBody({
      orderCostUsdt: '25',
      leverage: 3,
      direction: 'LONG_ONLY',
      stop: { type: 'PERCENT', value: '3', basis: 'MARK' },
      takeProfit: { mode: 'SPLIT', levels: [{ id: 'tp1', movePct: '2', closePct: '62.5' }, { id: 'tp2', movePct: '5', closePct: '37.5' }] },
      trailing: { enabled: true, activationPct: '1', distancePct: '1.2', closePct: '20', basis: 'MARK' },
      weekdays: ['SAT', 'SUN']
    })
  });
  expect(ra.status).toBe(201);
  expect(rb.status).toBe(201);
  aBlock = ra.body;
  bBlock = rb.body;
});

afterAll(teardown);

describe('same token, different settings', () => {
  it('both investors hold their own BTCUSDT PAPER block', async () => {
    expect(aBlock.symbol).toBe('BTCUSDT');
    expect(bBlock.symbol).toBe('BTCUSDT');
    expect(aBlock.id).not.toBe(bBlock.id);
    expect((await rowOf(aBlock.id))!.ownerId).toBe(await userId(USERS.investorA.email));
    expect((await rowOf(bBlock.id))!.ownerId).toBe(await userId(USERS.investorB.email));
  });

  it("each list returns only the caller's block with the caller's values", async () => {
    const la = await call(blocks.GET, { path: '/v1/me/order-blocks', cookie: a });
    const lb = await call(blocks.GET, { path: '/v1/me/order-blocks', cookie: b });
    expect(la.body.items.map((x: any) => x.id)).toEqual([aBlock.id]);
    expect(lb.body.items.map((x: any) => x.id)).toEqual([bBlock.id]);
    expect(la.body.items[0]).toMatchObject({ orderCostUsdt: '100', leverage: 10, weekdays: ['MON', 'TUE', 'WED', 'THU', 'FRI'], timezone: 'Asia/Dhaka' });
    expect(lb.body.items[0]).toMatchObject({
      orderCostUsdt: '25',
      leverage: 3,
      direction: 'LONG_ONLY',
      weekdays: ['SUN', 'SAT'],
      takeProfitLong: { mode: 'SPLIT' },
      takeProfitShort: { mode: 'SPLIT' },
      trailing: { enabled: true, activationPct: '1', distancePct: '1.2', closePct: '20', basis: 'MARK' },
      trailingConversionRequired: false
    });
  });

  it('responses never expose the owner ID', () => {
    expect(aBlock).not.toHaveProperty('ownerId');
    expect(JSON.stringify(aBlock)).not.toContain('owner');
  });
});

describe('cross-owner reads', () => {
  it('B reading A\'s block gets the same 404 as a random ID', async () => {
    const theirs = await call(block.GET, { path: `/v1/me/order-blocks/${aBlock.id}`, cookie: b, params: { id: aBlock.id } });
    const random = '0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f';
    const missing = await call(block.GET, { path: `/v1/me/order-blocks/${random}`, cookie: b, params: { id: random } });
    const garbage = await call(block.GET, { path: '/v1/me/order-blocks/not-a-uuid', cookie: b, params: { id: 'not-a-uuid' } });
    for (const r of [theirs, missing, garbage]) {
      expect(r.status).toBe(404);
      expect(Object.keys(r.body).sort()).toEqual(['code', 'correlationId', 'message']);
      expect(r.body.code).toBe('NOT_FOUND');
      expect(r.body.message).toBe(missing.body.message);
    }
  });

  it('A can read its own block', async () => {
    const r = await call(block.GET, { path: `/v1/me/order-blocks/${aBlock.id}`, cookie: a, params: { id: aBlock.id } });
    expect(r.status).toBe(200);
    expect(r.headers.get('etag')).toBe(`"${aBlock.revision}"`);
  });
});

describe('cross-owner writes', () => {
  it('B cannot PATCH, pause or resume A\'s block, even with the correct revision', async () => {
    const before = await rowOf(aBlock.id);
    const opts = { cookie: b, params: { id: aBlock.id }, ifMatch: aBlock.revision };

    const patch = await call(block.PATCH, { ...opts, method: 'PATCH', path: `/v1/me/order-blocks/${aBlock.id}`, body: { orderCostUsdt: '1', weekdays: [] } });
    const res = await call(resume.POST, { ...opts, method: 'POST', path: `/v1/me/order-blocks/${aBlock.id}/resume` });
    const pau = await call(pause.POST, { ...opts, method: 'POST', path: `/v1/me/order-blocks/${aBlock.id}/pause` });

    for (const r of [patch, res, pau]) {
      expect(r.status).toBe(404);
      expect(r.body.code).toBe('NOT_FOUND');
    }
    expect(await rowOf(aBlock.id)).toEqual(before);
  });

  it('denied attempts are audited against the attacker, not applied', async () => {
    const bId = await userId(USERS.investorB.email);
    const denied = await direct.db.select().from(schema.auditEvents).where(eq(schema.auditEvents.result, 'DENIED'));
    expect(denied.length).toBeGreaterThanOrEqual(3);
    expect(denied.every((e) => e.actorUserId === bId && e.targetId === aBlock.id)).toBe(true);
  });

  it('a body naming another owner is rejected and creates nothing', async () => {
    const aId = await userId(USERS.investorA.email);
    for (const key of ['ownerId', 'owner_id', 'userId']) {
      const r = await call(blocks.POST, {
        method: 'POST',
        path: '/v1/me/order-blocks',
        cookie: b,
        body: blockBody({ instrumentId: (await rowOf(aBlock.id))!.instrumentId, [key]: aId })
      });
      expect(r.status).toBe(400);
      expect(r.body.code).toBe('VALIDATION_FAILED');
    }
    const aRows = await direct.db.select().from(schema.orderBlocks).where(eq(schema.orderBlocks.ownerId, aId));
    expect(aRows).toHaveLength(1);
  });

  it('a PATCH cannot move a block to another owner', async () => {
    const aId = await userId(USERS.investorA.email);
    const r = await call(block.PATCH, {
      method: 'PATCH',
      path: `/v1/me/order-blocks/${bBlock.id}`,
      cookie: b,
      params: { id: bBlock.id },
      ifMatch: bBlock.revision,
      body: { ownerId: aId }
    });
    expect(r.status).toBe(400);
    expect((await rowOf(bBlock.id))!.ownerId).toBe(await userId(USERS.investorB.email));
  });

  it('A editing its own block does not affect B\'s block on the same token', async () => {
    const before = await rowOf(bBlock.id);
    const r = await call(block.PATCH, {
      method: 'PATCH',
      path: `/v1/me/order-blocks/${aBlock.id}`,
      cookie: a,
      params: { id: aBlock.id },
      ifMatch: aBlock.revision,
      body: { orderCostUsdt: '150.25', weekdays: ['WED'] }
    });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ orderCostUsdt: '150.25', weekdays: ['WED'], revision: aBlock.revision + 1 });
    expect(await rowOf(bBlock.id)).toEqual(before);
  });
});

describe('Investor A submits Investor B\'s record ID directly to the API', () => {
  it('cannot read it: GET returns 404 and leaks none of B\'s values', async () => {
    const r = await call(block.GET, { path: `/v1/me/order-blocks/${bBlock.id}`, cookie: a, params: { id: bBlock.id } });
    expect(r.status).toBe(404);
    expect(r.body.code).toBe('NOT_FOUND');
    // Exactly the generic not-found shape; no field of B's block can be present.
    expect(Object.keys(r.body).sort()).toEqual(['code', 'correlationId', 'message']);
    expect(r.body.message).toBe('Not found.');
    expect(r.headers.get('etag')).toBeNull();
  });

  it('cannot update it: PATCH, pause and resume return 404 and B\'s row is unchanged', async () => {
    const before = await rowOf(bBlock.id);
    const opts = { cookie: a, params: { id: bBlock.id }, ifMatch: bBlock.revision };
    const patch = await call(block.PATCH, {
      ...opts,
      method: 'PATCH',
      path: `/v1/me/order-blocks/${bBlock.id}`,
      body: { orderCostUsdt: '9999', leverage: 1, direction: 'SHORT_ONLY', stop: { type: 'PERCENT', value: '50', basis: 'MARK' }, weekdays: [] }
    });
    const pau = await call(pause.POST, { ...opts, method: 'POST', path: `/v1/me/order-blocks/${bBlock.id}/pause` });
    const res = await call(resume.POST, { ...opts, method: 'POST', path: `/v1/me/order-blocks/${bBlock.id}/resume` });
    for (const r of [patch, pau, res]) {
      expect(r.status).toBe(404);
      expect(r.body.code).toBe('NOT_FOUND');
    }
    expect(await rowOf(bBlock.id)).toEqual(before);
  });

  it('B still reads its own original settings afterwards', async () => {
    const r = await call(block.GET, { path: `/v1/me/order-blocks/${bBlock.id}`, cookie: b, params: { id: bBlock.id } });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ orderCostUsdt: '25', leverage: 3, direction: 'LONG_ONLY', stop: { value: '3' }, weekdays: ['SUN', 'SAT'] });
  });

  it('settings reload after signing in again', async () => {
    const again = await signIn(USERS.investorA.email);
    const r = await call(blocks.GET, { path: '/v1/me/order-blocks', cookie: again });
    expect(r.body.items).toHaveLength(1);
    expect(r.body.items[0]).toMatchObject({ id: aBlock.id, orderCostUsdt: '150.25', weekdays: ['WED'] });
  });
});
