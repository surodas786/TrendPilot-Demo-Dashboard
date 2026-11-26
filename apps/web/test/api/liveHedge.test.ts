// Hedge position mode (MEXC positionMode 1) through the real flow: alert → Live entry → ticks /
// manual close / signal → paper.close / paper.reverse → MEXC adapter, against a stateful mocked
// MEXC. Exact serialized payloads; one Hedge leg closed while the other leg and its stop stay;
// partial fills, external closes, duplicate triggers and mode changes. Nothing leaves the process.
import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installLiveSyncSeam, installLiveTestSeam, recordMarketTick, requestExit, schema, syncLiveAccount, writeMarketFixture, type ConnectionRow, type LiveTestSeam } from '@trendpilot/db';
import { Decimal } from '@trendpilot/domain';
import * as blocks from '@/app/v1/me/order-blocks/route';
import * as resume from '@/app/v1/me/order-blocks/[id]/resume/route';
import * as conn from '@/app/v1/me/exchange-connection/route';
import * as activate from '@/app/v1/me/live/activate/route';
import * as meLive from '@/app/v1/me/live/route';
import * as closeRoute from '@/app/v1/me/positions/[id]/close/route';
import * as platform from '@/app/v1/admin/live/platform/route';
import * as capabilities from '@/app/v1/admin/live/capabilities/route';
import * as contracts from '@/app/v1/admin/live/contracts/[id]/route';
import * as approve from '@/app/v1/admin/live/connections/[id]/approve/route';
import { setTestClock } from '@/server/clock';
import { BTC, blockBody, call, direct, teardown, userId, USERS } from '../helpers';
import { MockMexc } from '../mexcMock';
import { ALL_DAYS, clock, cookies, deliver, drain, M15, openFromAlert, plus, positionsOf, publishVersion } from '../paperReplay';

const A = USERS.investorA.email;
const D = (v: Decimal.Value) => new Decimal(v);
const LIMITS = { maxOrderContracts: '1000', maxOrderNotionalUsdt: '500', maxLeverage: 10, maxExposureUsdt: '500' };
const BAR = new Date('2026-11-08T09:15:00Z');
const TWELVE = { orderCostUsdt: '15.6', leverage: 5 };
const TRAILING = { stop: { type: 'PERCENT', value: '2', basis: 'MARK' }, takeProfit: { mode: 'OFF', levels: [] }, trailing: { enabled: true, activationPct: '0.3', distancePct: '0.1', closePct: '100', basis: 'MARK' } };

let mx: MockMexc;
beforeEach(() => {
  mx = new MockMexc();
  mx.positionMode = 1; // Hedge
  mx.now = () => clock.now.getTime();
  const seam: LiveTestSeam = { requesterFor: (_c: ConnectionRow) => mx, transportEnabled: true, confirm: { attempts: 2, delayMs: 0 } };
  installLiveTestSeam(seam);
  installLiveSyncSeam(() => mx);
});
afterEach(() => {
  installLiveTestSeam(null);
  installLiveSyncSeam(null);
});
afterAll(async () => {
  setTestClock(null);
  await teardown();
});

