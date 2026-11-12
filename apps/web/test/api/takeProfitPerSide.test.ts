// Per-side Take Profit (Paper): independent Long and Short configurations on the same token, the
// side of the confirmed entry selects one and saves it with the position, targets from the
// confirmed average entry (above for a Long, below for a Short), arm-then-pullback for every
// target, Take Profit on the quantity left after Trailing Take Profit's allocation, a reversal
// switching plans, and existing settings / open positions keeping what they had.
import { and, eq } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { schema } from '@trendpilot/db';
import * as block from '@/app/v1/me/order-blocks/[id]/route';
import * as blocks from '@/app/v1/me/order-blocks/route';
import * as preview from '@/app/v1/me/order-blocks/preview/route';
import * as trade from '@/app/v1/me/trades/[id]/route';
import * as holdings from '@/app/v1/me/holdings/route';
import { setTestClock } from '@/server/clock';
import { BTC, blockBody, call, direct, teardown, USERS } from '../helpers';
import { ALL_DAYS, clock, cookies, D, deliver, drain, M15, n, openFromAlert, openPositionOf, plus, positionsOf, publishVersion, reconciled, stopOf, targetsOf, tick, work } from '../paperReplay';

const A = USERS.investorA.email;
const BAR = new Date('2026-11-08T09:15:00Z');
const NEXT = new Date(BAR.getTime() + M15);
const reverseVersion = () => publishVersion({ oppositePolicy: 'CLOSE_AND_REVERSE' });

// Long: one fixed target at +2 %. Short: split at −1 % (50 %) and −2 % (50 %).
// Trailing Take Profit takes 40 % (activation far away, so only the targets act here).
const LONG_FIXED = { mode: 'FIXED', levels: [{ id: 'L1', movePct: '2', closePct: '100' }] };
const SHORT_SPLIT = { mode: 'SPLIT', levels: [{ id: 'S1', movePct: '1', closePct: '50' }, { id: 'S2', movePct: '2', closePct: '50' }] };
const TRAILING_40 = { enabled: true, activationPct: '10', distancePct: '1', closePct: '40', basis: 'MARK' };
const perSide = { takeProfit: undefined, takeProfitLong: LONG_FIXED, takeProfitShort: SHORT_SPLIT, trailing: TRAILING_40 };

afterAll(async () => {
  setTestClock(null);
  await teardown();
});

const snapshotOf = (p: { settingsSnapshot: unknown }) => p.settingsSnapshot as { takeProfitSide?: string; block: { takeProfit: { mode: string; levels: { id: string }[] } } };

