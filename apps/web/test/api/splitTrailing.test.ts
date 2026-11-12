// M2 slice 4: split take profit (EXT-03), Trailing Take Profit on the remainder (EXT-04) and
// competing exit triggers (EXT-06) on paper positions, using each position's saved exit plan.
// The legacy trailing stop (positions opened before Trailing Take Profit) keeps its saved
// behaviour: those scenarios start from the exact state the old code persisted.
// Deterministic fixture ticks.
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, schema } from '@trendpilot/db';
import { trailingLevelFrom } from '@trendpilot/domain';
import { testDatabaseUrl } from '../testDb';
import * as closePos from '@/app/v1/me/positions/[id]/close/route';
import * as trade from '@/app/v1/me/trades/[id]/route';
import { setTestClock } from '@/server/clock';
import { call, direct, teardown, USERS } from '../helpers';
import { clock, closeIntentsOf, cookies, D, drain, exitsOf, n, openFromAlert, openPositionOf, positionsOf, reconciled, stopOf, targetsOf, tick, venue, work } from '../paperReplay';

const A = USERS.investorA.email;
const B = USERS.investorB.email;
/** Split targets divide the Take Profit share (here 80 % of the position): 62.5 % and 37.5 % of it. */
const SPLIT = { mode: 'SPLIT', levels: [{ id: 'tp1', movePct: '2', closePct: '62.5' }, { id: 'tp2', movePct: '4', closePct: '37.5' }] };
/** Trailing Take Profit with its "Position to close (%)" (default 20 % of the opening quantity). */
const TRAIL = (activationPct: string | null, distancePct: string, basis = 'MARK', closePct = '20') => ({ enabled: true, activationPct, distancePct, closePct, basis });
const off = { enabled: false, activationPct: null, distancePct: null, basis: 'MARK' };
/** A slow venue queue: pending close jobs wait until released. */
const holdCloses = () => direct.db.update(schema.jobs).set({ runAfter: new Date('2100-01-01') }).where(and(eq(schema.jobs.kind, 'paper.close'), eq(schema.jobs.status, 'PENDING')));
const releaseCloses = () => direct.db.update(schema.jobs).set({ runAfter: new Date(0) }).where(and(eq(schema.jobs.kind, 'paper.close'), eq(schema.jobs.status, 'PENDING')));
/**
 * Turns an open position into one opened before Trailing Take Profit with the old "trailing
 * from entry" plan: legacy kind, active from entry, no activation price, level from the entry.
 * This is exactly what the previous code persisted and migration 0018 keeps.
 */
async function asLegacyTrailingStop(positionId: string, distancePct: string, basis: 'MARK' | 'LAST') {
  const [p] = await direct.db.select().from(schema.positions).where(eq(schema.positions.id, positionId));
  await direct.db
    .update(schema.positions)
    .set({
      trailingKind: 'STOP',
      trailingStatus: 'ACTIVE',
      trailingBasis: basis,
      trailingDistancePct: distancePct,
      trailingActivationPrice: null,
      trailingActivatedAt: p!.openedAt,
      trailingWatermark: p!.avgEntryPrice,
      trailingStopPrice: trailingLevelFrom(p!.side as 'LONG' | 'SHORT', p!.avgEntryPrice, distancePct, '0.1'),
      trailingUpdatedAt: p!.openedAt
    })
    .where(eq(schema.positions.id, positionId));
}
const manualClose = (cookie: string, id: string) => call(closePos.POST, { method: 'POST', path: '/x', cookie, params: { id }, headers: { 'idempotency-key': `k-${Math.random().toString(36).slice(2)}` } });

afterAll(async () => {
  setTestClock(null);
  await teardown();
});

