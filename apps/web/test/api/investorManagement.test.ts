// Investor Management revision (26 Nov 2026), through the normal entry points (investor and admin
// API routes, the alert → entry → market tick → close worker flow) against the paper simulator and
// mocked exchanges. No real exchange call.
//   1. A Shaheen-like investor (Bitunix connection only, Live-only Bitunix pair) can configure and
//      save a Live order block; two investors keep separate connections and settings.
//   2. Long and Short Trailing Take Profit are independent.
//   3/4. Partial trailing exits 1-100 %: 10 units closing 40 % leaves 6 protected units (stop resized
//      at the same price), rearm only after a new best beyond the cycle extreme, partial fills and
//      duplicate ticks complete the persisted quantity, invalid quantities are reported, 100 % closes.
//   5. Five split levels; legacy one-to-three-level plans stay valid.
//   6. Admin → Common Exit Definition: sync, inheritance, opt-out restoration, future-entry
//      snapshots, notifications, audit, and explicit application to existing positions.
import { and, desc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { installBitunixTestSeam, installLiveTestSeam, schema } from '@trendpilot/db';
import * as blocks from '@/app/v1/me/order-blocks/route';
import * as blockById from '@/app/v1/me/order-blocks/[id]/route';
import * as conn from '@/app/v1/me/exchange-connection/route';
import * as bitunixInstrument from '@/app/v1/admin/instruments/bitunix/route';
import * as commonExit from '@/app/v1/admin/common-exit-definition/route';
import * as commonExitPreview from '@/app/v1/admin/common-exit-definition/preview/route';
import * as notifications from '@/app/v1/me/notifications/route';
import * as trade from '@/app/v1/me/trades/[id]/route';
import { setTestClock } from '@/server/clock';
import { BTC, blockBody, call, direct, teardown, userId, USERS, VERSION } from '../helpers';
import { MockBitunixExchange } from '../bitunixOrderMock';
import { MockMexc } from '../mexcMock';
import { clock, cookies, D, drain, exitsOf, n, openFromAlert, openPositionOf, publishVersion, stopOf, targetsOf, tick } from '../paperReplay';

const A = USERS.investorA.email;
const OFF = { enabled: false, activationPct: null, distancePct: null, closePct: null, targetClose: null, basis: 'MARK' };
const TP_OFF = { mode: 'OFF', levels: [] };
/** 6.6 USDT × 10 at 65000 = 10.15 → 10 BTC contracts (step 1, multiplier 0.0001). */
const TEN = { orderCostUsdt: '6.6', leverage: 10 };
const exitPlan = (o: Record<string, unknown>) => ({ takeProfit: undefined, trailing: undefined, takeProfitLong: TP_OFF, takeProfitShort: TP_OFF, trailingLong: OFF, trailingShort: OFF, ...o });
const body = (o: Record<string, unknown>) => {
  const b = blockBody(o) as Record<string, unknown>;
  // Per-side payload: drop the legacy shared fields the helper adds.
  if ('trailingLong' in o || 'trailingShort' in o) delete b.trailing;
  if ('takeProfitLong' in o || 'takeProfitShort' in o) delete b.takeProfit;
  for (const k of Object.keys(b)) if (b[k] === undefined) delete b[k];
  return b;
};
const ticks = async (prices: string[]) => {
  const out = [];
  for (const p of prices) {
    await tick(p);
    out.push((await drain()).find((x) => x.tick)!.tick!);
  }
  return out;
};
const posRow = async (id: string) => (await direct.db.select().from(schema.positions).where(eq(schema.positions.id, id)))[0]!;
const closeIntents = (positionId: string) => direct.db.select().from(schema.orderIntents).where(and(eq(schema.orderIntents.positionId, positionId), eq(schema.orderIntents.kind, 'CLOSE'))).orderBy(schema.orderIntents.createdAt);

afterAll(async () => {
  installLiveTestSeam(null);
  installBitunixTestSeam(null);
  setTestClock(null);
  await teardown();
});

describe('3/4. Partial Trailing Take Profit: 10 units closing 40 % leaves 6 protected units', () => {
  let pid: string;
  it('opens 10 contracts with the Long trailing settings saved on the position', async () => {
    await openFromAlert({ a: { ...exitPlan({ trailingLong: { enabled: true, activationPct: '1', distancePct: '0.5', closePct: '40', targetClose: null, basis: 'MARK' }, trailingShort: { enabled: true, activationPct: '2', distancePct: '1', closePct: '100', targetClose: null, basis: 'LAST' } }), ...TEN }, b: null });
    const p = (await openPositionOf(A))!;
    pid = p.id;
    expect([p.side, n(p.contracts), p.trailingStatus, n(p.trailingClosePct), n(p.trailingDistancePct), p.trailingBasis]).toEqual(['LONG', '10', 'WAITING', '40', '0.5', 'MARK']);
    expect([n(p.avgEntryPrice), n(p.trailingActivationPrice)]).toEqual(['65000.5', '65650.6']); // 65000.5 × 1.01, rounded away from entry
    expect((p.settingsSnapshot as { exitRules: string }).exitRules).toBe('V3');
  });

  it('activates, then the 0.5 % retracement closes exactly 4; the stop stays at its price and is resized to the 6 left', async () => {
    const before = await posRow(pid);
    const stopBefore = await stopOf(before);
    await ticks(['65700', '66000']);
    const [t] = await ticks(['65670']); // 66000 × 0.995
    expect(t).toMatchObject({ trailingTakeProfitsRequested: 1 });
    const p = await posRow(pid);
    const exits = await exitsOf(pid);
    expect(exits.map((e) => [e.reason, n(e.contracts), n(e.remainingContracts)])).toEqual([['TRAILING_TAKE_PROFIT', '4', '6']]);
    const stop = await stopOf(p);
    expect([n(p.contracts), p.status, p.protectionStatus, n(p.stopContracts)]).toEqual(['6', 'OPEN', 'PROTECTED', '6']);
    expect([stop.status, n(stop.contracts), n(stop.triggerPrice)]).toEqual(['ACTIVE', '6', n(stopBefore.triggerPrice)]);
    expect(n(p.stopPrice)).toBe(n(before.stopPrice)); // never moved to break-even
    expect([p.trailingStatus, p.trailingCycle, n(p.trailingCycleExtreme), p.trailingCycleContracts]).toEqual(['REARM', 1, '66000', null]);
  });

  it('the same cycle never fires again: lower prices, repeated ticks and the old extreme do nothing', async () => {
    const t = await ticks(['65600', '65600', '65650', '66000']);
    expect(t.every((x) => x.trailingTakeProfitsRequested === 0)).toBe(true);
    expect(await exitsOf(pid)).toHaveLength(1);
    expect((await posRow(pid)).trailingStatus).toBe('REARM');
  });

  it('a new high beyond 66000 starts a fresh cycle from it; its retracement closes 40 % of the 6 left (2)', async () => {
    await ticks(['66200']);
    let p = await posRow(pid);
    expect([p.trailingStatus, n(p.trailingWatermark), n(p.trailingStopPrice)]).toEqual(['ACTIVE', '66200', '65869']);
    await ticks(['65869']);
    p = await posRow(pid);
    expect((await exitsOf(pid)).map((e) => n(e.contracts))).toEqual(['4', '2']);
    expect([n(p.contracts), p.trailingCycle, p.trailingStatus, n((await stopOf(p)).contracts), p.protectionStatus]).toEqual(['4', 2, 'REARM', '4', 'PROTECTED']);
  });

  it('the trade detail shows the cycle state and the exit plan in use', async () => {
    const d = (await call(trade.GET, { path: '/x', cookie: cookies.a, params: { id: pid } })).body;
    expect(d.trailing.partial).toMatchObject({ closePct: '40', cycles: 2, cycleExtreme: '66200', pendingContracts: null });
    expect(d.exitPlan).toEqual({ source: 'CUSTOM', adminVersion: null, appliedAt: null });
  });
});

describe('3. A partial fill completes the persisted quantity; a duplicate trigger never adds a second close', () => {
  it('the trigger fixes 4 before submission; a 2-contract fill leaves 2 pending, completed on the next price without recalculating', async () => {
    await openFromAlert({ a: { ...exitPlan({ trailingLong: { enabled: true, activationPct: '1', distancePct: '0.5', closePct: '40', targetClose: null, basis: 'MARK' } }), ...TEN }, b: null });
    const p0 = (await openPositionOf(A))!;
    await ticks(['65700', '66000']);
    // Only 2 contracts of liquidity at the trigger price: the 4-contract close fills 2.
    await tick('65670', { liquidity: '2' });
    await drain();
    let p = await posRow(p0.id);
    expect([n(p.contracts), n(p.trailingCycleContracts), n(p.trailingCycleFilled), p.trailingStatus]).toEqual(['8', '4', '2', 'ACTIVE']);
    // Next price (even back above the level): completes the remaining 2 of the SAME trigger (40 % of 8 would be 3).
    await ticks(['65900']);
    p = await posRow(p0.id);
    expect((await exitsOf(p0.id)).map((e) => n(e.contracts))).toEqual(['2', '2']);
    expect([n(p.contracts), p.trailingCycle, p.trailingStatus, n((await stopOf(p)).contracts)]).toEqual(['6', 1, 'REARM', '6']);
    expect((await closeIntents(p0.id)).map((i) => [i.state, n(i.contracts)])).toEqual([
      ['EXPIRED', '4'],
      ['FILLED', '2']
    ]);
  });

  it('a worker restart between the trigger and the close (state persisted) and repeated ticks do not double-close', async () => {
    await openFromAlert({ a: { ...exitPlan({ trailingLong: { enabled: true, activationPct: '1', distancePct: '0.5', closePct: '40', targetClose: null, basis: 'MARK' } }), ...TEN }, b: null });
    const p0 = (await openPositionOf(A))!;
    await ticks(['65700', '66000']);
    await tick('65670');
    await tick('65660');
    await tick('65650');
    await drain();
    expect((await exitsOf(p0.id)).map((e) => n(e.contracts))).toEqual(['4']);
    expect(n((await posRow(p0.id)).contracts)).toBe('6');
  });
});

describe('3. Rounding, invalid quantities and 100 %', () => {
  it('40 % of a 1-contract pool rounds to 0: reported on the position, nothing sent, the cycle is recorded once', async () => {
    await openFromAlert({ a: { ...exitPlan({ trailingLong: { enabled: true, activationPct: '1', distancePct: '0.5', closePct: '40', targetClose: null, basis: 'MARK' } }), orderCostUsdt: '1', leverage: 10 }, b: null });
    const p0 = (await openPositionOf(A))!;
    expect(n(p0.contracts)).toBe('1');
    await ticks(['65700', '66000', '65670', '65600']);
    const p = await posRow(p0.id);
    expect(await exitsOf(p0.id)).toHaveLength(0);
    expect(await closeIntents(p0.id)).toHaveLength(0);
    expect([p.status, n(p.contracts), p.trailingStatus, p.trailingCycle]).toEqual(['OPEN', '1', 'REARM', 1]);
    expect(p.exitNotice).toMatch(/closed nothing: 40% of 1 is 0: The share rounds down to less than one contract step/);
    const d = (await call(trade.GET, { path: '/x', cookie: cookies.a, params: { id: p0.id } })).body;
    expect(d.exitNotice.text).toMatch(/closed nothing/);
  });

  it('100 % closes the whole remaining leg through the close path and the position closes', async () => {
    await openFromAlert({ a: { ...exitPlan({ trailingLong: { enabled: true, activationPct: '1', distancePct: '0.5', closePct: '100', targetClose: null, basis: 'MARK' } }), ...TEN }, b: null });
    const p0 = (await openPositionOf(A))!;
    await ticks(['65700', '66000', '65670']);
    const p = await posRow(p0.id);
    expect((await exitsOf(p0.id)).map((e) => [e.reason, n(e.contracts), n(e.remainingContracts)])).toEqual([['TRAILING_TAKE_PROFIT', '10', '0']]);
    expect([p.status, p.trailingStatus]).toEqual(['CLOSED', 'DONE']);
  });

  it('target close inside trailing fires once at its price for its share of the pool; trailing keeps running on the rest', async () => {
    await openFromAlert({ a: { ...exitPlan({ trailingLong: { enabled: true, activationPct: '2', distancePct: '0.5', closePct: '100', targetClose: { enabled: true, movePct: '1', closePct: '30' }, basis: 'MARK' } }), ...TEN }, b: null });
    const p0 = (await openPositionOf(A))!;
    expect([n(p0.trailingTargetPrice), p0.trailingTargetStatus]).toEqual(['65650.5', 'PENDING']); // toward entry
    await ticks(['65651']);
    let p = await posRow(p0.id);
    expect((await exitsOf(p0.id)).map((e) => n(e.contracts))).toEqual(['3']);
    expect([n(p.contracts), p.trailingTargetStatus, p.trailingStatus, n((await stopOf(p)).contracts)]).toEqual(['7', 'DONE', 'WAITING', '7']);
    // Back down through the target and up again: never fires again.
    await ticks(['65500', '65660']);
    expect(await exitsOf(p0.id)).toHaveLength(1);
    // Trailing (activation +2 %) then closes 100 % of the 7 left.
    await ticks(['66400', '66600', '66267']); // activation 66300.6
    p = await posRow(p0.id);
    expect((await exitsOf(p0.id)).map((e) => n(e.contracts))).toEqual(['3', '7']);
    expect(p.status).toBe('CLOSED');
  });
});

describe('2. Long and Short Trailing Take Profit are independent', () => {
  it('a Short entry uses the Short trailing settings (activation, retracement, close share, basis)', async () => {
    await openFromAlert({
      side: 'SHORT',
      a: {
        ...exitPlan({
          trailingLong: { enabled: true, activationPct: '1', distancePct: '0.5', closePct: '40', targetClose: null, basis: 'MARK' },
          trailingShort: { enabled: true, activationPct: '2', distancePct: '1', closePct: '75', targetClose: { enabled: true, movePct: '3', closePct: '20' }, basis: 'LAST' }
        }),
        ...TEN
      },
      b: null
    });
    const p = (await openPositionOf(A))!;
    expect([p.side, n(p.trailingClosePct), n(p.trailingDistancePct), p.trailingBasis, n(p.trailingTargetClosePct)]).toEqual(['SHORT', '75', '1', 'LAST', '20']);
    const snap = p.settingsSnapshot as { block: { trailingSide: { closePct: string } } };
    expect(snap.block.trailingSide.closePct).toBe('75');
  });

  it('the block keeps both sides; the DTO exposes them separately', async () => {
    const list = (await call(blocks.GET, { path: '/x', cookie: cookies.a })).body.items;
    expect(list[0].trailingLong.closePct).toBe('40');
    expect(list[0].trailingShort.closePct).toBe('75');
    expect(list[0]).not.toHaveProperty('trailing');
  });
});

describe('5. Five split take-profit levels with stable identities; legacy plans', () => {
  const five = { mode: 'SPLIT', allocationPct: '100', levels: [1, 2, 3, 4, 5].map((i) => ({ id: `lv${i}`, movePct: String(i * 0.5), closePct: '20' })) };
  it('five levels are saved and planned per position (allocation from the confirmed opening quantity)', async () => {
    await openFromAlert({ a: { ...exitPlan({ takeProfitLong: five }), orderCostUsdt: '33', leverage: 10 }, b: null });
    const p = (await openPositionOf(A))!;
    const t = await targetsOf(p.id);
    expect(t.map((x) => [x.levelId, x.ordinal, n(x.plannedContracts), x.triggerRule])).toEqual([
      ['lv1', 1, '10', 'ARM_PULLBACK'],
      ['lv2', 2, '10', 'ARM_PULLBACK'],
      ['lv3', 3, '10', 'ARM_PULLBACK'],
      ['lv4', 4, '10', 'ARM_PULLBACK'],
      ['lv5', 5, '10', 'ARM_PULLBACK']
    ]);
  });

  it('a target arms when reached and closes its allocation on the return crossing; it never fires twice', async () => {
    const p0 = (await openPositionOf(A))!;
    const t1 = (await targetsOf(p0.id))[0]!;
    await ticks([D(t1.triggerPrice).plus(5).toFixed(), D(t1.triggerPrice).minus(1).toFixed()]);
    expect((await exitsOf(p0.id)).map((e) => [e.reason, n(e.contracts)])).toEqual([['TAKE_PROFIT', '10']]);
    await ticks([D(t1.triggerPrice).plus(5).toFixed(), D(t1.triggerPrice).minus(1).toFixed()]);
    expect(await exitsOf(p0.id)).toHaveLength(1);
    expect((await targetsOf(p0.id))[0]!.status).toBe('DONE');
  });

  it('one-, two- and three-level legacy plans (shared take profit and trailing) still save', async () => {
    for (const levels of [
      [{ id: 'a', movePct: '1', closePct: '100' }],
      [
        { id: 'a', movePct: '1', closePct: '50' },
        { id: 'b', movePct: '2', closePct: '50' }
      ],
      [
        { id: 'a', movePct: '1', closePct: '30' },
        { id: 'b', movePct: '2', closePct: '30' },
        { id: 'c', movePct: '3', closePct: '40' }
      ]
    ]) {
      const r = await call(blocks.POST, { method: 'POST', path: '/x', cookie: cookies.b, body: blockBody({ instrumentId: BTC, takeProfit: { mode: levels.length === 1 ? 'FIXED' : 'SPLIT', levels }, trailing: { enabled: true, activationPct: '1', distancePct: '0.5', closePct: '30', basis: 'MARK' } }) });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      expect([r.body.takeProfitLong.allocationPct, r.body.trailingLong.closePct]).toEqual(['70', '100']);
      await direct.db.delete(schema.orderBlocks).where(eq(schema.orderBlocks.id, r.body.id));
    }
    const six = await call(blocks.POST, { method: 'POST', path: '/x', cookie: cookies.b, body: body({ takeProfitLong: { mode: 'SPLIT', allocationPct: '100', levels: [...five.levels, { id: 'lv6', movePct: '4', closePct: '0' }] }, takeProfitShort: TP_OFF, trailingLong: OFF, trailingShort: OFF }) });
    expect(six.status).toBe(400);
  });
});

describe('6. Admin → Common Exit Definition', () => {
  const PLAN_V1 = {
    takeProfitLong: { mode: 'FIXED', allocationPct: '50', levels: [{ id: 'adm1', movePct: '2', closePct: '100' }] },
    takeProfitShort: TP_OFF,
    trailingLong: { enabled: true, activationPct: '1', distancePct: '0.5', closePct: '40', targetClose: null, basis: 'MARK' },
    trailingShort: OFF
  };
  let blockId: string;
  let rev: number;
  const publish = (plan: unknown, scope: string, expectedVersion: number | null) => call(commonExit.POST, { method: 'POST', path: '/x', cookie: cookies.admin, body: { plan, scope, expectedVersion, note: 'test' } });

  beforeAll(async () => {
    // Version 1 is published before A's block is created with Sync Admin Setting checked; A's
    // own (custom) plan is a 5 % fixed target managing everything.
    await openFromAlert({
      version: async () => {
        const r = await publish(PLAN_V1, 'FUTURE_ENTRIES', null);
        if (r.status !== 201) throw new Error(JSON.stringify(r.body));
        return VERSION;
      },
      a: { ...exitPlan({ takeProfitLong: { mode: 'FIXED', allocationPct: '100', levels: [{ id: 'own', movePct: '5', closePct: '100' }] } }), ...TEN, syncAdminExit: true },
      b: null
    });
    blockId = (await call(blocks.GET, { path: '/x', cookie: cookies.a })).body.items[0].id;
  });

  it('the admin rule is validated like an investor plan; a stale version is refused', async () => {
    expect((await publish({ ...PLAN_V1, trailingLong: { ...PLAN_V1.trailingLong, closePct: '0' } }, 'FUTURE_ENTRIES', 1)).status).toBe(400);
    expect((await publish(PLAN_V1, 'FUTURE_ENTRIES', 0)).status).toBe(409);
    const v = (await call(commonExit.GET, { path: '/x', cookie: cookies.admin })).body;
    expect([v.current.version, v.current.author.email, v.linked.blocks.length, v.linked.openPositions.length]).toEqual([1, USERS.admin.email, 1, 1]);
  });

  it('checked: the effective plan is the admin rule (version shown); the custom plan is preserved', async () => {
    const b = (await call(blockById.GET, { path: '/x', cookie: cookies.a, params: { id: blockId } })).body;
    rev = b.revision;
    expect(b.syncAdminExit).toBe(true);
    expect(b.effectiveExit).toMatchObject({ source: 'ADMIN', adminVersion: 1, trailingLong: { closePct: '40' }, takeProfitLong: { allocationPct: '50' } });
    expect(b.takeProfitLong.levels[0].id).toBe('own'); // custom kept
  });

  it('the entry snapshots the admin version it used (server-side inheritance)', async () => {
    const p = (await openPositionOf(A))!;
    expect([p.exitPlanSource, p.exitPlanAdminVersion, n(p.trailingClosePct)]).toEqual(['ADMIN', 1, '40']);
    expect((await targetsOf(p.id)).map((t) => [t.levelId, n(t.plannedContracts)])).toEqual([['adm1', '5']]);
  });

  it('publishing version 2 for future entries: linked blocks update at once, investors are notified, open positions keep version 1, audit records it', async () => {
    const v2 = { ...PLAN_V1, trailingLong: { ...PLAN_V1.trailingLong, closePct: '60' } };
    const r = await publish(v2, 'FUTURE_ENTRIES', 1);
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ linkedBlocks: 1, notifiedInvestors: 1, positions: [] });
    const b = (await call(blockById.GET, { path: '/x', cookie: cookies.a, params: { id: blockId } })).body;
    expect(b.revision).toBe(rev + 1);
    expect(b.effectiveExit).toMatchObject({ adminVersion: 2, trailingLong: { closePct: '60' } });
    const p = (await openPositionOf(A))!;
    expect([p.exitPlanAdminVersion, n(p.trailingClosePct)]).toEqual([1, '40']);
    const notes = (await call(notifications.GET, { path: '/x', cookie: cookies.a })).body.items;
    expect(notes[0]).toMatchObject({ kind: 'COMMON_EXIT_DEFINITION', title: 'Admin exit rule updated to version 2' });
    expect((await call(notifications.GET, { path: '/x', cookie: cookies.b })).body.items).toHaveLength(0);
    const [audit] = await direct.db.select().from(schema.auditEvents).where(eq(schema.auditEvents.action, 'common_exit_definition.publish')).orderBy(desc(schema.auditEvents.createdAt)).limit(1);
    expect(audit!.metadata).toMatchObject({ version: 2, scope: 'FUTURE_ENTRIES', changes: [{ field: 'trailingLong' }] });
    expect(audit!.actorUserId).toBe(await userId(USERS.admin.email));
  });

  it('apply to existing positions: preview lists changes and kept exits; completed targets and trailing cycle history are preserved', async () => {
    const p0 = (await openPositionOf(A))!;
    // A completed target and one completed trailing cycle on the open position.
    await direct.db.update(schema.positionTargets).set({ status: 'DONE', filledContracts: sqlNum('5') }).where(eq(schema.positionTargets.positionId, p0.id));
    await direct.db.update(schema.positions).set({ trailingStatus: 'REARM', trailingCycle: 1, trailingCycleExtreme: '66000', trailingWatermark: '66000', trailingStopPrice: '65670' }).where(eq(schema.positions.id, p0.id));
    const v3 = {
      ...PLAN_V1,
      takeProfitLong: { mode: 'SPLIT', allocationPct: '50', levels: [{ id: 'adm1', movePct: '2', closePct: '50' }, { id: 'adm2', movePct: '4', closePct: '50' }] },
      trailingLong: { ...PLAN_V1.trailingLong, distancePct: '0.8', closePct: '50' }
    };
    const pv = await call(commonExitPreview.POST, { method: 'POST', path: '/x', cookie: cookies.admin, body: { plan: v3 } });
    expect(pv.status).toBe(200);
    const item = pv.body.positions.find((x: { positionId: string }) => x.positionId === p0.id);
    expect(item.status).toBe('WOULD_APPLY');
    expect(item.kept.join(' ')).toMatch(/Target adm1: already completed/);
    expect(item.kept.join(' ')).toMatch(/1 completed cycle/);
    expect(item.changes.join(' ')).toMatch(/Add target 2 \(adm2\)/);
    expect(await targetsOf(p0.id)).toHaveLength(1); // preview writes nothing

    const r = await publish(v3, 'EXISTING_POSITIONS', 2);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.positions.find((x: { positionId: string }) => x.positionId === p0.id).status).toBe('APPLIED');
    const p = await posRow(p0.id);
    expect([p.exitPlanSource, p.exitPlanAdminVersion, p.trailingCycle, n(p.trailingCycleExtreme), n(p.trailingClosePct), n(p.trailingDistancePct), p.trailingStatus]).toEqual(['ADMIN', 3, 1, '66000', '50', '0.8', 'REARM']);
    const t = await targetsOf(p0.id);
    expect(t.map((x) => [x.levelId, x.status])).toEqual([
      ['adm1', 'DONE'],
      ['adm2', 'PENDING']
    ]);
    const d = (await call(trade.GET, { path: '/x', cookie: cookies.a, params: { id: p0.id } })).body;
    expect(d.exitPlan).toMatchObject({ source: 'ADMIN', adminVersion: 3 });
    expect(d.exitPlan.appliedAt).toBeTruthy();
  });

  it('a pending trailing exit quantity is never recalculated or duplicated by an application', async () => {
    const p0 = (await openPositionOf(A))!;
    await direct.db.update(schema.positions).set({ trailingCycleContracts: '2', trailingCycleFilled: '1', trailingStatus: 'ACTIVE' }).where(eq(schema.positions.id, p0.id));
    const r = await publish({ ...PLAN_V1, trailingLong: { ...PLAN_V1.trailingLong, closePct: '90' } }, 'EXISTING_POSITIONS', 3);
    const out = r.body.positions.find((x: { positionId: string }) => x.positionId === p0.id);
    expect(out.kept.join(' ')).toMatch(/completes with its saved quantity first/);
    const p = await posRow(p0.id);
    expect([n(p.trailingCycleContracts), n(p.trailingCycleFilled), n(p.trailingClosePct)]).toEqual(['2', '1', '50']);
  });

  it('unchecked: the custom plan is restored exactly', async () => {
    const b = (await call(blockById.GET, { path: '/x', cookie: cookies.a, params: { id: blockId } })).body;
    const r = await call(blockById.PATCH, { method: 'PATCH', path: '/x', cookie: cookies.a, params: { id: blockId }, ifMatch: b.revision, body: { syncAdminExit: false } });
    expect(r.status).toBe(200);
    expect(r.body.effectiveExit).toMatchObject({ source: 'CUSTOM', adminVersion: null, takeProfitLong: { levels: [{ id: 'own', movePct: '5' }] } });
  });

  it('investors only see and change their own blocks and notifications', async () => {
    expect((await call(blockById.GET, { path: '/x', cookie: cookies.b, params: { id: blockId } })).status).toBe(404);
    expect((await call(commonExit.GET, { path: '/x', cookie: cookies.a })).status).toBe(403);
  });
});

