// EXT-04 Trailing Take Profit in Paper mode, through the real alert → entry → market tick →
// close flow. BTC example: entry 74788.4, fixed stop 0.3 %, activation 0.3 %, trail 0.1 %
// (mark price), 100 USDT × 10 → 133 contracts. Also: the legacy trailing-stop conversion
// (entries held until an explicit activation value is saved) and split targets with Trailing
// Take Profit on the remainder (no quantity is closed twice).
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { and, eq } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { createDb, schema } from '@trendpilot/db';
import { testDatabaseUrl } from '../testDb';
import * as blocks from '@/app/v1/me/order-blocks/route';
import * as block from '@/app/v1/me/order-blocks/[id]/route';
import * as resume from '@/app/v1/me/order-blocks/[id]/resume/route';
import * as holdings from '@/app/v1/me/holdings/route';
import * as trade from '@/app/v1/me/trades/[id]/route';
import { setTestClock } from '@/server/clock';
import { blockBody, call, direct, teardown, USERS } from '../helpers';
import { ALL_DAYS, clock, cookies, D, deliver, drain, exitsOf, M15, n, openFromAlert, openPositionOf, plus, positionsOf, reconciled, stopOf, targetsOf, tick, venue, work } from '../paperReplay';

const A = USERS.investorA.email;
const ENTRY = '74788.4';
/** Take profit is off in the example: Trailing Take Profit closes 100 % of the position. */
const TTP = { enabled: true, activationPct: '0.3', distancePct: '0.1', closePct: '100', basis: 'MARK' };
const EXAMPLE = { stop: { type: 'PERCENT', value: '0.3', basis: 'MARK' }, takeProfit: { mode: 'OFF', levels: [] }, trailing: TTP };

afterAll(async () => {
  setTestClock(null);
  await teardown();
});

const holdingOf = async () => (await call(holdings.GET, { path: '/x', cookie: cookies.a })).body.positions[0];
const openIntentOf = async (positionId: string) => {
  const [p] = await direct.db.select().from(schema.positions).where(eq(schema.positions.id, positionId));
  return (await direct.db.select().from(schema.orderIntents).where(eq(schema.orderIntents.id, p!.openIntentId)))[0]!;
};
/** Ticks prices in order; returns each tick's summary. */
async function ticks(prices: string[]) {
  const out = [];
  for (const p of prices) {
    await tick(p);
    out.push((await drain()).find((x) => x.tick)!.tick!);
  }
  return out;
}