async function openHedge(side: 'LONG' | 'SHORT', block: Record<string, unknown> = {}, o: { policy?: 'CLOSE_ONLY' | 'CLOSE_AND_REVERSE'; before?: () => void } = {}) {
  await openFromAlert({
    side,
    a: null,
    b: null,
    market: async () => {
      const put = await call(conn.PUT, { method: 'PUT', path: '/x', cookie: cookies.a, body: { accountRef: 'UID …4821', apiKey: 'mx0vglTESTKEYAAAAAAA1234', secretKey: 'TESTSECRETaaaaaaaaaaaaaaaaaaaaaa' } });
      expect(put.body.connection).toMatchObject({ status: 'VERIFIED', positionMode: 'HEDGE' });
      const version = o.policy ? { strategyVersionId: await publishVersion({ oppositePolicy: o.policy }) } : {};
      const created = await call(blocks.POST, { method: 'POST', path: '/x', cookie: cookies.a, body: blockBody({ mode: 'LIVE', weekdays: ALL_DAYS, ...TWELVE, ...version, ...block }) });
      expect(created.status).toBe(201);
      expect((await call(resume.POST, { method: 'POST', path: '/x', cookie: cookies.a, params: { id: created.body.id }, ifMatch: created.body.revision })).status).toBe(200);
      expect((await call(approve.POST, { method: 'POST', path: '/x', cookie: cookies.admin, params: { id: put.body.connection.id }, body: LIMITS })).status).toBe(200);
      expect((await call(activate.POST, { method: 'POST', path: '/x', cookie: cookies.a })).status).toBe(200);
      for (const c of ['OPEN_WITH_ATTACHED_STOP', 'REDUCE_ONLY_CLOSE', 'STOP_RESIZE_AFTER_PARTIAL_CLOSE', 'CANCEL_STOP'])
        expect((await call(capabilities.POST, { method: 'POST', path: '/x', cookie: cookies.admin, body: { capability: c, state: 'PILOT_ACCEPTED', evidence: 'test' } })).status).toBe(200);
      await direct.db.update(schema.instruments).set({ isFixture: false, exchangeSymbol: 'BTC_USDT' }).where(eq(schema.instruments.id, BTC));
      expect((await call(contracts.POST, { method: 'POST', path: '/x', cookie: cookies.admin, params: { id: BTC }, body: { allowed: true } })).status).toBe(200);
      expect((await call(platform.POST, { method: 'POST', path: '/x', cookie: cookies.admin, body: { enabled: true, note: 'test' } })).status).toBe(200);
      o.before?.();
      await writeMarketFixture(direct.db, { instrumentId: BTC, interval: '15', endBarOpen: BAR, count: 260, endClose: '65000', trend: side === 'SHORT' ? 'DOWN' : 'UP', quoteAt: clock.now });
    }
  });
  const p = (await positionsOf(A)).find((x) => x.mode === 'LIVE' && x.status === 'OPEN')!;
  expect(p).toMatchObject({ side, protectionStatus: 'PROTECTED' });
  return p;
}

const leg = (side: 'LONG' | 'SHORT') => mx.positions.get(`BTC_USDT:${side === 'LONG' ? 1 : 2}`);
const posById = async (id: string) => (await direct.db.select().from(schema.positions).where(eq(schema.positions.id, id)))[0]!;
const closeIntents = (positionId: string) =>
  direct.db
    .select()
    .from(schema.orderIntents)
    .where(and(eq(schema.orderIntents.positionId, positionId), eq(schema.orderIntents.kind, 'CLOSE')))
    .orderBy(schema.orderIntents.createdAt);
const bodies = () => mx.creates().map((c) => c.body as Record<string, unknown>);
const closeBodies = () => bodies().filter((b) => b.side === 2 || b.side === 4);
const openBodies = () => bodies().filter((b) => b.side === 1 || b.side === 3);
async function px(mid: string, seconds = 10) {
  clock.now = plus(clock.now, seconds);
  setTestClock(() => clock.now);
  await recordMarketTick(direct.db, { instrumentId: BTC, asOf: clock.now, bid: D(mid).minus('0.5').toFixed(), ask: D(mid).plus('0.5').toFixed(), mark: mid, last: mid });
  mx.price.BTC_USDT = mid;
  return (await drain(clock.now, direct.db)).find((x) => x.tick)?.tick;
}
/** An opposite leg opened directly on MEXC, with its own active stop. Returns the stop ID. */
function externalLeg(side: 'LONG' | 'SHORT', vol: string) {
  mx.externalOpen('BTC_USDT', side === 'LONG' ? 1 : 2, vol, '65000');
  const p = leg(side)!;
  const id = 990_001;
  mx.stops.set(id, { id, orderId: 0, positionId: p.positionId, symbol: 'BTC_USDT', positionType: side === 'LONG' ? 1 : 2, stopLossPrice: side === 'LONG' ? '60000' : '70000', lossTrend: 1, vol, state: 1 });
  return id;
}
const hedgeClose = (side: 'LONG' | 'SHORT', vol: string, price: string, externalOid: string, positionId: number) => ({
  symbol: 'BTC_USDT',
  price,
  vol,
  side: side === 'LONG' ? 4 : 2,
  type: 5,
  openType: 1,
  externalOid,
  positionId,
  positionMode: 1
});

