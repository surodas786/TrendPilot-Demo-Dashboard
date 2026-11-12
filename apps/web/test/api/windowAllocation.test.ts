// Trading window (CFG-04), exit allocation between Take Profit and Trailing Take Profit, the
// arm-then-pullback take-profit rule (Long and Short), My Holdings chart data and isolation, and
// the 0019 conversion of saved blocks. Paper mode, deterministic fixture ticks.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { and, eq } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { schema, writeMarketFixture } from '@trendpilot/db';
import * as blocks from '@/app/v1/me/order-blocks/route';
import * as block from '@/app/v1/me/order-blocks/[id]/route';
import * as resume from '@/app/v1/me/order-blocks/[id]/resume/route';
import * as signals from '@/app/v1/me/signals/route';
import * as holdings from '@/app/v1/me/holdings/route';
import * as chart from '@/app/v1/me/holdings/[id]/chart/route';
import * as trade from '@/app/v1/me/trades/[id]/route';
import { setTestClock } from '@/server/clock';
import { BTC, blockBody, call, direct, teardown, USERS } from '../helpers';
import { ALL_DAYS, clock, cookies, D, deliver, drain, exitsOf, M15, n, openFromAlert, openPositionOf, plus, positionsOf, reconciled, stopOf, targetsOf, tick, work } from '../paperReplay';

const A = USERS.investorA.email;
const B = USERS.investorB.email;
/** Dhaka is UTC+6: 2026-11-08 is a Sunday, 2026-11-09 a Monday. */
const OVERNIGHT = { start: '22:00', end: '02:00' };
const decisionsOf = async (email: string) => {
  const rows = await direct.db.select().from(schema.signalDecisions).innerJoin(schema.users, eq(schema.users.id, schema.signalDecisions.ownerId)).where(eq(schema.users.email, email));
  return rows.map((r) => r.signal_decisions);
};
/** Opens from one alert whose bar closes at `closeUtc`, evaluated at `atUtc`. */
const alertAt = (closeUtc: string, atUtc: string, o: Parameters<typeof openFromAlert>[0] = {}) =>
  openFromAlert({ ...o, bar: new Date(new Date(closeUtc).getTime() - M15), at: new Date(atUtc) });

afterAll(async () => {
  setTestClock(null);
  await teardown();
});