describe('Long: Trailing Take Profit closes 20 %; split TP (62.5 % / 37.5 % of the other 80 %)', () => {
  beforeAll(() => openFromAlert({ a: { takeProfit: SPLIT, trailing: TRAIL('3', '1') }, b: null }));

  it('allocation comes from the confirmed fill: trailing 20 %, targets split the Take Profit rest', async () => {
    const p = (await openPositionOf(A))!;
    expect(n(p.avgEntryPrice)).toBe('65000.5');
    expect(n(p.contracts)).toBe('153');
    expect(n(p.trailingPlannedContracts)).toBe('30'); // floor(153 × 20 %)
    expect(n(p.trailingFilledContracts)).toBe('0');
    const t = await targetsOf(p.id);
    expect(t.map((x) => [x.levelId, n(x.triggerPrice), n(x.plannedContracts), x.status, x.triggerRule, x.armedAt])).toEqual([
      ['tp1', '66300.5', '76', 'PENDING', 'ARM_PULLBACK', null], // 65000.5 × 1.02, toward entry; floor(123 × 62.5 %)
      ['tp2', '67600.5', '47', 'PENDING', 'ARM_PULLBACK', null] // 65000.5 × 1.04; the exact rest of the 123 Take Profit contracts
    ]);
    expect(p).toMatchObject({ trailingStatus: 'WAITING', trailingBasis: 'MARK' });
    expect(n(p.trailingActivationPrice)).toBe('66950.6'); // 65000.5 × 1.03, rounded away from entry
  });

  it('the first touch of tp1 only arms it', async () => {
    await tick('66400');
    const r = await drain();
    expect(r.find((x) => x.tick)?.tick).toMatchObject({ takeProfitsRequested: 0, targetsArmed: 1 });
    expect(r.find((x) => x.close)).toBeUndefined();
    const p = (await openPositionOf(A))!;
    expect(n(p.contracts)).toBe('153');
    const [t1, t2] = await targetsOf(p.id);
    expect(t1!.armedAt).not.toBeNull();
    expect(n(t1!.armedPrice)).toBe('66400');
    expect(t2!.armedAt).toBeNull();
  });

  it('a pullback through tp1 closes it; a partial fill accounts only for the actual fill and keeps the remainder protected', async () => {
    await tick('66250', { liquidity: '50' });
    const r = await drain();
    expect(r.find((x) => x.tick)?.tick).toMatchObject({ takeProfitsRequested: 1, trailingActivated: 0 });
    expect(r.find((x) => x.close)?.close).toMatchObject({ state: 'EXPIRED', exitReason: 'TAKE_PROFIT', targetLevelId: 'tp1', filled: '50', remaining: '103', closed: false });
    const p = (await openPositionOf(A))!;
    const [t1, t2] = await targetsOf(p.id);
    expect([t1!.status, n(t1!.requestedContracts), n(t1!.filledContracts)]).toEqual(['PARTIAL', '76', '50']);
    expect(t2!.status).toBe('PENDING');
    expect(p).toMatchObject({ protectionStatus: 'PROTECTED' });
    expect(n(p.stopContracts)).toBe('103');
    expect(n((await stopOf(p)).contracts)).toBe('103');
  });

  it('the unfilled target resumes only for its remaining quantity, then never repeats', async () => {
    await tick('66250');
    const r = await drain();
    expect(r.find((x) => x.close)?.close).toMatchObject({ state: 'FILLED', targetLevelId: 'tp1', filled: '26', remaining: '77' });
    const p = (await openPositionOf(A))!;
    const [t1] = await targetsOf(p.id);
    expect([t1!.status, n(t1!.requestedContracts), n(t1!.filledContracts)]).toEqual(['DONE', '102', '76']);
    expect(n((await stopOf(p)).contracts)).toBe('77');

    // The same price (and the same tick replayed) does nothing more.
    const closesBefore = (await closeIntentsOf(p.id)).length;
    await tick('66250');
    await tick('66250', { at: clock.now }); // identical tick → deduplicated job
    await drain();
    expect((await closeIntentsOf(p.id)).length).toBe(closesBefore);
    expect((await exitsOf(p.id)).map((x) => n(x.contracts))).toEqual(['50', '26']);
  });

  it('trailing activates at the saved threshold on the saved basis and persists watermark and level', async () => {
    await tick('67000', { mark: '67000', last: '66000' }); // MARK basis: last is ignored
    const r = await drain();
    expect(r.find((x) => x.tick)?.tick).toMatchObject({ trailingActivated: 1, takeProfitsRequested: 0 });
    const p = (await openPositionOf(A))!;
    expect(p).toMatchObject({ trailingStatus: 'ACTIVE' });
    expect(n(p.trailingWatermark)).toBe('67000');
    expect(n(p.trailingStopPrice)).toBe('66330'); // 67000 × 0.99
    expect(p.trailingActivatedAt).toBeTruthy();
    // The original venue stop stays in place for the remaining quantity.
    expect(await stopOf(p)).toMatchObject({ status: 'ACTIVE' });
    expect(n((await stopOf(p)).triggerPrice)).toBe('64025.5');
  });

  it('restart after activation: arming and trailing state are persisted; a re-run tick changes nothing', async () => {
    await tick('67700'); // reaches tp2 (arms it) and raises the watermark
    const fresh = createDb(testDatabaseUrl(), 4); // a "restarted" worker: new pool, no memory (the simulator uses its own connection)
    try {
      const first = await work(clock.now, undefined, fresh.db);
      expect(first.tick).toMatchObject({ takeProfitsRequested: 0, targetsArmed: 1, trailingTightened: 1 });
      // Crash before the tick job's completion is observed: the same tick runs again.
      await direct.db.update(schema.jobs).set({ status: 'PENDING', claimToken: null, runAfter: new Date(0) }).where(eq(schema.jobs.id, first.job!.id));
      const again = await work(clock.now, undefined, fresh.db);
      expect(again.tick).toMatchObject({ takeProfitsRequested: 0, targetsArmed: 0, trailingTightened: 0 });
      await drain(clock.now, fresh.db);
    } finally {
      await fresh.close();
    }
    let p = (await openPositionOf(A))!;
    expect(n(p.trailingWatermark)).toBe('67700');
    expect(n(p.trailingStopPrice)).toBe('67023'); // 67700 × 0.99, tightened from 66330
    let [, t2] = await targetsOf(p.id);
    expect([t2!.status, n(t2!.filledContracts), n(t2!.armedPrice)]).toEqual(['PENDING', '0', '67700']);
    expect(n(p.contracts)).toBe('77');

    // Another fresh worker sees the persisted arming: the pullback through tp2 closes exactly its 47.
    await tick('67500');
    const again = createDb(testDatabaseUrl(), 4);
    try {
      expect((await work(clock.now, undefined, again.db)).tick).toMatchObject({ takeProfitsRequested: 1, trailingTakeProfitsRequested: 0 });
      await drain(clock.now, again.db);
    } finally {
      await again.close();
    }
    p = (await openPositionOf(A))!;
    [, t2] = await targetsOf(p.id);
    expect([t2!.status, n(t2!.filledContracts)]).toEqual(['DONE', '47']);
    expect(n(p.contracts)).toBe('30');
    expect(n((await stopOf(p)).contracts)).toBe('30');
    expect((await exitsOf(p.id)).length).toBe(3);
  });

  it('the trailing level only tightens: a pull-back above it changes nothing', async () => {
    await tick('67300');
    await drain();
    const p = (await openPositionOf(A))!;
    expect(n(p.trailingWatermark)).toBe('67700');
    expect(n(p.trailingStopPrice)).toBe('67023');
    await expect(direct.pool.query(`UPDATE positions SET trailing_stop_price = 60000 WHERE id = $1`, [p.id])).rejects.toThrow(/only tightens/);
  });

  it('price back at the trailing level closes the remainder; zero confirmed, stop cleared', async () => {
    const id = (await openPositionOf(A))!.id;
    await tick('67000');
    const r = await drain();
    expect(r.find((x) => x.tick)?.tick).toMatchObject({ trailingTakeProfitsRequested: 1, trailingStopsRequested: 0 });
    const [p] = await positionsOf(A);
    expect(p).toMatchObject({ id, status: 'CLOSED', closeReason: 'TRAILING_TAKE_PROFIT', trailingKind: 'TAKE_PROFIT' });
    expect((await exitsOf(id)).map((x) => [x.reason, n(x.contracts), n(x.remainingContracts)])).toEqual([
      ['TAKE_PROFIT', '50', '103'],
      ['TAKE_PROFIT', '26', '77'],
      ['TAKE_PROFIT', '47', '30'],
      ['TRAILING_TAKE_PROFIT', '30', '0']
    ]);
    expect(p).toMatchObject({ trailingStatus: 'DONE' });
    expect(n(p!.trailingFilledContracts)).toBe('30');
    expect((await stopOf(p!)).status).toBe('CANCELLED');
    expect(await venue()).toEqual([{ side: 'LONG', contracts: '0' }]);
    const released = (await exitsOf(id)).reduce((s, x) => s.plus(x.marginReleased), D(0));
    expect(released.toFixed()).toBe(D('153').times('0.0001').times('65000.5').div(10).toDecimalPlaces(8, 0).toFixed());
    expect(await reconciled()).toBe(true);
  });

  it('the owner sees target progress and trailing state; another investor gets 404', async () => {
    const [p] = await positionsOf(A);
    const t = await call(trade.GET, { path: '/x', cookie: cookies.a, params: { id: p!.id } });
    expect(t.body.targets.map((x: any) => [x.levelId, x.status, x.plannedContracts, x.requestedContracts, x.filledContracts])).toEqual([
      ['tp1', 'DONE', '76', '102', '76'],
      ['tp2', 'DONE', '47', '47', '47']
    ]);
    expect(t.body.targets.every((x: any) => x.triggerRule === 'ARM_PULLBACK' && x.armedAt)).toBe(true);
    expect(t.body.trailing).toMatchObject({ kind: 'TAKE_PROFIT', status: 'DONE', watermark: '67700', level: '67023', basis: 'MARK', distancePct: '1', plannedContracts: '30', filledContracts: '30' });
    expect((await call(trade.GET, { path: '/x', cookie: cookies.b, params: { id: p!.id } })).status).toBe(404);
  });
});