describe('Hedge: exact serialized entry and close payloads', () => {
  for (const side of ['LONG', 'SHORT'] as const) {
    it(`${side}: entry side ${side === 'LONG' ? 1 : 3} with positionMode 1 and the stop attached; manual close side ${side === 'LONG' ? 4 : 2} bound to the leg, no reduceOnly`, async () => {
      const p = await openHedge(side);
      const [open] = openBodies();
      const openIntent = (await direct.db.select().from(schema.orderIntents).where(eq(schema.orderIntents.id, p.openIntentId!)))[0]!;
      expect(open).toEqual({
        symbol: 'BTC_USDT',
        price: expect.any(String),
        vol: D(p.contracts).toFixed(),
        leverage: 5,
        side: side === 'LONG' ? 1 : 3,
        type: 5,
        openType: 1,
        externalOid: openIntent.clientOrderId,
        stopLossPrice: D(openIntent.stopPrice).toFixed(),
        lossTrend: 2,
        positionMode: 1
      });
      const r = await call(closeRoute.POST, { method: 'POST', path: '/x', cookie: cookies.a, params: { id: p.id }, headers: { 'idempotency-key': `hedge-manual-${side}` } });
      expect(r.status).toBe(202);
      await drain(clock.now, direct.db);
      const [close] = await closeIntents(p.id);
      const q = (await direct.db.select().from(schema.marketQuotes).where(eq(schema.marketQuotes.instrumentId, BTC)).orderBy(schema.marketQuotes.asOf)).at(-1)!;
      expect(closeBodies()).toEqual([hedgeClose(side, D(p.contracts).toFixed(), D(side === 'LONG' ? q.bid : q.ask).toFixed(), close!.clientOrderId, leg(side)!.positionId)]);
      expect((close!.venueRequest as { context: Record<string, unknown> }).context).toMatchObject({ positionModeRaw: 1, accountMode: 'HEDGE', position: { positionType: side === 'LONG' ? 1 : 2 } });
      expect(await posById(p.id)).toMatchObject({ status: 'CLOSED', closeReason: 'MANUAL_CLOSE' });
    });

    it(`${side}: trailing take profit closes with the Hedge body`, async () => {
      const p = await openHedge(side, TRAILING);
      const [act, trig] = side === 'LONG' ? ['65300', '65200'] : ['64700', '64800'];
      await px(act);
      await px(trig);
      const [close] = await closeIntents(p.id);
      expect(close).toMatchObject({ exitReason: 'TRAILING_TAKE_PROFIT', state: 'FILLED' });
      const price = side === 'LONG' ? D(trig).minus('0.5').toFixed() : D(trig).plus('0.5').toFixed();
      expect(closeBodies()).toEqual([hedgeClose(side, D(p.contracts).toFixed(), price, close!.clientOrderId, leg(side)!.positionId)]);
    });

    it(`${side}: fixed take profit closes with the Hedge body`, async () => {
      const p = await openHedge(side, { takeProfit: { mode: 'FIXED', levels: [{ id: 'tp1', movePct: '0.5', closePct: '100' }] } });
      const [arm, pull] = side === 'LONG' ? ['65500', '65300'] : ['64500', '64700'];
      await px(arm);
      await px(pull);
      const [close] = await closeIntents(p.id);
      expect(close).toMatchObject({ exitReason: 'TAKE_PROFIT', state: 'FILLED' });
      const price = side === 'LONG' ? D(pull).minus('0.5').toFixed() : D(pull).plus('0.5').toFixed();
      expect(closeBodies()).toEqual([hedgeClose(side, D(p.contracts).toFixed(), price, close!.clientOrderId, leg(side)!.positionId)]);
    });

    it(`${side}: close and reverse — the leg closes first (Hedge body), the opposite leg opens only once MEXC reports it flat`, async () => {
      const p = await openHedge(side, {}, { policy: 'CLOSE_AND_REVERSE' });
      const original = leg(side)!;
      const next = new Date(BAR.getTime() + M15);
      clock.now = plus(new Date(next.getTime() + M15), 3);
      setTestClock(() => clock.now);
      const mid = side === 'LONG' ? '64900' : '65100';
      await recordMarketTick(direct.db, { instrumentId: BTC, asOf: clock.now, bid: D(mid).minus('0.5').toFixed(), ask: D(mid).plus('0.5').toFixed(), mark: mid, last: mid });
      mx.price.BTC_USDT = mid;
      await drain(clock.now, direct.db);
      expect(await deliver(side === 'LONG' ? 'BEARISH_FLIP' : 'BULLISH_FLIP', next, mid)).toBe(202);
      await drain(clock.now, direct.db);
      const [close] = await closeIntents(p.id);
      expect(close).toMatchObject({ exitReason: 'REVERSAL_CLOSE', state: 'FILLED' });
      const price = side === 'LONG' ? D(mid).minus('0.5').toFixed() : D(mid).plus('0.5').toFixed();
      const all = bodies();
      expect(all[1]).toEqual(hedgeClose(side, D(p.contracts).toFixed(), price, close!.clientOrderId, original.positionId));
      expect(all.slice(2)).toEqual([expect.objectContaining({ side: side === 'LONG' ? 3 : 1, positionMode: 1 })]);
      expect('reduceOnly' in all[2]!).toBe(false);
      expect(D(original.holdVol).isZero()).toBe(true);
      const opposite = side === 'LONG' ? 'SHORT' : 'LONG';
      expect((await positionsOf(A)).find((x) => x.status === 'OPEN')).toMatchObject({ side: opposite, protectionStatus: 'PROTECTED' });
    });
  }
});