describe('trading window: new entries only, evaluated and rechecked in the block timezone', () => {
  it('outside the window the entry is skipped as OUTSIDE_TRADING_WINDOW and the signal log says so; another investor is unaffected', async () => {
    // Sunday 15:30 Dhaka. A trades 22:00–02:00 only; B all day.
    await alertAt('2026-11-08T09:30:00Z', '2026-11-08T09:30:03Z', { a: { tradingWindow: OVERNIGHT }, b: {} });
    expect(await openPositionOf(A)).toBeUndefined();
    expect(await openPositionOf(B)).toBeDefined();
    const screen = (await decisionsOf(A)).find((d) => d.step !== 'ENTRY_V1')!;
    expect(screen).toMatchObject({ status: 'SKIPPED', reason: 'OUTSIDE_TRADING_WINDOW' });
    expect(screen.detail).toMatchObject({ reasonText: 'Outside trading window.' });
    const log = (await call(signals.GET, { path: '/x', cookie: cookies.a })).body.items;
    expect(log[0]).toMatchObject({ status: 'SKIPPED', reason: 'OUTSIDE_TRADING_WINDOW', reasonText: 'Outside trading window.' });
  });

  it('Start is inclusive: Sunday 22:00:00 opens', async () => {
    await alertAt('2026-11-08T16:00:00Z', '2026-11-08T16:00:00Z', { a: { tradingWindow: OVERNIGHT, weekdays: ['SUN'] }, b: null });
    expect(await openPositionOf(A)).toBeDefined();
  });

  it('after midnight the window still belongs to the day it started: Monday 01:00 opens on Sunday’s selection, not Monday’s', async () => {
    await alertAt('2026-11-08T19:00:00Z', '2026-11-08T19:00:03Z', { a: { tradingWindow: OVERNIGHT, weekdays: ['SUN'] }, b: { tradingWindow: OVERNIGHT, weekdays: ['MON'] } });
    expect(await openPositionOf(A)).toBeDefined();
    expect(await openPositionOf(B)).toBeUndefined();
    expect((await decisionsOf(B)).find((d) => d.step !== 'ENTRY_V1')).toMatchObject({ status: 'SKIPPED', reason: 'DAY_DISABLED' });
  });

  it('End is exclusive: Monday 02:00:00 is outside', async () => {
    await alertAt('2026-11-08T20:00:00Z', '2026-11-08T20:00:00Z', { a: { tradingWindow: OVERNIGHT, weekdays: ['SUN'] }, b: null });
    expect(await openPositionOf(A)).toBeUndefined();
    expect((await decisionsOf(A)).find((d) => d.step !== 'ENTRY_V1')).toMatchObject({ reason: 'OUTSIDE_TRADING_WINDOW' });
  });

  it('rechecked at submission: approved at 01:45:03, submitted at 01:50:00 (End) → cancelled, reservation released', async () => {
    await openFromAlert({ a: null, b: null });
    const w = { start: '22:00', end: '01:50' };
    const created = await call(blocks.POST, { method: 'POST', path: '/x', cookie: cookies.a, body: blockBody({ weekdays: ['SUN'], tradingWindow: w }) });
    expect(created.status).toBe(201);
    expect(created.body.tradingWindow).toEqual(w);
    await call(resume.POST, { method: 'POST', path: '/x', cookie: cookies.a, params: { id: created.body.id }, ifMatch: created.body.revision });
    const bar = new Date('2026-11-08T19:30:00Z'); // closes 19:45Z = Monday 01:45 Dhaka
    clock.now = new Date('2026-11-08T19:45:03Z');
    await writeMarketFixture(direct.db, { instrumentId: BTC, interval: '15', endBarOpen: bar, count: 260, endClose: '65000', trend: 'UP', quoteAt: clock.now });
    expect(await deliver('BULLISH_FLIP', bar)).toBe(202);
    const dispatch = await work(); // dispatch only: approve and reserve
    expect(dispatch.summary).toMatchObject({ entriesApproved: 1 });
    await tick('65000', { at: new Date('2026-11-08T19:50:00Z') }); // Monday 01:50:00 = End (exclusive)
    await drain();
    expect(await positionsOf(A)).toHaveLength(0);
    const [intent] = await direct.db.select().from(schema.orderIntents).where(eq(schema.orderIntents.kind, 'OPEN'));
    expect(intent).toMatchObject({ state: 'CANCELLED' });
    expect(intent!.stateReason).toMatch(/^OUTSIDE_TRADING_WINDOW at submission \(Mon 01:50 Asia\/Dhaka\)$/);
    const log = (await call(signals.GET, { path: '/x', cookie: cookies.a })).body.items;
    expect(log[0].entry).toMatchObject({ status: 'ENTRY_APPROVED', orderState: 'CANCELLED' });
    expect(log[0].entry.orderStateReason).toMatch(/^OUTSIDE_TRADING_WINDOW/);
    expect(await reconciled()).toBe(true);
  });

  it('outside the window the stop loss and a close signal still work', async () => {
    // Opened Monday 01:00 inside Sunday's window; everything below happens Monday afternoon.
    await alertAt('2026-11-08T19:00:00Z', '2026-11-08T19:00:03Z', { a: { tradingWindow: OVERNIGHT, weekdays: ['SUN'] }, b: { tradingWindow: OVERNIGHT, weekdays: ['SUN'] } });
    const pa = (await openPositionOf(A))!;
    expect(await openPositionOf(B)).toBeDefined();
    clock.now = new Date('2026-11-09T06:00:00Z'); // Monday 12:00 Dhaka
    await tick(D(pa.stopPrice).minus(5).toFixed(), { mark: D(pa.stopPrice).minus(5).toFixed(), last: '65000' }); // A: MARK stop; B: LAST stop untouched
    await drain();
    expect((await positionsOf(A))[0]).toMatchObject({ status: 'CLOSED', closeReason: 'STOP_LOSS' });
    // A close signal for B, Monday afternoon (outside the window).
    clock.now = new Date('2026-11-09T07:00:03Z');
    await tick('65000', { at: clock.now });
    expect(await deliver('CLOSE_LONG', new Date('2026-11-09T06:45:00Z'))).toBe(202);
    await drain();
    expect((await positionsOf(B))[0]).toMatchObject({ status: 'CLOSED', closeReason: 'SIGNAL_CLOSE' });
    expect(await reconciled()).toBe(true);
  });
});