describe('Long and Short Take Profit on the same token', () => {
  it('a Long entry uses the Long plan: one target above entry for the 60 % left after Trailing Take Profit', async () => {
    await openFromAlert({ version: reverseVersion, a: perSide, b: null });
    const long = (await openPositionOf(A))!;
    expect(long.side).toBe('LONG');
    expect(snapshotOf(long)).toMatchObject({ takeProfitSide: 'LONG', block: { takeProfit: { mode: 'FIXED', levels: [{ id: 'L1' }] } } });
    const [t] = await targetsOf(long.id);
    // Target from the confirmed average entry, above it for a Long.
    expect(D(t!.triggerPrice).gt(long.avgEntryPrice)).toBe(true);
    expect(D(t!.triggerPrice).toFixed(1)).toBe(D(long.avgEntryPrice).times('1.02').toDecimalPlaces(1, 1).toFixed(1));
    expect(t!.triggerRule).toBe('ARM_PULLBACK');
    // 40 % to Trailing Take Profit (rounded down to the step), Take Profit the exact rest (60 %).
    const trailing = D(long.initialContracts).times('0.4').floor();
    expect(n(long.trailingPlannedContracts)).toBe(trailing.toFixed());
    expect(n(t!.plannedContracts)).toBe(D(long.initialContracts).minus(trailing).toFixed());
    expect(long.protectionStatus).toBe('PROTECTED');
    expect(n(long.stopContracts)).toBe(n(long.contracts));
  });

  it('after a reversal the Short uses the Short plan: two targets below entry dividing the 60 %', async () => {
    const longId = (await openPositionOf(A))!.id;
    clock.now = plus(new Date(NEXT.getTime() + M15), 3);
    await tick('64900', { at: clock.now });
    expect((await work()).tick).toBeTruthy();
    expect(await deliver('BEARISH_FLIP', NEXT)).toBe(202);
    await drain();
    const [oldLong, short] = await positionsOf(A);
    expect(oldLong).toMatchObject({ id: longId, status: 'CLOSED', closeReason: 'REVERSAL_CLOSE' });
    expect(short).toMatchObject({ side: 'SHORT', status: 'OPEN', protectionStatus: 'PROTECTED' });
    expect(snapshotOf(short!)).toMatchObject({ takeProfitSide: 'SHORT', block: { takeProfit: { mode: 'SPLIT' } } });
    const ts = await targetsOf(short!.id);
    expect(ts.map((t) => t.levelId)).toEqual(['S1', 'S2']);
    for (const t of ts) expect(D(t.triggerPrice).lt(short!.avgEntryPrice)).toBe(true); // below entry for a Short
    expect(D(ts[0]!.triggerPrice).gt(ts[1]!.triggerPrice)).toBe(true);
    const trailing = D(short!.initialContracts).times('0.4').floor();
    const tpShare = D(short!.initialContracts).minus(trailing);
    // Split shares are of the 60 % Take Profit share; the last target gets the exact remainder.
    expect(n(ts[0]!.plannedContracts)).toBe(tpShare.times('0.5').floor().toFixed());
    expect(D(ts[0]!.plannedContracts).plus(ts[1]!.plannedContracts).toFixed()).toBe(tpShare.toFixed());
    expect(await reconciled()).toBe(true);
  });

  it('a Short target arms on the favourable touch (below) and closes only on the rebound back up through it', async () => {
    const short = (await openPositionOf(A))!;
    const [s1] = await targetsOf(short.id);
    const below = D(s1!.triggerPrice).minus(20).toFixed();
    const above = D(s1!.triggerPrice).plus(5).toFixed();
    await tick(below);
    let r = await drain();
    expect(r.find((x) => x.tick)?.tick).toMatchObject({ targetsArmed: 1, takeProfitsRequested: 0 });
    expect((await targetsOf(short.id))[0]!.armedAt).not.toBeNull();
    expect(n((await openPositionOf(A))!.contracts)).toBe(n(short.contracts)); // arming closes nothing
    await tick(above); // rebound back up through the target → market close of S1's quantity
    r = await drain();
    expect(r.find((x) => x.tick)?.tick).toMatchObject({ takeProfitsRequested: 1 });
    const after = (await openPositionOf(A))!;
    const [d1, d2] = await targetsOf(short.id);
    expect(d1).toMatchObject({ status: 'DONE' });
    expect(n(d1!.filledContracts)).toBe(n(d1!.plannedContracts));
    expect(d2!.status).toBe('PENDING');
    expect(D(after.contracts).toFixed()).toBe(D(short.contracts).minus(d1!.plannedContracts).toFixed());
    // The stop still covers exactly the remainder.
    expect(after.protectionStatus).toBe('PROTECTED');
    expect(n((await stopOf(after)).contracts)).toBe(n(after.contracts));
    expect(await reconciled()).toBe(true);
  });

  it('My Holdings and the trade detail show the plan of the position side with its targets', async () => {
    const short = (await openPositionOf(A))!;
    const h = await call(holdings.GET, { path: '/x', cookie: cookies.a });
    const row = h.body.positions.find((p: { id: string }) => p.id === short.id);
    expect(row.takeProfitPlan).toEqual({ side: 'SHORT', mode: 'SPLIT' });
    expect(row.targets.map((t: { levelId: string }) => t.levelId)).toEqual(['S1', 'S2']);
    const d = await call(trade.GET, { path: '/x', cookie: cookies.a, params: { id: short.id } });
    expect(d.body.takeProfitPlan).toEqual({ side: 'SHORT', mode: 'SPLIT' });
    const old = (await positionsOf(A))[0]!;
    expect((await call(trade.GET, { path: '/x', cookie: cookies.a, params: { id: old.id } })).body.takeProfitPlan).toEqual({ side: 'LONG', mode: 'FIXED' });
  });

  it('editing the settings later does not change the open position’s saved plan', async () => {
    const short = (await openPositionOf(A))!;
    const before = await targetsOf(short.id);
    const [b] = await direct.db.select().from(schema.orderBlocks).where(eq(schema.orderBlocks.ownerId, short.ownerId));
    const r = await call(block.PATCH, { method: 'PATCH', path: '/x', cookie: cookies.a, params: { id: b!.id }, ifMatch: b!.revision, body: { takeProfitShort: { mode: 'OFF', levels: [] } } });
    expect(r.status).toBe(200);
    expect(r.body.takeProfitShort).toEqual({ mode: 'OFF', levels: [] });
    expect(r.body.takeProfitLong).toEqual(LONG_FIXED);
    const after = (await openPositionOf(A))!;
    expect(snapshotOf(after).block.takeProfit.mode).toBe('SPLIT');
    expect((await targetsOf(short.id)).map((t) => [t.levelId, n(t.triggerPrice), n(t.plannedContracts)])).toEqual(before.map((t) => [t.levelId, n(t.triggerPrice), n(t.plannedContracts)]));
  });
});

