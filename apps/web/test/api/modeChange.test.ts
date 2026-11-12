// Changing an existing Trade Settings entry between Paper and Live (BTC and ETH). The MEXC
// connection is verified against the stateful mocked exchange (no request leaves the process);
// entries and orders run through the normal alert → job → paper simulator path.
import { and, desc, eq, inArray } from 'drizzle-orm';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installLiveTestSeam, schema, type ConnectionRow } from '@trendpilot/db';
import { settingsOf } from '@trendpilot/domain';
import * as blocks from '@/app/v1/me/order-blocks/route';
import * as block from '@/app/v1/me/order-blocks/[id]/route';
import * as modeChange from '@/app/v1/me/order-blocks/[id]/mode-change/route';
import * as resume from '@/app/v1/me/order-blocks/[id]/resume/route';
import * as closePos from '@/app/v1/me/positions/[id]/close/route';
import * as conn from '@/app/v1/me/exchange-connection/route';
import { setTestClock } from '@/server/clock';
import { BTC, ETH, blockBody, call, direct, teardown, TEST_VERSION, userId, USERS } from '../helpers';
import { MockMexc } from '../mexcMock';
import { ALL_DAYS, clock, cookies, deliver, drain, M15, openFromAlert, openPositionOf, plus, tick, work } from '../paperReplay';

const A = USERS.investorA.email;
let mocks: Record<string, MockMexc> = {};

beforeEach(() => {
  mocks = {};
  installLiveTestSeam({ requesterFor: (c: ConnectionRow) => mocks[c.ownerId]!, transportEnabled: false, confirm: { attempts: 1, delayMs: 0 } });
});
afterEach(() => installLiveTestSeam(null));
afterAll(async () => {
  setTestClock(null);
  await teardown();
});

/** A's mocked MEXC account, verified through the normal read-only check. */
async function connectA() {
  const m = new MockMexc();
  m.positionMode = 2;
  mocks[await userId(A)] = m;
  const put = await call(conn.PUT, { method: 'PUT', path: '/x', cookie: cookies.a, body: { accountRef: 'UID …4821', apiKey: 'mx0vglTESTKEYAAAAAAA1234', secretKey: 'TESTSECRETaaaaaaaaaaaaaaaaaaaaaa' } });
  expect(put.body.connection.status).toBe('VERIFIED');
}

const create = (body: Record<string, unknown>) => call(blocks.POST, { method: 'POST', path: '/x', cookie: cookies.a, body });
const getBlock = (id: string) => call(block.GET, { path: '/x', cookie: cookies.a, params: { id } });
const status = (id: string, to: string) => call(modeChange.GET, { path: `/v1/me/order-blocks/${id}/mode-change?to=${to}`, cookie: cookies.a, params: { id } });
const switchMode = (id: string, revision: number, mode: string, extra: Record<string, unknown> = {}) =>
  call(block.PATCH, { method: 'PATCH', path: '/x', cookie: cookies.a, params: { id }, ifMatch: revision, body: { mode, ...extra } });
const blockOf = async (instrumentId: string, mode: 'PAPER' | 'LIVE') =>
  (await direct.db.select().from(schema.orderBlocks).where(and(eq(schema.orderBlocks.ownerId, await userId(A)), eq(schema.orderBlocks.instrumentId, instrumentId), eq(schema.orderBlocks.mode, mode))))[0];

// Non-default settings on every section, so "kept" is meaningful.
const CUSTOM = {
  orderCostUsdt: '35',
  leverage: 5,
  direction: 'LONG_ONLY',
  weekdays: ['MON', 'TUE', 'WED'],
  tradingWindow: { start: '09:00', end: '17:30' },
  takeProfit: undefined,
  takeProfitLong: { mode: 'FIXED', levels: [{ id: 'L', movePct: '0.6', closePct: '100' }] },
  takeProfitShort: { mode: 'FIXED', levels: [{ id: 'S', movePct: '0.4', closePct: '100' }] },
  trailing: { enabled: true, activationPct: '2', distancePct: '1', closePct: '30', basis: 'MARK' }
};