describe('legacy Short position: the trailing stop from entry it was opened with keeps working (LAST basis)', () => {
  beforeAll(async () => {
    await openFromAlert({ side: 'SHORT', a: null, b: { takeProfit: { mode: 'OFF', levels: [] }, trailing: off } });
    await asLegacyTrailingStop((await openPositionOf(B))!.id, '1', 'LAST');
  });

  it('is active from entry: watermark = average entry, level above it', async () => {
    const p = (await openPositionOf(B))!;
    expect(p).toMatchObject({ side: 'SHORT', trailingStatus: 'ACTIVE', trailingKind: 'STOP', trailingActivationPrice: null });
    expect(n(p.trailingWatermark)).toBe('64999.5');
    expect(n(p.trailingStopPrice)).toBe('65649.5'); // 64999.5 × 1.01, rounded up
    expect(await targetsOf(p.id)).toHaveLength(0);
  });

  it('a lower last price lowers watermark and level; a mark-only move is ignored', async () => {
    await tick('64000', { mark: '66000', last: '64000' });
    await drain();
    let p = (await openPositionOf(B))!;
    expect(n(p.trailingWatermark)).toBe('64000');
    expect(n(p.trailingStopPrice)).toBe('64640');
    await tick('64500');
    await drain();
    p = (await openPositionOf(B))!;
    expect(n(p.trailingStopPrice)).toBe('64640'); // a bounce never loosens it
  });

  it('a rise to the level buys back the Short at the ask with a profit, recorded as the legacy TRAILING_STOP', async () => {
    await tick('64640');
    expect((await work()).tick).toMatchObject({ trailingStopsRequested: 1, trailingTakeProfitsRequested: 0 });
    await drain();
    const [p] = await positionsOf(B);
    expect(p).toMatchObject({ status: 'CLOSED', closeReason: 'TRAILING_STOP' });
    const [x] = await exitsOf(p!.id);
    expect(n(x!.price)).toBe('64640.5');
    expect(D(x!.realizedPnl).gt(0)).toBe(true);
    expect(await reconciled()).toBe(true);
  });
});