describe('Position to close (%) on Trailing Take Profit: 0 %, 40 %, 100 % of the confirmed opening quantity', () => {
  const FIXED_TP = { mode: 'FIXED', levels: [{ id: 'tp1', movePct: '1', closePct: '100' }] };
  /** Activation far away so Trailing Take Profit never fires in these scenarios. */
  const TTP = (closePct: string) => ({ enabled: true, activationPct: '10', distancePct: '1', closePct, basis: 'MARK' });

  it('0 %: Take Profit manages the whole position; no trailing exit', async () => {
    await openFromAlert({ a: { takeProfit: FIXED_TP, trailing: TTP('0') }, b: null });
    const p = (await openPositionOf(A))!;
    expect([n(p.contracts), p.trailingStatus, n(p.trailingPlannedContracts)]).toEqual(['153', 'OFF', null]);
    expect((await targetsOf(p.id)).map((t) => n(t.plannedContracts))).toEqual(['153']);
  });

  it('100 %: Trailing Take Profit manages the whole position; no take-profit target', async () => {
    await openFromAlert({ a: { takeProfit: FIXED_TP, trailing: TTP('100') }, b: null });
    const p = (await openPositionOf(A))!;
    expect([p.trailingStatus, n(p.trailingPlannedContracts)]).toEqual(['WAITING', '153']);
    expect(await targetsOf(p.id)).toHaveLength(0);
    expect(p.takeProfitPrice).toBeNull();
  });

  it('40 % Long: 61 trail, 92 Take Profit; first touch arms, the pullback closes exactly 92; stop follows the remainder', async () => {
    await openFromAlert({ a: { takeProfit: FIXED_TP, trailing: TTP('40') }, b: null });
    const p0 = (await openPositionOf(A))!;
    expect(n(p0.trailingPlannedContracts)).toBe('61');
    const [t] = await targetsOf(p0.id);
    expect([n(t!.plannedContracts), n(t!.triggerPrice), t!.triggerRule]).toEqual(['92', '65650.5', 'ARM_PULLBACK']);

    await tick('65700'); // touch: arm only
    expect((await drain()).find((r) => r.tick)?.tick).toMatchObject({ targetsArmed: 1, takeProfitsRequested: 0 });
    expect(n((await openPositionOf(A))!.contracts)).toBe('153');
    await tick('65660'); // still above the target: nothing
    expect((await drain()).find((r) => r.tick)?.tick).toMatchObject({ takeProfitsRequested: 0 });
    await tick('65600'); // back through it
    const r = await drain();
    expect(r.find((x) => x.close)?.close).toMatchObject({ exitReason: 'TAKE_PROFIT', state: 'FILLED', filled: '92', remaining: '61' });
    const p = (await openPositionOf(A))!;
    expect(n(p.contracts)).toBe('61');
    expect(n(p.stopContracts)).toBe('61');
    expect(n((await stopOf(p)).contracts)).toBe('61');
    expect([p.protectionStatus, p.trailingStatus]).toEqual(['PROTECTED', 'WAITING']);
    // A repeat of the same move never closes the trailing share.
    await tick('65700');
    await tick('65600');
    await drain();
    expect((await exitsOf(p.id)).map((x) => n(x.contracts))).toEqual(['92']);
    expect(await reconciled()).toBe(true);
  });

  it('40 % Short (mirrored): the first touch below arms, the rise back above closes exactly 92', async () => {
    await openFromAlert({ side: 'SHORT', a: { takeProfit: FIXED_TP, trailing: TTP('40') }, b: null });
    const p0 = (await openPositionOf(A))!;
    const [t] = await targetsOf(p0.id);
    expect([p0.side, n(t!.plannedContracts), n(p0.trailingPlannedContracts)]).toEqual(['SHORT', '92', '61']);
    const target = D(t!.triggerPrice);
    await tick(target.minus(20).toFixed());
    expect((await drain()).find((r) => r.tick)?.tick).toMatchObject({ targetsArmed: 1, takeProfitsRequested: 0 });
    expect(n((await openPositionOf(A))!.contracts)).toBe('153');
    await tick(target.plus(20).toFixed());
    const r = await drain();
    expect(r.find((x) => x.close)?.close).toMatchObject({ exitReason: 'TAKE_PROFIT', filled: '92', remaining: '61' });
    const p = (await openPositionOf(A))!;
    expect([n(p.contracts), n(p.stopContracts)]).toEqual(['61', '61']);
    expect(await reconciled()).toBe(true);
  });

  it('Take Profit off with 40 %: the other 60 % stays open under the stop loss', async () => {
    await openFromAlert({ a: { takeProfit: { mode: 'OFF', levels: [] }, trailing: { ...TTP('40'), activationPct: '0.5', distancePct: '0.2' } }, b: null });
    const p0 = (await openPositionOf(A))!;
    expect(n(p0.trailingPlannedContracts)).toBe('61');
    await tick('65400'); // activates (65325.6)
    await tick('65250'); // pullback ≥ 0.2 % from 65400
    await drain();
    const p = (await openPositionOf(A))!;
    expect([n(p.contracts), p.trailingStatus, n(p.trailingFilledContracts)]).toEqual(['92', 'DONE', '61']);
    expect(n((await stopOf(p)).contracts)).toBe('92');
  });
});