describe('eligible idle entries switch mode, keeping their settings (two contracts)', () => {
  it('BTC: without a verified MEXC connection, Live is refused with the New Entry reason', async () => {
    await openFromAlert({ a: null, b: null }); // fresh database, A signed in, no blocks yet
    const paper = await create(blockBody({ instrumentId: BTC, ...CUSTOM }));
    expect(paper.status).toBe(201);
    const s = await status(paper.body.id, 'LIVE');
    expect(s.body).toMatchObject({ from: 'PAPER', to: 'LIVE', allowed: false, blocker: { code: 'LIVE_UNAVAILABLE' } });
    expect(s.body.blocker.message).toMatch(/Connect and verify your MEXC account/);
    const r = await switchMode(paper.body.id, paper.body.revision, 'LIVE');
    expect(r.status).toBe(422);
    expect(r.body).toMatchObject({ code: 'MODE_CHANGE_BLOCKED', details: { blocker: { code: 'LIVE_UNAVAILABLE' } } });
    expect(r.body.issues).toEqual([{ path: 'mode', message: s.body.blocker.message }]);
    expect((await getBlock(paper.body.id)).body).toMatchObject({ mode: 'PAPER', revision: paper.body.revision });
  });

  it('BTC: with a verified connection, Paper → Live keeps every saved setting, pauses the entry and is audited', async () => {
    await connectA();
    const created = await create(blockBody({ instrumentId: ETH, strategyVersionId: TEST_VERSION, weekdays: ALL_DAYS }));
    expect(created.status).toBe(201);
    const before = created.body; // an unrelated entry stays untouched
    const paper = (await getBlock((await blockOf(BTC, 'PAPER'))!.id)).body;
    const active = (await call(resume.POST, { method: 'POST', path: '/x', cookie: cookies.a, params: { id: paper.id }, ifMatch: paper.revision })).body;
    expect(active.status).toBe('ACTIVE');
    expect((await status(paper.id, 'LIVE')).body).toEqual({ from: 'PAPER', to: 'LIVE', allowed: true, blocker: null });

    const r = await switchMode(paper.id, active.revision, 'LIVE');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ id: paper.id, mode: 'LIVE', status: 'PAUSED', revision: active.revision + 1 });
    expect(settingsOf(r.body)).toEqual(settingsOf(active)); // strategy, window, days, sizing, exits, risk
    expect(r.body.tradingWindow).toEqual({ start: '09:00', end: '17:30' });
    const [audit] = await direct.db.select().from(schema.auditEvents).where(and(eq(schema.auditEvents.targetId, paper.id), eq(schema.auditEvents.action, 'ORDER_BLOCK_UPDATE'))).orderBy(desc(schema.auditEvents.createdAt)).limit(1);
    expect(audit!.metadata).toMatchObject({ modeChange: { from: 'PAPER', to: 'LIVE' } });
    expect(audit!.after).toMatchObject({ mode: 'LIVE', status: 'PAUSED' });
    expect((await getBlock(before.id)).body).toMatchObject({ mode: 'PAPER', revision: before.revision });
  });

  it('ETH (second contract): Live → Paper, and a mode change can carry setting edits in the same save', async () => {
    const eth = (await getBlock((await blockOf(ETH, 'PAPER'))!.id)).body;
    let r = await switchMode(eth.id, eth.revision, 'LIVE', { orderCostUsdt: '42' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ mode: 'LIVE', orderCostUsdt: '42' });
    r = await switchMode(eth.id, r.body.revision, 'PAPER');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ mode: 'PAPER', status: 'PAUSED', orderCostUsdt: '42' });
    // Sending the current mode is a plain settings save.
    expect((await switchMode(eth.id, r.body.revision, 'PAPER')).body).toMatchObject({ mode: 'PAPER', revision: r.body.revision + 1 });
  });

  it('ETH: an entry already in the destination mode is named, and the switch is refused', async () => {
    const paper = (await getBlock((await blockOf(ETH, 'PAPER'))!.id)).body;
    const live = await create(blockBody({ instrumentId: ETH, strategyVersionId: TEST_VERSION, mode: 'LIVE', weekdays: ALL_DAYS }));
    expect(live.status).toBe(201);
    const s = (await status(paper.id, 'LIVE')).body;
    expect(s).toMatchObject({ allowed: false, blocker: { code: 'DESTINATION_EXISTS', destinationBlockId: live.body.id } });
    expect(s.blocker.message).toBe('You already have a Live (MEXC) entry for ETH/USDT. Edit that entry instead.');
    const r = await switchMode(paper.id, paper.revision, 'LIVE');
    expect(r.status).toBe(409);
    expect(r.body.details.blocker.destinationBlockId).toBe(live.body.id);
  });

  it('rejects an unknown mode, and another investor cannot see or switch the entry', async () => {
    const paper = (await getBlock((await blockOf(ETH, 'PAPER'))!.id)).body;
    expect((await switchMode(paper.id, paper.revision, 'DEMO')).status).toBe(400);
    expect((await status(paper.id, 'DEMO')).status).toBe(400);
    const asB = await call(modeChange.GET, { path: `/x?to=LIVE`, cookie: cookies.b, params: { id: paper.id } });
    expect(asB.status).toBe(404);
    const patchB = await call(block.PATCH, { method: 'PATCH', path: '/x', cookie: cookies.b, params: { id: paper.id }, ifMatch: paper.revision, body: { mode: 'LIVE' } });
    expect(patchB.status).toBe(404);
  });
});