describe('Short example: entry 74788.4, stop 0.3 %, Trailing Take Profit 0.3 % / 0.1 %', () => {
  it('opens with the fixed stop attached to the opening order, Trailing Take Profit waiting for activation', async () => {
    await openFromAlert({ side: 'SHORT', price: '74788.9', a: EXAMPLE, b: null }); // bid 74788.4
    const p = (await openPositionOf(A))!;
    expect([p.side, n(p.avgEntryPrice), n(p.contracts)]).toEqual(['SHORT', ENTRY, '133']);
    // The stop is part of the opening order request, and protects the whole position.
    const open = await openIntentOf(p.id);
    expect(n(open.stopPrice)).toBe('75012.7'); // 74788.4 × 1.003, rounded toward entry
    const stop = await stopOf(p);
    expect([stop.status, n(stop.triggerPrice), n(stop.contracts)]).toEqual(['ACTIVE', '75012.7', '133']);
    expect(p).toMatchObject({ protectionStatus: 'PROTECTED', trailingKind: 'TAKE_PROFIT', trailingStatus: 'WAITING', trailingBasis: 'MARK', trailingWatermark: null, trailingStopPrice: null });
    expect(n(p.trailingActivationPrice)).toBe('74564'); // 74788.4 × 0.997, never closer than configured
    expect(await holdingOf()).toMatchObject({ trailing: { kind: 'TAKE_PROFIT', status: 'WAITING', activationPrice: '74564', contracts: '133', distancePct: '0.1' } });
  });

  it('a move directly to 74863.2 does not trigger Trailing Take Profit (nor the 0.3 % stop)', async () => {
    const [t] = await ticks(['74863.2']);
    expect(t).toMatchObject({ trailingActivated: 0, trailingTakeProfitsRequested: 0, trailingStopsRequested: 0, stopsTriggered: 0 });
    const p = (await openPositionOf(A))!;
    expect([p.status, n(p.contracts), p.trailingStatus]).toEqual(['OPEN', '133', 'WAITING']);
    expect(await exitsOf(p.id)).toHaveLength(0);
  });

  it('a favourable move that stops short of activation, then a rebound: still waiting, nothing closes', async () => {
    const t = await ticks(['74700', '74600', '74564.1', '74750', '74863.2']);
    expect(t.every((x) => x.trailingActivated === 0 && x.trailingTakeProfitsRequested === 0 && x.stopsTriggered === 0)).toBe(true);
    const p = (await openPositionOf(A))!;
    expect([p.status, p.trailingStatus, p.trailingWatermark]).toEqual(['OPEN', 'WAITING', null]);
    expect(await exitsOf(p.id)).toHaveLength(0);
    expect((await holdingOf()).trailing.status).toBe('WAITING');
  });

  it('arms at the activation price and tracks the lowest price; Holdings shows Active', async () => {
    const [armed] = await ticks(['74564']);
    expect(armed).toMatchObject({ trailingActivated: 1, trailingTakeProfitsRequested: 0 });
    let p = (await openPositionOf(A))!;
    expect([p.trailingStatus, n(p.trailingWatermark), n(p.trailingStopPrice)]).toEqual(['ACTIVE', '74564', '74638.6']);
    expect(p.trailingActivatedAt).toBeTruthy();
    // The fixed stop stays in place after activation.
    expect([(await stopOf(p)).status, n((await stopOf(p)).contracts)]).toEqual(['ACTIVE', '133']);
    expect(await holdingOf()).toMatchObject({ trailing: { status: 'ACTIVE', watermark: '74564', level: '74638.6', contracts: '133' } });
    await ticks(['74520']);
    p = (await openPositionOf(A))!;
    expect([n(p.trailingWatermark), n(p.trailingStopPrice)]).toEqual(['74520', '74594.6']);
  });

  it('restart after activation: a fresh worker continues from the persisted low and level; a re-run tick changes nothing', async () => {
    await tick('74500');
    const fresh = createDb(testDatabaseUrl(), 4); // a restarted worker: new pool, no memory
    try {
      const first = await work(clock.now, undefined, fresh.db);
      expect(first.tick).toMatchObject({ trailingTightened: 1, trailingTakeProfitsRequested: 0 });
      // Crash before the tick's completion is observed: the same tick runs again.
      await direct.db.update(schema.jobs).set({ status: 'PENDING', claimToken: null, runAfter: new Date(0) }).where(eq(schema.jobs.id, first.job!.id));
      const again = await work(clock.now, undefined, fresh.db);
      expect(again.tick).toMatchObject({ trailingActivated: 0, trailingTightened: 0, trailingTakeProfitsRequested: 0 });
      // A bounce that stays below the level, processed by the restarted worker: still open.
      await tick('74560');
      await drain(clock.now, fresh.db);
    } finally {
      await fresh.close();
    }
    const p = (await openPositionOf(A))!;
    expect([p.trailingStatus, n(p.trailingWatermark), n(p.trailingStopPrice), n(p.contracts)]).toEqual(['ACTIVE', '74500', '74574.5', '133']);
  });

  it('a 0.1 % pullback from the low closes the position at market as TRAILING_TAKE_PROFIT, in profit', async () => {
    const id = (await openPositionOf(A))!.id;
    const [t] = await ticks(['74574.5']);
    expect(t).toMatchObject({ trailingTakeProfitsRequested: 1, trailingStopsRequested: 0 });
    const [p] = await positionsOf(A);
    expect(p).toMatchObject({ id, status: 'CLOSED', closeReason: 'TRAILING_TAKE_PROFIT' });
    const [x] = await exitsOf(id);
    expect([x!.reason, n(x!.contracts), n(x!.price)]).toEqual(['TRAILING_TAKE_PROFIT', '133', '74575']); // bought back at the ask
    expect(D(x!.realizedPnl).gt(0)).toBe(true);
    expect((await stopOf(p!)).status).toBe('CANCELLED');
    expect(await venue()).toEqual([{ side: 'SHORT', contracts: '0' }]);
    expect(await reconciled()).toBe(true);
    // My Trades records the exit reason.
    const detail = (await call(trade.GET, { path: '/x', cookie: cookies.a, params: { id } })).body;
    expect(detail).toMatchObject({ closeReason: 'TRAILING_TAKE_PROFIT', trailing: { kind: 'TAKE_PROFIT', status: 'DONE', plannedContracts: '133', filledContracts: '133' } });
    expect(detail.exits.map((e: { reason: string }) => e.reason)).toEqual(['TRAILING_TAKE_PROFIT']);
  });
});