describe('My Holdings: own positions only, chart lines for the exact contract', () => {
  it('chart data: TrendPilot candles of the position contract, average entry and current stop; others get 404', async () => {
    await openFromAlert({});
    const pa = (await openPositionOf(A))!;
    const pb = (await openPositionOf(B))!;
    const [inst] = await direct.db.select().from(schema.instruments).where(eq(schema.instruments.id, BTC));
    const c = await call(chart.GET, { path: '/x', cookie: cookies.a, params: { id: pa.id } });
    expect(c.status).toBe(200);
    expect(c.body).toMatchObject({ positionId: pa.id, exchange: inst!.exchange, exchangeSymbol: inst!.exchangeSymbol, interval: '15', status: 'OPEN' });
    expect(c.body.candles.length).toBeGreaterThan(50);
    expect(c.body.lines).toEqual([
      { kind: 'ENTRY', price: n(pa.avgEntryPrice), label: 'Avg entry', historical: false },
      { kind: 'STOP', price: n(pa.stopPrice), label: 'Stop loss', historical: false }
    ]);
    expect((await call(chart.GET, { path: '/x', cookie: cookies.b, params: { id: pa.id } })).status).toBe(404);
    expect((await call(chart.GET, { path: '/x', cookie: cookies.admin, params: { id: pa.id } })).status).toBe(403);
    // Holdings lists only the caller's own positions, with the contract identity.
    const hb = (await call(holdings.GET, { path: '/x', cookie: cookies.b })).body.positions;
    expect(hb.map((h: { id: string }) => h.id)).toEqual([pb.id]);
    expect(hb[0]).toMatchObject({ exchange: inst!.exchange, exchangeSymbol: inst!.exchangeSymbol, pair: `${inst!.base}/${inst!.quote}` });
    // The detail links the opening signal.
    const t = (await call(trade.GET, { path: '/x', cookie: cookies.a, params: { id: pa.id } })).body;
    expect(t.signals).toEqual([expect.objectContaining({ role: 'OPEN', action: 'BULLISH_FLIP', interval: '15' })]);
  });

  it('a closed position keeps its last recorded stop, labelled historical; a closing signal is linked', async () => {
    const pa = (await openPositionOf(A))!;
    clock.now = plus(clock.now, 900);
    await tick('65100', { at: clock.now });
    expect(await deliver('CLOSE_LONG', new Date(clock.now.getTime() - M15 - 3000))).toBe(202);
    await drain();
    const c = (await call(chart.GET, { path: '/x', cookie: cookies.a, params: { id: pa.id } })).body;
    expect(c.status).toBe('CLOSED');
    expect(c.lines[1]).toEqual({ kind: 'STOP', price: n(pa.stopPrice), label: 'Stop loss (historical)', historical: true });
    const t = (await call(trade.GET, { path: '/x', cookie: cookies.a, params: { id: pa.id } })).body;
    expect(t.signals.map((s: { role: string; action: string }) => [s.role, s.action])).toEqual([
      ['OPEN', 'BULLISH_FLIP'],
      ['CLOSE', 'CLOSE_LONG']
    ]);
    expect(t.exits[0]).toMatchObject({ reason: 'SIGNAL_CLOSE', signalEventId: t.signals[1].eventId });
  });
});