describe('an entry managing an open position or pending order keeps its mode', () => {
  it('open position: refused; the saved settings are copied into a separate Live entry; the position stays Paper', async () => {
    await openFromAlert({ a: { ...CUSTOM, direction: 'BOTH', weekdays: ALL_DAYS, tradingWindow: null }, b: null });
    await connectA();
    const pos = (await openPositionOf(A))!;
    expect(pos.mode).toBe('PAPER');
    const paper = (await getBlock(pos.orderBlockId!)).body;

    const s = (await status(paper.id, 'LIVE')).body;
    expect(s).toMatchObject({ allowed: false, blocker: { code: 'BLOCK_IN_USE', openPositions: 1, pendingOrders: 0 } });
    expect(s.blocker.message).toBe('This entry is managing 1 open position in Paper, which stays in Paper. Copy its settings into a separate Live (MEXC) entry instead.');
    const refused = await switchMode(paper.id, paper.revision, 'LIVE');
    expect(refused.status).toBe(409);
    expect(refused.body.details.blocker.code).toBe('BLOCK_IN_USE');

    // "Copy saved settings to a new Live entry": the editor posts the saved settings as a new block.
    const copy = await create({ ...settingsOf(paper), instrumentId: paper.instrumentId, mode: 'LIVE' });
    expect(copy.status).toBe(201);
    expect(copy.body).toMatchObject({ mode: 'LIVE', status: 'PAUSED' });
    expect(settingsOf(copy.body)).toEqual(settingsOf(paper));
    expect((await getBlock(paper.id)).body).toMatchObject({ mode: 'PAPER', revision: paper.revision });
    expect((await openPositionOf(A))!).toMatchObject({ id: pos.id, mode: 'PAPER', orderBlockId: paper.id });
    // Now the Paper entry's destination exists: the investor is directed to that entry instead.
    expect((await status(paper.id, 'LIVE')).body.blocker).toMatchObject({ code: 'DESTINATION_EXISTS', destinationBlockId: copy.body.id });
  });

  it('pending order: a closing order in flight, then a dispatched entry not yet sent, both block; once settled the entry can switch', async () => {
    const live = await blockOf(BTC, 'LIVE');
    await direct.db.delete(schema.orderBlocks).where(eq(schema.orderBlocks.id, live!.id)); // remove the copy from the previous test
    const pos = (await openPositionOf(A))!;
    const paperId = pos.orderBlockId!;

    // Manual close requested, not processed yet: the position is open AND a close order is pending.
    expect((await call(closePos.POST, { method: 'POST', path: '/x', cookie: cookies.a, params: { id: pos.id }, headers: { 'idempotency-key': `mc-${pos.id}` } })).status).toBe(202);
    expect((await status(paperId, 'LIVE')).body.blocker).toMatchObject({ code: 'BLOCK_IN_USE', openPositions: 1, pendingOrders: 1 });
    await drain();
    expect(await openPositionOf(A)).toBeUndefined();
    expect((await status(paperId, 'LIVE')).body).toMatchObject({ allowed: true });

    // A new entry signal: step the queue until the entry order exists but has not been sent.
    const bar = new Date(new Date('2026-11-08T09:15:00Z').getTime() + 2 * M15);
    clock.now = plus(new Date(bar.getTime() + M15), 3);
    setTestClock(() => clock.now);
    await tick('65010', { at: clock.now });
    await drain();
    expect(await deliver('BULLISH_FLIP', bar, '65010')).toBe(202);
    const unfinished = async () =>
      direct.db.select().from(schema.orderIntents).where(and(eq(schema.orderIntents.orderBlockId, paperId), inArray(schema.orderIntents.state, ['INTENT', 'SUBMITTING', 'ACKNOWLEDGED', 'PARTIALLY_FILLED', 'UNKNOWN'])));
    for (let i = 0; i < 10 && (await unfinished()).length === 0; i++) await work();
    expect(await unfinished()).toHaveLength(1);
    const fresh = (await getBlock(paperId)).body;
    expect((await status(paperId, 'LIVE')).body.blocker).toMatchObject({ code: 'BLOCK_IN_USE', openPositions: 0, pendingOrders: 1 });
    expect((await switchMode(paperId, fresh.revision, 'LIVE')).status).toBe(409);

    // The order fills in Paper (its original mode) and the position is Paper.
    await drain();
    const opened = (await openPositionOf(A))!;
    expect(opened).toMatchObject({ mode: 'PAPER', orderBlockId: paperId });
  });
});