describe('Long equivalent: entry 74788.4, stop 0.3 %, Trailing Take Profit 0.3 % / 0.1 %', () => {
  it('opens Long with the stop attached; activation at 75012.8', async () => {
    await openFromAlert({ price: '74787.9', a: EXAMPLE, b: null }); // ask 74788.4
    const p = (await openPositionOf(A))!;
    expect([p.side, n(p.avgEntryPrice), n(p.contracts), n((await openIntentOf(p.id)).stopPrice)]).toEqual(['LONG', ENTRY, '133', '74564.1']);
    expect([p.trailingKind, p.trailingStatus, n(p.trailingActivationPrice)]).toEqual(['TAKE_PROFIT', 'WAITING', '75012.8']);
  });

  it('a direct adverse 0.1 % move, a rise short of activation and a rebound never trigger it', async () => {
    const t = await ticks(['74713.6', '74900', '75012.7', '74800']);
    expect(t.every((x) => x.trailingActivated === 0 && x.trailingTakeProfitsRequested === 0 && x.stopsTriggered === 0)).toBe(true);
    const p = (await openPositionOf(A))!;
    expect([p.status, p.trailingStatus]).toEqual(['OPEN', 'WAITING']);
  });

  it('arms, tracks the highest price and closes on a 0.1 % pullback from it', async () => {
    const [armed, higher] = await ticks(['75012.8', '75100']);
    expect(armed).toMatchObject({ trailingActivated: 1 });
    expect(higher).toMatchObject({ trailingTightened: 1 });
    let p = (await openPositionOf(A))!;
    expect([n(p.trailingWatermark), n(p.trailingStopPrice)]).toEqual(['75100', '75024.9']);
    const [hold] = await ticks(['75025']);
    expect(hold).toMatchObject({ trailingTakeProfitsRequested: 0 });
    const [fired] = await ticks(['75024.9']);
    expect(fired).toMatchObject({ trailingTakeProfitsRequested: 1 });
    [p] = (await positionsOf(A)) as [typeof p];
    expect(p).toMatchObject({ status: 'CLOSED', closeReason: 'TRAILING_TAKE_PROFIT' });
    const [x] = await exitsOf(p.id);
    expect([n(x!.contracts), n(x!.price)]).toEqual(['133', '75024.4']); // sold at the bid
    expect(D(x!.realizedPnl).gt(0)).toBe(true);
    expect(await reconciled()).toBe(true);
  });
});