describe('competing exit triggers are serialised and cannot over-close or flip (legacy trailing stop: closes everything left)', () => {
  beforeAll(async () => {
    await openFromAlert({ a: { takeProfit: { mode: 'SPLIT', levels: [{ id: 'first', movePct: '2', closePct: '50' }, { id: 'second', movePct: '5', closePct: '50' }] } }, b: null });
    await asLegacyTrailingStop((await openPositionOf(A))!.id, '0.5', 'MARK');
  });

  it('a target close in flight; trailing, a manual close and a venue stop compete', async () => {
    const id = (await openPositionOf(A))!.id;
    await tick('66400'); // tp "first" reached (armed only); trailing level rises to 66068
    expect((await work()).tick).toMatchObject({ takeProfitsRequested: 0, targetsArmed: 1, trailingTightened: 1 });
    await tick('66200'); // pullback through "first" (66300.5), still above the trailing level
    expect((await work()).tick).toMatchObject({ takeProfitsRequested: 1, trailingStopsRequested: 0 });
    await holdCloses();
    await tick('66000'); // below the trailing level while the target close is still unsent
    expect((await work()).tick).toMatchObject({ trailingStopsRequested: 0, exitsWaiting: 1 });
    expect((await manualClose(cookies.a, id)).body.code).toBe('EXIT_IN_PROGRESS');
    await releaseCloses();

    // The target close fills; the scope is free and the same price triggers the trailing close.
    const closes = await drain();
    expect(closes[0]!.close).toMatchObject({ targetLevelId: 'first', state: 'FILLED', filled: '76', next: 'TRAILING_STOP' });
    expect(closes[1]!.close).toMatchObject({ exitReason: 'TRAILING_STOP', state: 'FILLED', filled: '77', closed: true });
    const [p] = await positionsOf(A);
    expect(p).toMatchObject({ status: 'CLOSED', closeReason: 'TRAILING_STOP' });
    const [first, second] = await targetsOf(id);
    expect([first!.status, second!.status]).toEqual(['DONE', 'CANCELLED']);
    const closed = (await exitsOf(id)).reduce((s, x) => s.plus(x.contracts), D(0));
    expect(closed.toFixed()).toBe('153'); // aggregate closing quantity capped at the position

    // The venue stop can still fire later: reduce-only with nothing left → nothing happens.
    await tick('63000');
    await drain();
    expect(await venue()).toEqual([{ side: 'LONG', contracts: '0' }]);
    expect((await direct.db.select().from(schema.positions).where(eq(schema.positions.side, 'SHORT'))).length).toBe(0);
    expect(await reconciled()).toBe(true);
  });

  it('target progress never moves backwards (database guard)', async () => {
    const [p] = await positionsOf(A);
    const [first] = await targetsOf(p!.id);
    await expect(direct.pool.query(`UPDATE position_targets SET filled_contracts = 0 WHERE id = $1`, [first!.id])).rejects.toThrow(/never decrease/);
    await expect(direct.pool.query(`UPDATE position_targets SET status = 'PENDING' WHERE id = $1`, [first!.id])).rejects.toThrow(/cannot reopen/);
  });

  it('a stop that wins the race against a pending target: the target is refused reduce-only, then cancelled', async () => {
    await openFromAlert({ a: { takeProfit: SPLIT, trailing: TRAIL('3', '1') }, b: null });
    const id = (await openPositionOf(A))!.id;
    await tick('66400'); // arms tp1
    expect((await work()).tick).toMatchObject({ takeProfitsRequested: 0, targetsArmed: 1 });
    await tick('66250'); // pullback through tp1
    expect((await work()).tick).toMatchObject({ takeProfitsRequested: 1 });
    await holdCloses();
    // Before the target close runs, a crash in price fills the venue stop.
    await tick('63000');
    expect((await work()).tick).toMatchObject({ stopsTriggered: 1, stopExitsRecorded: 1 });
    await releaseCloses();
    const r = await drain();
    const close = r.find((x) => x.close)!.close!;
    expect(close).toMatchObject({ targetLevelId: 'tp1', state: 'CANCELLED', reason: 'POSITION_ALREADY_FLAT' });
    const [p] = await positionsOf(A);
    expect(p).toMatchObject({ status: 'CLOSED', closeReason: 'STOP_LOSS' });
    expect((await targetsOf(id)).map((t) => t.status)).toEqual(['CANCELLED', 'CANCELLED']);
    expect((await exitsOf(id)).map((x) => [x.reason, n(x.contracts)])).toEqual([['STOP_LOSS', '153']]);
    expect(await venue()).toEqual([{ side: 'LONG', contracts: '0' }]);
    expect(await reconciled()).toBe(true);
  });
});