describe('Off on one side', () => {
  it('Long Off / Short Fixed: a Long gets no target (Trailing Take Profit keeps its 40 %, the rest stays under the stop)', async () => {
    await openFromAlert({
      a: { takeProfitLong: { mode: 'OFF', levels: [] }, takeProfitShort: { mode: 'FIXED', levels: [{ id: 'S', movePct: '1.5', closePct: '100' }] }, trailing: TRAILING_40 },
      b: null
    });
    const long = (await openPositionOf(A))!;
    expect(await targetsOf(long.id)).toEqual([]);
    expect(snapshotOf(long)).toMatchObject({ takeProfitSide: 'LONG', block: { takeProfit: { mode: 'OFF' } } });
    expect(n(long.trailingPlannedContracts)).toBe(D(long.initialContracts).times('0.4').floor().toFixed());
  });
});

describe('Settings records', () => {
  it('a client sending one shared takeProfit sets both sides (existing integrations keep working)', async () => {
    await openFromAlert({ a: null, b: null });
    const r = await call(blocks.POST, { method: 'POST', path: '/x', cookie: cookies.a, body: blockBody({ weekdays: ALL_DAYS }) });
    expect(r.status).toBe(201);
    expect(r.body.takeProfitLong).toEqual({ mode: 'FIXED', levels: [{ id: 'tp1', movePct: '3', closePct: '100' }] });
    expect(r.body.takeProfitShort).toEqual(r.body.takeProfitLong);
    expect(r.body.takeProfit).toBeUndefined();
  });

  it('changing the permitted direction keeps both saved configurations; only enabled sides are validated', async () => {
    const [b] = await direct.db.select().from(schema.orderBlocks).where(and(eq(schema.orderBlocks.instrumentId, BTC)));
    // Short Split, then Long only: the Short configuration is kept (and still validated while unused).
    let r = await call(block.PATCH, { method: 'PATCH', path: '/x', cookie: cookies.a, params: { id: b!.id }, ifMatch: b!.revision, body: { takeProfitShort: SHORT_SPLIT } });
    expect(r.status).toBe(200);
    r = await call(block.PATCH, { method: 'PATCH', path: '/x', cookie: cookies.a, params: { id: b!.id }, ifMatch: r.body.revision, body: { direction: 'LONG_ONLY' } });
    expect(r.status).toBe(200);
    expect(r.body.takeProfitShort).toEqual(SHORT_SPLIT);
    r = await call(block.PATCH, { method: 'PATCH', path: '/x', cookie: cookies.a, params: { id: b!.id }, ifMatch: r.body.revision, body: { direction: 'BOTH' } });
    expect(r.body).toMatchObject({ takeProfitLong: { mode: 'FIXED' }, takeProfitShort: SHORT_SPLIT });
    // An invalid Short split is reported under its own path, inline.
    const bad = await call(block.PATCH, {
      method: 'PATCH',
      path: '/x',
      cookie: cookies.a,
      params: { id: b!.id },
      ifMatch: r.body.revision,
      body: { takeProfitShort: { mode: 'SPLIT', levels: [{ id: 'a', movePct: '1', closePct: '50' }, { id: 'b', movePct: '2', closePct: '30' }] } }
    });
    expect(bad.status).toBe(400);
    expect(bad.body.issues.map((i: { path: string }) => i.path)).toContain('takeProfitShort');
  });

  it('the order preview shows each side with its own targets (Long above, Short below entry)', async () => {
    const r = await call(preview.POST, {
      method: 'POST',
      path: '/x',
      cookie: cookies.a,
      body: { ...blockBody({ weekdays: ALL_DAYS }), takeProfit: undefined, takeProfitLong: LONG_FIXED, takeProfitShort: SHORT_SPLIT, trailing: TRAILING_40 }
    });
    expect(r.status).toBe(200);
    const long = r.body.sides.find((s: { side: string }) => s.side === 'LONG');
    const short = r.body.sides.find((s: { side: string }) => s.side === 'SHORT');
    expect(long).toMatchObject({ takeProfitMode: 'FIXED', takeProfitManagesPct: '60' });
    expect(long.takeProfits).toHaveLength(1);
    expect(D(long.takeProfits[0].price).gt(long.entryPrice)).toBe(true);
    expect(short).toMatchObject({ takeProfitMode: 'SPLIT', takeProfitManagesPct: '60' });
    expect(short.takeProfits.map((t: { id: string }) => t.id)).toEqual(['S1', 'S2']);
    for (const t of short.takeProfits) expect(D(t.price).lt(short.entryPrice)).toBe(true);
    const sum = short.takeProfits.reduce((s: ReturnType<typeof D>, t: { contracts: string }) => s.plus(t.contracts), D(0));
    expect(sum.plus(short.trailing.contracts).toFixed()).toBe(D(short.contracts).toFixed());
  });
});

