// Live close orders after the 14 Nov 2026 incident (XAU_USDT, 21:27–21:28 Asia/Dhaka): a Live
// trailing take profit on a 12-contract Short issued CLOSE SHORT again and again, each with a new
// externalOid, and MEXC rejected every one with 2001. Through the real flow (alert → Live entry
// → market ticks → paper.close → MEXC adapter) against a stateful mocked MEXC: the serialized
// close request for Long and Short, the rejection loop, partial fills, manual closes on MEXC and
// ambiguous responses. Nothing leaves the process.
import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AUTO_CLOSE_RETRY, installLiveSyncSeam, installLiveTestSeam, requestExit, schema, syncLiveAccount, writeMarketFixture, type ConnectionRow, type LiveTestSeam } from '@trendpilot/db';
import { Decimal } from '@trendpilot/domain';
import * as blocks from '@/app/v1/me/order-blocks/route';
import * as resume from '@/app/v1/me/order-blocks/[id]/resume/route';
import * as conn from '@/app/v1/me/exchange-connection/route';
import * as activate from '@/app/v1/me/live/activate/route';
import * as holdingsRoute from '@/app/v1/me/holdings/route';
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
/** 15.6 USDT × 5 at 65,000 with 0.0001 BTC per contract → 12 contracts, as in the incident. */
const TWELVE = { orderCostUsdt: '15.6', leverage: 5 };
/** Trailing Take Profit only (100 %), activation 0.3 %, trail 0.1 % on the mark price; stop 2 %. */
const TRAILING = { stop: { type: 'PERCENT', value: '2', basis: 'MARK' }, takeProfit: { mode: 'OFF', levels: [] }, trailing: { enabled: true, activationPct: '0.3', distancePct: '0.1', closePct: '100', basis: 'MARK' } };