describe('split targets and Trailing Take Profit each close only their own allocation', () => {
  // 133 contracts. Trailing Take Profit: Position to close 20 % → 26. Take Profit manages the
  // other 107: target 1 62.5 % of it (66), target 2 the rest (41).
  const SPLIT = { mode: 'SPLIT', levels: [{ id: 'tp1', movePct: '0.5', closePct: '62.5' }, { id: 'tp2', movePct: '1', closePct: '37.5' }] };
  const TTP20 = { ...TTP, closePct: '20' };

  it('Holdings shows the quantity each exit manages', async () => {
    await openFromAlert({ price: '74787.9', a: { ...EXAMPLE, takeProfit: SPLIT, trailing: TTP20 }, b: null });
    const p = (await openPositionOf(A))!;
    expect((await targetsOf(p.id)).map((t) => [t.levelId, n(t.triggerPrice), n(t.plannedContracts)])).toEqual([
      ['tp1', '75162.3', '66'],
      ['tp2', '75536.2', '41']
    ]);
    expect((await holdingOf()).trailing).toMatchObject({ status: 'WAITING', contracts: '26', plannedContracts: '26', filledContracts: '0' });
  });

  it('the first touch of target 1 only arms it (Trailing Take Profit activates on the same move); nothing closes', async () => {
    const [t1] = await ticks(['75170']);
    expect(t1).toMatchObject({ trailingActivated: 1, targetsArmed: 1, takeProfitsRequested: 0 });
    const p = (await openPositionOf(A))!;
    expect([n(p.contracts), n(p.trailingStopPrice)]).toEqual(['133', '75094.8']);
    expect((await holdingOf()).trailing).toMatchObject({ status: 'ACTIVE', contracts: '26' });
  });

  it('a pullback closes the trailing 26 and target 1\'s 66 — each only its own; target 2 keeps its 41', async () => {
    const [pull] = await ticks(['75094.8']);
    expect(pull).toMatchObject({ trailingTakeProfitsRequested: 1 });
    const p = (await openPositionOf(A))!;
    expect(n(p.contracts)).toBe('41');
    expect(n((await stopOf(p)).contracts)).toBe('41'); // the stop still covers everything left
    expect([p.trailingStatus, n(p.trailingFilledContracts)]).toEqual(['DONE', '26']);
    const [tp1, tp2] = await targetsOf(p.id);
    expect([tp1!.status, n(tp1!.filledContracts)]).toEqual(['DONE', '66']);
    expect([tp2!.status, n(tp2!.filledContracts), tp2!.armedAt]).toEqual(['PENDING', '0', null]);
    expect((await exitsOf(p.id)).map((x) => [x.reason, n(x.contracts)])).toEqual([
      ['TRAILING_TAKE_PROFIT', '26'],
      ['TAKE_PROFIT', '66']
    ]);
  });

  it('target 2 arms at its price and closes its own 41 on the pullback; every contract was closed exactly once', async () => {
    const id = (await openPositionOf(A))!.id;
    const [arm] = await ticks(['75536.2']);
    expect(arm).toMatchObject({ targetsArmed: 1, takeProfitsRequested: 0 });
    expect(n((await openPositionOf(A))!.contracts)).toBe('41');
    await ticks(['75500']);
    const [p] = await positionsOf(A);
    expect(p).toMatchObject({ id, status: 'CLOSED', closeReason: 'TAKE_PROFIT' });
    expect((await exitsOf(id)).map((x) => [x.reason, n(x.contracts)])).toEqual([
      ['TRAILING_TAKE_PROFIT', '26'],
      ['TAKE_PROFIT', '66'],
      ['TAKE_PROFIT', '41']
    ]);
    expect(await reconciled()).toBe(true);
  });
});