describe('migration 0019 converts saved blocks without changing their effective allocation', () => {
  const sql = readFileSync(path.resolve(__dirname, '../../../../packages/db/migrations/0019_m9_window_alloc_arming.sql'), 'utf8');
  const dataSteps = sql
    .split('--> statement-breakpoint')
    .map((x) => x.replace(/^\s*--.*$/gm, '').trim())
    .filter((x) => x.startsWith('UPDATE') || x.startsWith('WITH'));

  it('Fixed 60 % + trailing → trailing 40 %; Split 50/30 + trailing → 62.5/37.5 and trailing 20 %', async () => {
    await openFromAlert({ a: null, b: null });
    const old = { enabled: true, activationPct: '0.3', distancePct: '0.1', basis: 'MARK' };
    const make = async (cookie: string, instrumentId: string | undefined, takeProfit: unknown, trailing: unknown) => {
      const created = await call(blocks.POST, { method: 'POST', path: '/x', cookie, body: blockBody({ weekdays: ALL_DAYS, ...(instrumentId ? { instrumentId } : {}) }) });
      expect(created.status).toBe(201);
      await direct.db.update(schema.orderBlocks).set({ takeProfit, trailing }).where(eq(schema.orderBlocks.id, created.body.id));
      return created.body.id as string;
    };
    const fixed = await make(cookies.a, undefined, { mode: 'FIXED', levels: [{ id: 'x', movePct: '3', closePct: '60' }] }, old);
    const split = await make(cookies.b, undefined, { mode: 'SPLIT', levels: [{ id: 'a', movePct: '2', closePct: '50' }, { id: 'b', movePct: '4', closePct: '30' }] }, old);
    expect(dataSteps.length).toBe(3);
    for (const stmt of dataSteps) await direct.pool.query(stmt);
    const get = async (cookie: string, id: string) => (await call(block.GET, { path: '/x', cookie, params: { id } })).body;
    expect(await get(cookies.a, fixed)).toMatchObject({ takeProfit: { levels: [{ closePct: '100' }] }, trailing: { closePct: '40' }, tradingWindow: null });
    expect(await get(cookies.b, split)).toMatchObject({ takeProfit: { levels: [{ closePct: '62.5' }, { closePct: '37.5' }] }, trailing: { closePct: '20' } });
    // Both now pass the current rules unchanged (an unrelated edit saves).
    for (const [cookie, id] of [[cookies.a, fixed], [cookies.b, split]] as const) {
      const b = await get(cookie, id);
      const r = await call(block.PATCH, { method: 'PATCH', path: '/x', cookie, params: { id }, ifMatch: b.revision, body: { orderCostUsdt: '90' } });
      expect(r.status).toBe(200);
    }
    const rows = await direct.db.select().from(schema.orderBlocks).where(and(eq(schema.orderBlocks.id, fixed)));
    expect(rows[0]!.tradingWindowStart).toBeNull();
  });
});