describe('Hedge: one leg closes, the other leg and its stop stay', () => {
  it('closing TrendPilot\'s Long leaves the MEXC Short leg and its stop untouched', async () => {
    const p = await openHedge('LONG');
    const shortStop = externalLeg('SHORT', '7');
    const r = await call(closeRoute.POST, { method: 'POST', path: '/x', cookie: cookies.a, params: { id: p.id }, headers: { 'idempotency-key': 'hedge-keep-other' } });
    expect(r.status).toBe(202);
    await drain(clock.now, direct.db);
    expect(closeBodies()).toEqual([expect.objectContaining({ side: 4, positionId: leg('LONG')!.positionId, positionMode: 1 })]);
    expect(await posById(p.id)).toMatchObject({ status: 'CLOSED' });
    expect(D(leg('LONG')!.holdVol).isZero()).toBe(true);
    expect(leg('SHORT')!.holdVol).toBe('7');
    expect(mx.stops.get(shortStop)!.state).toBe(1); // still active
    expect(mx.calls.filter((c) => c.path === '/api/v1/private/stoporder/cancel').flatMap((c) => (c.body as { orders: { stopPlanOrderId: number }[] }).orders.map((o) => o.stopPlanOrderId))).not.toContain(shortStop);
  });

  it('a partial fill resizes only this leg\'s stop; the other leg and its stop are unchanged', async () => {
    const p = await openHedge('SHORT');
    const longStop = externalLeg('LONG', '9');
    mx.faults.fillRatio = 0.5;
    await call(closeRoute.POST, { method: 'POST', path: '/x', cookie: cookies.a, params: { id: p.id }, headers: { 'idempotency-key': 'hedge-partial' } });
    await drain(clock.now, direct.db);
    const after = await posById(p.id);
    expect(D(after.contracts).toFixed()).toBe('6');
    // Never cancel-first: MEXC refuses a replacement while the old stop rests (closable quantity),
    // so the original reduce-only stop stays at its price and covers the remainder (reported).
    expect(after).toMatchObject({ status: 'OPEN', protectionStatus: 'PROTECTED' });
    expect(D(after.stopContracts!).toFixed()).toBe('12');
    expect(leg('LONG')!.holdVol).toBe('9');
    expect(mx.stops.get(longStop)).toMatchObject({ state: 1, vol: '9' });
  });

  it('the sync reports the other leg as a Hedge leg TrendPilot did not open, and never touches it', async () => {
    const p = await openHedge('LONG');
    externalLeg('SHORT', '3');
    mx.calls = [];
    const r = await syncLiveAccount(direct.db, await userId(A), plus(clock.now, 5));
    expect(r).toMatchObject({ ok: true, positionMode: 'HEDGE' });
    expect(r.drift).toEqual([expect.objectContaining({ kind: 'SIDE_MISMATCH', detail: expect.stringMatching(/^Hedge: MEXC also holds a SHORT leg of 3 contracts .* left untouched$/) })]);
    expect(mx.calls.filter((c) => c.method === 'POST')).toEqual([]);
    expect(await posById(p.id)).toMatchObject({ status: 'OPEN' });
  });
});