describe('1. Shaheen-like investor: Bitunix connection only, Live-only Bitunix XAUUSDT', () => {
  const bx = Object.assign(new MockBitunixExchange(), { nowMs: () => clock.now.getTime() });
  let xau: string;
  let version: string;
  beforeAll(async () => {
    await openFromAlert({ a: null, b: null });
    installLiveTestSeam({ requesterFor: () => new MockMexc(), bitunixRequesterFor: () => bx, transportEnabled: true, confirm: { attempts: 2, delayMs: 0 } });
    installBitunixTestSeam({ requesterFor: () => bx });
    // The published Bitunix gold perpetual (as in bitunixChartWebhook.test.ts): Live only.
    const added = await call(bitunixInstrument.POST, { method: 'POST', path: '/x', cookie: cookies.admin, body: { symbol: 'BTCUSDT' } });
    const [bxBtc] = await direct.db.select().from(schema.instruments).where(eq(schema.instruments.id, added.body.instrument.id));
    const { id: _i, createdAt: _c, updatedAt: _u, ...rest } = bxBtc!;
    void _i;
    void _c;
    void _u;
    const [row] = await direct.db
      .insert(schema.instruments)
      .values({ ...rest, symbol: 'XAUUSDT', exchangeSymbol: 'XAUUSDT', base: 'XAU', quote: 'USDT', priceTick: '0.01', qtyStep: '0.01', minQty: '0.01', maxQty: '100', status: 'PUBLISHED', isFixture: false })
      .returning();
    xau = row!.id;
    version = await publishVersion({ instrumentIds: [xau] });
    bx.usdt.available = '5000';
    bx.setSettings('XAUUSDT', { longLeverage: 10, shortLeverage: 10 });
    // B ("Shaheen") connects Bitunix only; A connects their own Bitunix account separately.
    expect((await call(conn.PUT, { method: 'PUT', cookie: cookies.b, body: { exchange: 'BITUNIX', accountRef: 'bx-shaheen', apiKey: 'bitunix-key-b-2222', secretKey: 'bitunix-secret-b' } })).body.connection).toMatchObject({ status: 'VERIFIED' });
    expect((await call(conn.PUT, { method: 'PUT', cookie: cookies.a, body: { exchange: 'BITUNIX', accountRef: 'bx-a', apiKey: 'bitunix-key-a-1111', secretKey: 'bitunix-secret-a' } })).body.connection).toMatchObject({ status: 'VERIFIED' });
  }, 120_000);

  const xauBody = (o: Record<string, unknown> = {}) => blockBody({ instrumentId: xau, strategyVersionId: version, mode: 'LIVE', leverage: 10, orderCostUsdt: '50', ...o });

  it('Paper is refused for the Live-only pair with the reason; Live saves an order block', async () => {
    const paper = await call(blocks.POST, { method: 'POST', path: '/x', cookie: cookies.b, body: xauBody({ mode: 'PAPER' }) });
    expect(paper.status).toBe(400);
    expect(JSON.stringify(paper.body.issues)).toMatch(/Live only/);
    const live = await call(blocks.POST, { method: 'POST', path: '/x', cookie: cookies.b, body: xauBody() });
    expect(live.status, JSON.stringify(live.body)).toBe(201);
    expect([live.body.symbol, live.body.exchange, live.body.mode, live.body.status]).toEqual(['XAUUSDT', 'BITUNIX', 'LIVE', 'PAUSED']);
    expect([live.body.syncAdminExit, live.body.effectiveExit.source]).toEqual([false, 'CUSTOM']);
    // No Common Exit Definition published: Sync Admin Setting cannot be turned on (explained).
    const sync = await call(blockById.PATCH, { method: 'PATCH', path: '/x', cookie: cookies.b, params: { id: live.body.id }, ifMatch: live.body.revision, body: { syncAdminExit: true } });
    expect(sync.status).toBe(400);
    expect(sync.body.issues).toContainEqual(expect.objectContaining({ path: 'syncAdminExit', message: expect.stringMatching(/No Common Exit Definition is published/) }));
  });

  it('two investors: separate connections and separate settings for the same pair', async () => {
    const a = await call(blocks.POST, { method: 'POST', path: '/x', cookie: cookies.a, body: xauBody({ orderCostUsdt: '75', direction: 'LONG_ONLY' }) });
    expect(a.status).toBe(201);
    const listA = (await call(blocks.GET, { path: '/x', cookie: cookies.a })).body.items.filter((x: { instrumentId: string }) => x.instrumentId === xau);
    const listB = (await call(blocks.GET, { path: '/x', cookie: cookies.b })).body.items.filter((x: { instrumentId: string }) => x.instrumentId === xau);
    expect([listA.length, listB.length]).toEqual([1, 1]);
    expect([listA[0].orderCostUsdt, listA[0].direction, listB[0].orderCostUsdt, listB[0].direction]).toEqual(['75', 'LONG_ONLY', '50', 'BOTH']);
    const conns = await direct.db.select().from(schema.exchangeConnections).where(eq(schema.exchangeConnections.exchange, 'BITUNIX'));
    expect(new Set(conns.map((c) => c.ownerId)).size).toBe(2);
    expect((await call(blockById.GET, { path: '/x', cookie: cookies.a, params: { id: listB[0].id } })).status).toBe(404);
  });
});

/** Numeric column value (drizzle numeric columns take decimal strings). */
function sqlNum(v: string) {
  return v;
}