describe('an order block saved with the old trailing stop', () => {
  const migrationSql = readFileSync(path.resolve(__dirname, '../../../../packages/db/migrations/0018_m8_trailing_take_profit.sql'), 'utf8');
  const dataStep = migrationSql
    .split('--> statement-breakpoint')
    .map((x) => x.replace(/^\s*--.*$/gm, '').trim())
    .filter((x) => x.startsWith('UPDATE'));
  let blockId = '';
  let bar = new Date('2026-11-08T09:15:00Z');

  async function nextAlert() {
    bar = new Date(bar.getTime() + M15);
    clock.now = plus(new Date(bar.getTime() + M15), 3);
    await tick('65000');
    expect(await deliver('BULLISH_FLIP', bar)).toBe(202);
    await drain();
  }
  const entryDecision = async () => {
    const rows = await direct.db.select().from(schema.signalDecisions).where(and(eq(schema.signalDecisions.orderBlockId, blockId), eq(schema.signalDecisions.step, 'ENTRY_V1')));
    return rows.sort((x, y) => x.createdAt.getTime() - y.createdAt.getTime()).at(-1)!;
  };
  const get = async () => (await call(block.GET, { path: '/x', cookie: cookies.a, params: { id: blockId } })).body;

  it('migration 0018 flags it for conversion without inventing an activation value', async () => {
    await openFromAlert({ a: null, b: null });
    const created = await call(blocks.POST, { method: 'POST', path: '/x', cookie: cookies.a, body: blockBody({ weekdays: ALL_DAYS, takeProfit: { mode: 'FIXED', levels: [{ id: 'tp1', movePct: '3', closePct: '100' }] } }) });
    expect(created.status).toBe(201);
    blockId = created.body.id;
    await call(resume.POST, { method: 'POST', path: '/x', cookie: cookies.a, params: { id: blockId }, ifMatch: created.body.revision });
    // What the old build saved: Fixed TP 100 % plus a trailing stop "from entry" (no activation).
    await direct.db.update(schema.orderBlocks).set({ trailing: { enabled: true, activationPct: null, distancePct: '1', basis: 'MARK' } }).where(eq(schema.orderBlocks.id, blockId));
    expect(dataStep).toHaveLength(2);
    for (const stmt of dataStep) await direct.pool.query(stmt);
    const b = await get();
    expect(b).toMatchObject({ trailingConversionRequired: true, trailing: { enabled: true, activationPct: null, distancePct: '1' } });
  });

  it('new entries are held with a clear reason; nothing opens', async () => {
    await nextAlert();
    const d = await entryDecision();
    expect(d).toMatchObject({ status: 'SKIPPED', reason: 'TRAILING_CONVERSION_REQUIRED' });
    expect((d.detail as { reasonText: string }).reasonText).toMatch(/Activate after profit/);
    expect(await positionsOf(A)).toHaveLength(0);
  });

  it('an unrelated edit cannot skip the activation value; the block stays held', async () => {
    const b = await get();
    const r = await call(block.PATCH, { method: 'PATCH', path: '/x', cookie: cookies.a, params: { id: blockId }, ifMatch: b.revision, body: { orderCostUsdt: '90' } });
    expect(r.status).toBe(400);
    expect(r.body.issues).toContainEqual({ path: 'trailing.activationPct', message: 'Enter Activate after profit (%).' });
    expect((await get()).trailingConversionRequired).toBe(true);
  });

  it('saving Trailing Take Profit with an explicit activation converts it (and an explicit Position to close is required)', async () => {
    let b = await get();
    // The allocation is never assumed: without Position to close (%) the save is refused.
    const { closePct: _omit, ...noAllocation } = TTP;
    const clash = await call(block.PATCH, { method: 'PATCH', path: '/x', cookie: cookies.a, params: { id: blockId }, ifMatch: b.revision, body: { trailing: noAllocation } });
    expect(clash.status).toBe(400);
    expect(clash.body.issues.map((i: { path: string }) => i.path)).toContain('trailing.closePct');
    const ok = await call(block.PATCH, {
      method: 'PATCH',
      path: '/x',
      cookie: cookies.a,
      params: { id: blockId },
      ifMatch: b.revision,
      body: { takeProfit: { mode: 'FIXED', levels: [{ id: 'tp1', movePct: '3', closePct: '100' }] }, trailing: { ...TTP, closePct: '40' } }
    });
    expect(ok.status).toBe(200);
    b = await get();
    expect(b).toMatchObject({ trailingConversionRequired: false, trailing: { ...TTP, closePct: '40' } });
    const [audit] = await direct.db.select().from(schema.auditEvents).where(and(eq(schema.auditEvents.action, 'ORDER_BLOCK_UPDATE'), eq(schema.auditEvents.targetId, blockId)));
    expect(audit!.metadata).toMatchObject({ trailingConvertedToTakeProfit: true });
  });

  it('the next alert opens a position with Trailing Take Profit on 40 % and the fixed target on the other 60 %', async () => {
    await nextAlert();
    expect(await entryDecision()).toMatchObject({ status: 'ENTRY_APPROVED' });
    const p = (await openPositionOf(A))!;
    expect([p.trailingKind, p.trailingStatus, n(p.trailingPlannedContracts)]).toEqual(['TAKE_PROFIT', 'WAITING', '61']); // floor(153 × 40 %)
    const [t] = await targetsOf(p.id);
    expect([n(t!.closePct), n(t!.plannedContracts), n(p.contracts)]).toEqual(['100', '92', '153']); // the exact rest
    expect((await holdingOf()).trailing).toMatchObject({ contracts: '61' });
  });
});