describe('Existing Paper pair: Long Fixed 0.6 % and Short Fixed 0.4 %', () => {
  const LONG_06 = { mode: 'FIXED', levels: [{ id: 'L06', movePct: '0.6', closePct: '100' }] };
  const SHORT_04 = { mode: 'FIXED', levels: [{ id: 'S04', movePct: '0.4', closePct: '100' }] };
  /** trigger / entry, to 6 places. */
  const ratio = (trigger: string, entry: string) => D(trigger).div(entry).toDecimalPlaces(6).toNumber();

  it('saves both sides independently, keeps the open position on its opening plan, and each new entry uses its own side', async () => {
    // An existing pair (one shared 3 % target, as before per-side Take Profit) with an open Long.
    const { a } = await openFromAlert({ version: reverseVersion });
    const existing = (await openPositionOf(A))!;
    expect(existing.side).toBe('LONG');
    const existingTargets = await targetsOf(existing.id);
    expect(existingTargets.map((t) => t.levelId)).toEqual(['tp1']);

    // Save Long 0.6 % / Short 0.4 %, then reload the block: both persist on their own.
    const saved = await call(block.PATCH, { method: 'PATCH', path: '/x', cookie: cookies.a, params: { id: a.id }, ifMatch: a.revision, body: { takeProfitLong: LONG_06, takeProfitShort: SHORT_04 } });
    expect(saved.status).toBe(200);
    const reread = await call(block.GET, { path: '/x', cookie: cookies.a, params: { id: a.id } });
    expect(reread.body).toMatchObject({ takeProfitLong: LONG_06, takeProfitShort: SHORT_04 });

    // The already-open Long keeps the plan saved when it opened.
    expect(snapshotOf((await openPositionOf(A))!).block.takeProfit.levels.map((l) => l.id)).toEqual(['tp1']);
    expect((await targetsOf(existing.id)).map((t) => [t.levelId, n(t.triggerPrice)])).toEqual(existingTargets.map((t) => [t.levelId, n(t.triggerPrice)]));

    // Short entry (reversal): one target 0.4 % below entry.
    clock.now = plus(new Date(NEXT.getTime() + M15), 3);
    await tick('64900', { at: clock.now });
    await work();
    expect(await deliver('BEARISH_FLIP', NEXT)).toBe(202);
    await drain();
    const short = (await openPositionOf(A))!;
    expect(short.side).toBe('SHORT');
    expect(snapshotOf(short)).toMatchObject({ takeProfitSide: 'SHORT', block: { takeProfit: SHORT_04 } });
    const [st] = await targetsOf(short.id);
    expect(st!.levelId).toBe('S04');
    expect(ratio(st!.triggerPrice, short.avgEntryPrice)).toBeCloseTo(0.996, 5);

    // Long entry (reversal back): one target 0.6 % above entry.
    const BAR3 = new Date(NEXT.getTime() + M15);
    clock.now = plus(new Date(BAR3.getTime() + M15), 3);
    await tick('64950', { at: clock.now });
    await work();
    expect(await deliver('BULLISH_FLIP', BAR3)).toBe(202);
    await drain();
    const long = (await openPositionOf(A))!;
    expect(long.side).toBe('LONG');
    expect(long.id).not.toBe(existing.id);
    expect(snapshotOf(long)).toMatchObject({ takeProfitSide: 'LONG', block: { takeProfit: LONG_06 } });
    const [lt] = await targetsOf(long.id);
    expect(lt!.levelId).toBe('L06');
    expect(ratio(lt!.triggerPrice, long.avgEntryPrice)).toBeCloseTo(1.006, 5);

    // The first Long's record still shows its opening plan.
    const first = (await positionsOf(A)).find((p) => p.id === existing.id)!;
    expect(snapshotOf(first).block.takeProfit.levels.map((l) => l.id)).toEqual(['tp1']);
    expect(await reconciled()).toBe(true);
  });
});