describe('Hedge: external closes, duplicate triggers, mode changes', () => {
  it('a leg closed on the MEXC website is reconciled by the sync; nothing is sent', async () => {
    const p = await openHedge('SHORT');
    mx.manualClose('BTC_USDT', 2, D(p.contracts).toFixed(), '64900', { fee: '0.01', profit: '0.1' });
    mx.calls = [];
    await syncLiveAccount(direct.db, await userId(A), plus(clock.now, 5));
    expect(await posById(p.id)).toMatchObject({ status: 'CLOSED', closeReason: 'EXTERNAL_CLOSE' });
    expect(mx.calls.filter((c) => c.method === 'POST')).toEqual([]);
  });

  it('a trailing trigger rejected by MEXC is sent once; repeated prices and a concurrent request add nothing', async () => {
    const p = await openHedge('SHORT', TRAILING);
    mx.faults.rejectClosesWith = 2001;
    await px('64700');
    await px('64800');
    const pos = await posById(p.id);
    await Promise.all([0, 1].map(() => direct.db.transaction((tx) => requestExit(tx, { position: pos, reason: 'TRAILING_TAKE_PROFIT', now: clock.now }))));
    for (let k = 0; k < 10; k++) await px(k % 2 ? '64800' : '64850', 5);
    expect(closeBodies()).toHaveLength(1);
    expect(await closeIntents(p.id)).toHaveLength(1);
    expect((await posById(p.id)).exitHaltReason).toMatch(/^MEXC_2001/);
  });

  it('a mode change on MEXC is detected by the sync: stored mode updated, drift recorded, entries halted; orders are refused until it is consistent', async () => {
    const p = await openHedge('LONG');
    mx.positionMode = 2; // switched to One-way on MEXC (TrendPilot verified Hedge)
    const r = await syncLiveAccount(direct.db, await userId(A), plus(clock.now, 5));
    expect(r.positionMode).toBe('ONE_WAY');
    expect(r.drift).toContainEqual(expect.objectContaining({ kind: 'POSITION_MODE_CHANGED', detail: expect.stringMatching(/now ONE_WAY; TrendPilot had HEDGE/) }));
    const status = (await call(meLive.GET, { path: '/x', cookie: cookies.a })).body;
    expect(status.connection.positionMode).toBe('ONE_WAY');
    expect(status.entries.blockers.map((b: { reason: string }) => b.reason)).toContain('LIVE_ACCOUNT_HALTED');
    // A second run with the same mode reports no mode drift (the halt stays until someone resumes it).
    const again = await syncLiveAccount(direct.db, await userId(A), plus(clock.now, 10));
    expect(again.drift.map((d) => d.kind)).not.toContain('POSITION_MODE_CHANGED');
    void p;
  });

  it('a reversal into an opposite leg that already exists at MEXC follows the add-to-position rule (no adds → withheld)', async () => {
    const p = await openHedge('LONG', {}, { policy: 'CLOSE_AND_REVERSE' });
    externalLeg('SHORT', '4');
    const next = new Date(BAR.getTime() + M15);
    clock.now = plus(new Date(next.getTime() + M15), 3);
    setTestClock(() => clock.now);
    await recordMarketTick(direct.db, { instrumentId: BTC, asOf: clock.now, bid: '64899.5', ask: '64900.5', mark: '64900', last: '64900' });
    mx.price.BTC_USDT = '64900';
    await drain(clock.now, direct.db);
    expect(await deliver('BEARISH_FLIP', next, '64900')).toBe(202);
    await drain(clock.now, direct.db);
    expect(await posById(p.id)).toMatchObject({ status: 'CLOSED', closeReason: 'REVERSAL_CLOSE' });
    expect(openBodies()).toHaveLength(1); // the original entry only
    const [decision] = await direct.db
      .select()
      .from(schema.signalDecisions)
      .where(and(eq(schema.signalDecisions.ownerId, await userId(A)), eq(schema.signalDecisions.reason, 'REVERSAL_OPPOSITE_LEG_EXISTS')));
    expect(decision).toBeTruthy();
    expect(leg('SHORT')!.holdVol).toBe('4');
  });
});