let mx: MockMexc;
beforeEach(() => {
  mx = new MockMexc();
  mx.positionMode = 2;
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

async function openLive(side: 'LONG' | 'SHORT', block: Record<string, unknown> = {}, o: { reverse?: boolean; closeOnly?: boolean } = {}) {
  await openFromAlert({
    side,
    a: null,
    b: null,
    market: async () => {
      const put = await call(conn.PUT, { method: 'PUT', path: '/x', cookie: cookies.a, body: { accountRef: 'UID …4821', apiKey: 'mx0vglTESTKEYAAAAAAA1234', secretKey: 'TESTSECRETaaaaaaaaaaaaaaaaaaaaaa' } });
      expect(put.body.connection.status).toBe('VERIFIED');
      const policy = o.reverse ? 'CLOSE_AND_REVERSE' : o.closeOnly ? 'CLOSE_ONLY' : null;
      const version = policy ? { strategyVersionId: await publishVersion({ oppositePolicy: policy }) } : {};
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
      await writeMarketFixture(direct.db, { instrumentId: BTC, interval: '15', endBarOpen: BAR, count: 260, endClose: '65000', trend: side === 'SHORT' ? 'DOWN' : 'UP', quoteAt: clock.now });
    }
  });
  const p = (await positionsOf(A)).find((x) => x.mode === 'LIVE' && x.status === 'OPEN')!;
  expect(p).toMatchObject({ side, protectionStatus: 'PROTECTED' });
  mx.calls = [];
  return p;
}

const posById = async (id: string) => (await direct.db.select().from(schema.positions).where(eq(schema.positions.id, id)))[0]!;
const closeIntents = (positionId: string) =>
  direct.db
    .select()
    .from(schema.orderIntents)
    .where(and(eq(schema.orderIntents.positionId, positionId), eq(schema.orderIntents.kind, 'CLOSE')))
    .orderBy(schema.orderIntents.createdAt);
const closeCreates = () => mx.creates().filter((c) => [2, 4].includes(Number((c.body as Record<string, unknown>).side)));
/** One quote (mark = mid) and the jobs it causes; returns the market.tick summary. */
async function px(mid: string, seconds = 10) {
  clock.now = plus(clock.now, seconds);
  setTestClock(() => clock.now);
  const { recordMarketTick } = await import('@trendpilot/db');
  await recordMarketTick(direct.db, { instrumentId: BTC, asOf: clock.now, bid: D(mid).minus('0.5').toFixed(), ask: D(mid).plus('0.5').toFixed(), mark: mid, last: mid });
  mx.price.BTC_USDT = mid;
  const out = await drain(clock.now, direct.db);
  return out.find((x) => x.tick)?.tick;
}
/** Short: activate trailing (price 0.3 % below entry), then pull back through the 0.1 % trail. */
const SHORT_ACTIVATE = '64700';
const SHORT_TRIGGER = '64800';
const LONG_ACTIVATE = '65300';
const LONG_TRIGGER = '65200';

describe('serialized close request through the real flow', () => {
  it('Short trailing take profit: side 2, 12 contracts, reduceOnly, one-way, MEXC positionId and openType of the exchange position', async () => {
    const p = await openLive('SHORT', TRAILING);
    expect(D(p.contracts).toFixed()).toBe('12');
    const mexcPos = mx.positions.get('BTC_USDT:2')!;
    await px(SHORT_ACTIVATE);
    await px(SHORT_TRIGGER);
    const [close] = await closeIntents(p.id);
    const body = closeCreates()[0]!.body as Record<string, unknown>;
    expect(body).toEqual({ symbol: 'BTC_USDT', price: D(SHORT_TRIGGER).plus('0.5').toFixed(), vol: '12', side: 2, type: 5, openType: 1, externalOid: close!.clientOrderId, positionId: mexcPos.positionId, reduceOnly: true, positionMode: 2 });
    expect(close).toMatchObject({ exitReason: 'TRAILING_TAKE_PROFIT', state: 'FILLED' });
    expect(close!.venueRequest).toMatchObject({ method: 'POST', path: '/api/v1/private/order/create', body });
    expect(JSON.stringify(close!.venueRequest)).not.toMatch(/TESTKEY|TESTSECRET|signature/i);
    expect(close!.venueResponse).toMatchObject({ code: 0, positionAfter: '0' }); // fresh read: MEXC holds none of it
    expect(await posById(p.id)).toMatchObject({ status: 'CLOSED' });
    expect(mx.positions.get('BTC_USDT:1')).toBeUndefined(); // no Long was opened by the close
  });

  it('Long trailing take profit: side 4 at the bid, the whole position, reduceOnly', async () => {
    const p = await openLive('LONG', TRAILING);
    await px(LONG_ACTIVATE);
    await px(LONG_TRIGGER);
    const body = closeCreates()[0]!.body as Record<string, unknown>;
    expect(body).toMatchObject({ side: 4, vol: D(p.contracts).toFixed(), price: D(LONG_TRIGGER).minus('0.5').toFixed(), reduceOnly: true, positionMode: 2, openType: 1 });
    expect(await posById(p.id)).toMatchObject({ status: 'CLOSED' });
    expect(mx.positions.get('BTC_USDT:2')).toBeUndefined();
  });

  it('margin mode and account mode are read from MEXC, not from TrendPilot (cross position, Hedge account)', async () => {
    const p = await openLive('SHORT');
    mx.positions.get('BTC_USDT:2')!.openType = 2; // MEXC reports a cross position
    mx.positionMode = 1; // account switched to Hedge after verification
    await direct.db.transaction((tx) => requestExit(tx, { position: p, reason: 'MANUAL_CLOSE', now: clock.now }));
    await drain(clock.now, direct.db);
    const body = closeCreates()[0]!.body as Record<string, unknown>;
    expect(body).toMatchObject({ side: 2, openType: 2, positionMode: 1 });
    expect('reduceOnly' in body).toBe(false);
  });

  it('a stored MEXC position ID that MEXC no longer holds sends nothing (a newer position is never closed in its place)', async () => {
    const p = await openLive('SHORT');
    await direct.db.update(schema.positions).set({ exchangePositionRef: '999999' }).where(eq(schema.positions.id, p.id));
    await direct.db.transaction(async (tx) => requestExit(tx, { position: (await tx.select().from(schema.positions).where(eq(schema.positions.id, p.id)))[0]!, reason: 'MANUAL_CLOSE', now: clock.now }));
    await drain(clock.now, direct.db);
    expect(closeCreates()).toHaveLength(0);
    expect((await closeIntents(p.id))[0]).toMatchObject({ state: 'REJECTED', stateReason: 'REDUCE_ONLY_NO_POSITION' });
  });
});

describe('incident reproduction: 12-contract Short trailing TP rejected with MEXC 2001', () => {
  it('one attempt, then automatic exits are halted; repeated prices send nothing more; the stop stays; the investor sees why', async () => {
    const p = await openLive('SHORT', TRAILING);
    mx.faults.rejectClosesWith = 2001;
    await px(SHORT_ACTIVATE);
    await px(SHORT_TRIGGER);
    let intents = await closeIntents(p.id);
    expect(intents).toHaveLength(1);
    expect(intents[0]).toMatchObject({ exitReason: 'TRAILING_TAKE_PROFIT', state: 'REJECTED', stateReason: 'MEXC_2001' });
    expect(intents[0]!.venueRequest).toMatchObject({ path: '/api/v1/private/order/create', body: { side: 2, vol: '12', reduceOnly: true, positionMode: 2, externalOid: intents[0]!.clientOrderId } });
    expect(intents[0]!.venueResponse).toEqual({ code: 2001, message: 'order direction error' });
    let pos = await posById(p.id);
    expect(pos.exitHaltedAt).not.toBeNull();
    expect(pos.exitHaltReason).toMatch(/^MEXC_2001 on TRAILING_TAKE_PROFIT /);
    expect(pos).toMatchObject({ status: 'OPEN', protectionStatus: 'PROTECTED' });

    // The trigger stays true for many prices, across worker runs: no new intent, no new order.
    for (let k = 0; k < 20; k++) {
      const t = await px(k % 2 ? SHORT_TRIGGER : '64900', 5);
      expect(t?.trailingTakeProfitsRequested).toBe(0);
    }
    intents = await closeIntents(p.id);
    expect(intents).toHaveLength(1);
    expect(closeCreates()).toHaveLength(1);
    expect(new Set(closeCreates().map((c) => (c.body as Record<string, unknown>).externalOid)).size).toBe(1);
    // The exchange stop protects all 12 contracts.
    expect([...mx.stops.values()].filter((s) => s.state === 1).map((s) => s.vol)).toEqual(['12']);

    const h = (await call(holdingsRoute.GET, { path: '/x', cookie: cookies.a })).body.positions.find((x: { id: string }) => x.id === p.id);
    expect(h.exitHalt).toMatchObject({ reason: expect.stringMatching(/^MEXC_2001/), text: expect.stringMatching(/error 2001.*paused.*stop loss is still in place/s) });

    // A manual close is still accepted (one explicit request; MEXC still refuses it here).
    pos = await posById(p.id);
    const r = await call(closeRoute.POST, { method: 'POST', path: '/x', cookie: cookies.a, params: { id: p.id }, headers: { 'idempotency-key': 'manual-after-2001' } });
    expect(r.status).toBe(202);
    await drain(clock.now, direct.db);
    expect(closeCreates()).toHaveLength(2);
    expect((await closeIntents(p.id)).at(-1)).toMatchObject({ exitReason: 'MANUAL_CLOSE', state: 'REJECTED', stateReason: 'MEXC_2001' });
  });

  it('the same trigger is never duplicated by concurrent jobs: one unresolved close per position', async () => {
    const p = await openLive('SHORT', TRAILING);
    await px(SHORT_ACTIVATE);
    const pos = await posById(p.id);
    const both = await Promise.all([0, 1].map(() => direct.db.transaction((tx) => requestExit(tx, { position: pos, reason: 'TRAILING_TAKE_PROFIT', now: clock.now }))));
    expect(both.map((r) => r.status).sort()).toEqual(['IN_PROGRESS', 'REQUESTED']);
    await drain(clock.now, direct.db);
    expect(closeCreates()).toHaveLength(1);
  });
});

describe('transient rejections: spaced and capped, never once per price', () => {
  it(`a rate-limited close is retried at most every ${AUTO_CLOSE_RETRY.backoffMs / 1000} s and halts after ${AUTO_CLOSE_RETRY.maxAttempts} attempts`, async () => {
    const p = await openLive('SHORT', TRAILING);
    mx.faults.rejectClosesWith = 510;
    await px(SHORT_ACTIVATE);
    for (let k = 0; k < 30; k++) await px(SHORT_TRIGGER, 5); // 150 s of prices that keep the trigger true
    const intents = await closeIntents(p.id);
    expect(intents).toHaveLength(AUTO_CLOSE_RETRY.maxAttempts);
    expect(intents.every((i) => i.stateReason === 'MEXC_510')).toBe(true);
    for (let k = 1; k < intents.length; k++) expect(intents[k]!.createdAt.getTime() - intents[k - 1]!.resolvedAt!.getTime()).toBeGreaterThanOrEqual(AUTO_CLOSE_RETRY.backoffMs);
    expect((await posById(p.id)).exitHaltReason).toMatch(/^EXIT_RETRY_LIMIT TRAILING_TAKE_PROFIT: last MEXC_510/);
    expect(closeCreates()).toHaveLength(AUTO_CLOSE_RETRY.maxAttempts);
  });
});

describe('ambiguous responses, partial fills and manual closes', () => {
  it('a close accepted by MEXC whose response timed out is looked up by its externalOid; prices meanwhile send nothing', async () => {
    const p = await openLive('SHORT', TRAILING);
    await px(SHORT_ACTIVATE);
    mx.faults.timeoutAfterAccept = 1;
    mx.faults.lookupFailsAfterAccept = true; // the immediate lookup fails too: outcome unknown
    await px(SHORT_TRIGGER);
    let [close] = await closeIntents(p.id);
    expect(close!.state).toBe('SUBMITTING');
    mx.faults.lookupNetworkError = false;
    for (let k = 0; k < 5; k++) await px(SHORT_TRIGGER, 10);
    [close] = await closeIntents(p.id);
    expect(close).toMatchObject({ state: 'FILLED' });
    expect(await closeIntents(p.id)).toHaveLength(1);
    expect(closeCreates()).toHaveLength(1);
    expect(await posById(p.id)).toMatchObject({ status: 'CLOSED' });
  });

  it('a partial fill books the filled contracts, keeps the stop on the remainder, and the next close covers only the remainder', async () => {
    const p = await openLive('SHORT', TRAILING);
    await px(SHORT_ACTIVATE);
    mx.faults.fillRatio = 0.5;
    await px(SHORT_TRIGGER);
    const pos = await posById(p.id);
    expect(D(pos.contracts).toFixed()).toBe('6');
    expect(pos).toMatchObject({ status: 'OPEN', protectionStatus: 'PROTECTED' });
    expect(D(pos.stopContracts!).toFixed()).toBe('6');
    expect(pos.exitHaltedAt).toBeNull();
    await px(SHORT_TRIGGER);
    const bodies = closeCreates().map((c) => c.body as Record<string, unknown>);
    expect(bodies.map((b) => b.vol)).toEqual(['12', '6']);
    expect(new Set(bodies.map((b) => b.externalOid)).size).toBe(2);
    expect(await posById(p.id)).toMatchObject({ status: 'CLOSED' });
    expect(mx.positions.get('BTC_USDT:1')).toBeUndefined();
  });

  it('closed manually on MEXC before the trigger: the trigger sends nothing, the sync closes it from exchange state', async () => {
    const p = await openLive('SHORT', TRAILING);
    await px(SHORT_ACTIVATE);
    mx.manualClose('BTC_USDT', 2, '12', SHORT_ACTIVATE, { fee: '0.01', profit: '0.36' });
    await px(SHORT_TRIGGER);
    expect(closeCreates()).toHaveLength(0);
    await syncLiveAccount(direct.db, await userId(A), plus(clock.now, 5));
    expect(await posById(p.id)).toMatchObject({ status: 'CLOSED', closeReason: 'EXTERNAL_CLOSE' });
    expect(closeCreates()).toHaveLength(0);
  });

  it('partly closed manually on MEXC: the next close is capped at what MEXC still holds', async () => {
    const p = await openLive('SHORT', TRAILING);
    await px(SHORT_ACTIVATE);
    mx.manualClose('BTC_USDT', 2, '5', SHORT_ACTIVATE);
    await px(SHORT_TRIGGER);
    expect(closeCreates().map((c) => (c.body as Record<string, unknown>).vol)).toEqual(['7']);
    expect(D(mx.positions.get('BTC_USDT:2')!.holdVol).isZero()).toBe(true);
    expect(mx.positions.get('BTC_USDT:1')).toBeUndefined();
    void p;
  });
});

/** The exact close body the builder must send for this position (price = executable quote). */
const expectedClose = (side: 'LONG' | 'SHORT', vol: string, price: string, externalOid: string, positionId: number) => ({
  symbol: 'BTC_USDT',
  price,
  vol,
  side: side === 'LONG' ? 4 : 2,
  type: 5,
  openType: 1,
  externalOid,
  positionId,
  reduceOnly: true,
  positionMode: 2
});

describe('exact serialized close request: manual close and reversal, Long and Short', () => {
  for (const side of ['LONG', 'SHORT'] as const) {
    it(`manual close of a ${side}`, async () => {
      const p = await openLive(side);
      const mexcPos = mx.positions.get(`BTC_USDT:${side === 'LONG' ? 1 : 2}`)!;
      const r = await call(closeRoute.POST, { method: 'POST', path: '/x', cookie: cookies.a, params: { id: p.id }, headers: { 'idempotency-key': `manual-${side}` } });
      expect(r.status).toBe(202);
      await drain(clock.now, direct.db);
      const [close] = await closeIntents(p.id);
      const quote = (await direct.db.select().from(schema.marketQuotes).where(eq(schema.marketQuotes.instrumentId, BTC)).orderBy(schema.marketQuotes.asOf)).at(-1)!;
      const price = D(side === 'LONG' ? quote.bid : quote.ask).toFixed();
      expect(closeCreates().map((c) => c.body)).toEqual([expectedClose(side, D(p.contracts).toFixed(), price, close!.clientOrderId, mexcPos.positionId)]);
      expect(close).toMatchObject({ exitReason: 'MANUAL_CLOSE', state: 'FILLED' });
      expect(close!.venueRequest).toMatchObject({ method: 'POST', path: '/api/v1/private/order/create', body: closeCreates()[0]!.body });
    });

    it(`reversal of a ${side}: the exact close first, the opposite entry only after MEXC is flat`, async () => {
      const p = await openLive(side, {}, { reverse: true });
      const posType = side === 'LONG' ? 1 : 2;
      const mexcPos = mx.positions.get(`BTC_USDT:${posType}`)!;
      const next = new Date(BAR.getTime() + M15);
      clock.now = plus(new Date(next.getTime() + M15), 3);
      setTestClock(() => clock.now);
      const mid = side === 'LONG' ? '64900' : '65100';
      const { recordMarketTick } = await import('@trendpilot/db');
      await recordMarketTick(direct.db, { instrumentId: BTC, asOf: clock.now, bid: D(mid).minus('0.5').toFixed(), ask: D(mid).plus('0.5').toFixed(), mark: mid, last: mid });
      mx.price.BTC_USDT = mid;
      await drain(clock.now, direct.db);
      expect(await deliver(side === 'LONG' ? 'BEARISH_FLIP' : 'BULLISH_FLIP', next, mid)).toBe(202);
      await drain(clock.now, direct.db);
      const [close] = await closeIntents(p.id);
      expect(close).toMatchObject({ exitReason: 'REVERSAL_CLOSE', state: 'FILLED' });
      const price = D(side === 'LONG' ? D(mid).minus('0.5') : D(mid).plus('0.5')).toFixed();
      const creates = mx.creates().map((c) => c.body as Record<string, unknown>);
      expect(creates[0]).toEqual(expectedClose(side, D(p.contracts).toFixed(), price, close!.clientOrderId, mexcPos.positionId));
      // The opening leg (side 3 open short / 1 open long) comes only after the close, once MEXC holds none of the old side.
      expect(creates.slice(1).map((b) => b.side)).toEqual([side === 'LONG' ? 3 : 1]);
      expect(D(mexcPos.holdVol).isZero()).toBe(true);
    });
  }

  it('a reversal whose close MEXC rejects with 2001 opens nothing and does not resend on later prices', async () => {
    const p = await openLive('LONG', {}, { reverse: true });
    mx.faults.rejectClosesWith = 2001;
    const next = new Date(BAR.getTime() + M15);
    clock.now = plus(new Date(next.getTime() + M15), 3);
    setTestClock(() => clock.now);
    const { recordMarketTick } = await import('@trendpilot/db');
    await recordMarketTick(direct.db, { instrumentId: BTC, asOf: clock.now, bid: '64899.5', ask: '64900.5', mark: '64900', last: '64900' });
    await drain(clock.now, direct.db);
    expect(await deliver('BEARISH_FLIP', next, '64900')).toBe(202);
    await drain(clock.now, direct.db);
    for (let k = 0; k < 10; k++) await px(k % 2 ? '64900' : '64800', 5);
    expect(await closeIntents(p.id)).toEqual([expect.objectContaining({ exitReason: 'REVERSAL_CLOSE', state: 'REJECTED', stateReason: 'MEXC_2001' })]);
    expect(mx.creates().map((c) => (c.body as Record<string, unknown>).side)).toEqual([4]); // one close, no opening order
    expect(mx.positions.get('BTC_USDT:2')).toBeUndefined();
    expect(await posById(p.id)).toMatchObject({ status: 'OPEN', protectionStatus: 'PROTECTED' });
    expect((await posById(p.id)).exitHaltReason).toMatch(/^MEXC_2001 on REVERSAL_CLOSE/);
  });
});

describe('exact serialized close request: fixed take profit and close-on-signal, Long and Short', () => {
  for (const side of ['LONG', 'SHORT'] as const) {
    it(`fixed take profit of a ${side}: armed at the target, closed on the pullback with the exact body`, async () => {
      const p = await openLive(side, { takeProfit: { mode: 'FIXED', levels: [{ id: 'tp1', movePct: '0.5', closePct: '100' }] } });
      const mexcPos = mx.positions.get(`BTC_USDT:${side === 'LONG' ? 1 : 2}`)!;
      const [arm, pull] = side === 'LONG' ? ['65500', '65300'] : ['64500', '64700'];
      await px(arm); // reaching the target arms it; nothing is sent
      expect(closeCreates()).toHaveLength(0);
      await px(pull);
      const [close] = await closeIntents(p.id);
      expect(close).toMatchObject({ exitReason: 'TAKE_PROFIT', state: 'FILLED' });
      const price = side === 'LONG' ? D(pull).minus('0.5').toFixed() : D(pull).plus('0.5').toFixed();
      expect(closeCreates().map((c) => c.body)).toEqual([expectedClose(side, D(p.contracts).toFixed(), price, close!.clientOrderId, mexcPos.positionId)]);
      expect((close!.venueRequest as { context: unknown }).context).toEqual({
        positionModeRaw: 2,
        accountMode: 'ONE_WAY',
        position: { positionId: String(mexcPos.positionId), positionType: side === 'LONG' ? 1 : 2, openType: 1, holdVol: D(p.contracts).toFixed(), frozenVol: '0' },
        requestedContracts: D(p.contracts).toFixed()
      });
    });

    it(`close-on-signal of a ${side} (CLOSE_ONLY): the exact body, and no opposite entry`, async () => {
      const p = await openLive(side, {}, { closeOnly: true });
      const mexcPos = mx.positions.get(`BTC_USDT:${side === 'LONG' ? 1 : 2}`)!;
      const next = new Date(BAR.getTime() + M15);
      clock.now = plus(new Date(next.getTime() + M15), 3);
      setTestClock(() => clock.now);
      const mid = side === 'LONG' ? '64900' : '65100';
      const { recordMarketTick } = await import('@trendpilot/db');
      await recordMarketTick(direct.db, { instrumentId: BTC, asOf: clock.now, bid: D(mid).minus('0.5').toFixed(), ask: D(mid).plus('0.5').toFixed(), mark: mid, last: mid });
      mx.price.BTC_USDT = mid;
      await drain(clock.now, direct.db);
      expect(await deliver(side === 'LONG' ? 'BEARISH_FLIP' : 'BULLISH_FLIP', next, mid)).toBe(202);
      await drain(clock.now, direct.db);
      const [close] = await closeIntents(p.id);
      expect(close).toMatchObject({ exitReason: 'OPPOSITE_SIGNAL_CLOSE', state: 'FILLED' });
      const price = side === 'LONG' ? D(mid).minus('0.5').toFixed() : D(mid).plus('0.5').toFixed();
      expect(mx.creates().map((c) => c.body)).toEqual([expectedClose(side, D(p.contracts).toFixed(), price, close!.clientOrderId, mexcPos.positionId)]);
    });
  }

  it('already flat at MEXC (Long closed on the website): a manual close sends nothing; the sync closes it', async () => {
    const p = await openLive('LONG');
    mx.manualClose('BTC_USDT', 1, D(p.contracts).toFixed(), '65000', { fee: '0.01', profit: '0' });
    const r = await call(closeRoute.POST, { method: 'POST', path: '/x', cookie: cookies.a, params: { id: p.id }, headers: { 'idempotency-key': 'flat-long' } });
    expect(r.status).toBe(202);
    await drain(clock.now, direct.db);
    expect(closeCreates()).toHaveLength(0);
    expect((await closeIntents(p.id))[0]).toMatchObject({ state: 'REJECTED', stateReason: 'REDUCE_ONLY_NO_POSITION' });
    expect((await posById(p.id)).exitHaltedAt).toBeNull(); // not deterministic: exchange state decides
    await syncLiveAccount(direct.db, await userId(A), plus(clock.now, 5));
    expect(await posById(p.id)).toMatchObject({ status: 'CLOSED', closeReason: 'EXTERNAL_CLOSE' });
  });

  it('volume frozen by other MEXC orders: the full close is capped at holdVol − frozenVol; the stop covers the remainder', async () => {
    const p = await openLive('SHORT');
    mx.positions.get('BTC_USDT:2')!.frozenVol = '4';
    const r = await call(closeRoute.POST, { method: 'POST', path: '/x', cookie: cookies.a, params: { id: p.id }, headers: { 'idempotency-key': 'frozen-volume' } });
    expect(r.status).toBe(202);
    await drain(clock.now, direct.db);
    expect(closeCreates().map((c) => (c.body as Record<string, unknown>).vol)).toEqual(['8']);
    const after = await posById(p.id);
    expect(D(after.contracts).toFixed()).toBe('4');
    expect(after).toMatchObject({ status: 'OPEN', protectionStatus: 'PROTECTED' });
    expect(D(after.stopContracts!).toFixed()).toBe('4');
  });

  it('every contract frozen: nothing is sent and automatic exits pause with an actionable reason', async () => {
    const p = await openLive('SHORT', TRAILING);
    mx.positions.get('BTC_USDT:2')!.frozenVol = '12';
    await px(SHORT_ACTIVATE);
    await px(SHORT_TRIGGER);
    for (let k = 0; k < 5; k++) await px(SHORT_TRIGGER, 5);
    expect(closeCreates()).toHaveLength(0);
    expect(await closeIntents(p.id)).toEqual([expect.objectContaining({ state: 'REJECTED', stateReason: 'CLOSE_QTY_RESERVED' })]);
    expect((await posById(p.id)).exitHaltReason).toMatch(/^CLOSE_QTY_RESERVED/);
  });
});
