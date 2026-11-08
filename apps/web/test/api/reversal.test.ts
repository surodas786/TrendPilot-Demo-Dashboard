// M2 slice 4: CLOSE_AND_REVERSE (STR-06, AT-05, AT-09). The close goes first; the opposite entry
// is evaluated only from a confirmed flat state, with fresh eligibility, and attaches a new stop
// in the same simulated request. Deterministic fixture prices and a controlled clock.
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { schema, triggerStops } from '@trendpilot/db';
import * as block from '@/app/v1/me/order-blocks/[id]/route';
import * as pause from '@/app/v1/me/order-blocks/[id]/pause/route';
import * as trade from '@/app/v1/me/trades/[id]/route';
import * as signals from '@/app/v1/me/signals/route';
import { setTestClock } from '@/server/clock';
import { BTC, call, direct, teardown, userId, USERS, VERSION } from '../helpers';
import { clock, cookies, D, deliver, drain, M15, n, openFromAlert, openPositionOf, plus, positionsOf, publishVersion, reconciled, stopOf, tick, venue, work } from '../paperReplay';

const A = USERS.investorA.email;
const B = USERS.investorB.email;
const BAR = new Date('2026-11-08T09:15:00Z');
const NEXT = new Date(BAR.getTime() + M15); // the flip bar
const reverseVersion = (o: Record<string, unknown> = {}) => () => publishVersion({ oppositePolicy: 'CLOSE_AND_REVERSE', ...o });

const entryDecisions = async (email: string) =>
  direct.db
    .select()
    .from(schema.signalDecisions)
    .where(and(eq(schema.signalDecisions.ownerId, await userId(email)), eq(schema.signalDecisions.step, 'ENTRY_V1')))
    .orderBy(schema.signalDecisions.evaluatedAt);
const count = async (q: ReturnType<typeof sql>) => Number(((await direct.db.execute(q)).rows[0] as { n: string }).n);

/** The bearish flip on the next bar, at its close + 3 s, with a fresh quote. */
async function flipBearish(o: { liquidity?: string } = {}) {
  clock.now = plus(new Date(NEXT.getTime() + M15), 3);
  await tick('64900', { at: clock.now, liquidity: o.liquidity });
  expect((await work()).tick).toBeTruthy(); // the price first, then the alert
  expect(await deliver('BEARISH_FLIP', NEXT)).toBe(202);
}

afterAll(async () => {
  setTestClock(null);
  await teardown();
});

describe('successful close-then-open', () => {
  it('closes the Long first, confirms flat, then opens a protected Short; B (KEEP_OPEN) is untouched', async () => {
    await openFromAlert({ version: reverseVersion(), b: { strategyVersionId: VERSION } });
    const longA = (await openPositionOf(A))!;
    await flipBearish();
    const dispatch = (await work()).summary!;
    expect(dispatch).toMatchObject({ exitsRequested: 1, reversalsPending: 1, entriesApproved: 0 });
    // The opposite entry is not evaluated while the Long is open.
    expect((await entryDecisions(A)).length).toBe(1);

    const r = await drain();
    expect(r.map((x) => (x.close ? `close:${x.close.state}` : x.reverse ? `reverse:${x.reverse.outcome}` : x.submit ? `submit:${x.submit.state}` : x.job?.kind))).toEqual([
      'close:FILLED',
      'reverse:ENTRY_APPROVED',
      'submit:FILLED'
    ]);
    const [oldLong, short] = await positionsOf(A);
    expect(oldLong).toMatchObject({ id: longA.id, side: 'LONG', status: 'CLOSED', closeReason: 'REVERSAL_CLOSE' });
    expect(n(oldLong!.contracts)).toBe('0');
    expect((await stopOf(oldLong!)).status).toBe('CANCELLED'); // old protection removed before the new leg
    expect(short).toMatchObject({ side: 'SHORT', status: 'OPEN', protectionStatus: 'PROTECTED' });
    expect(short!.openedAt.getTime()).toBeGreaterThanOrEqual(oldLong!.closedAt!.getTime());

    // The new stop was attached in the same simulated request as the reversal entry.
    const [openOrder] = await direct.db.select().from(schema.simOrders).where(eq(schema.simOrders.clientOrderId, `tp-${(await entryDecisions(A))[1]!.id}`));
    const newStop = await stopOf(short!);
    expect(newStop).toMatchObject({ status: 'ACTIVE', reduceOnly: true, side: 'LONG', parentOrderId: openOrder!.id });
    expect(D(newStop.triggerPrice!).gt(short!.avgEntryPrice)).toBe(true);
    expect(n(newStop.contracts)).toBe(n(short!.contracts));

    expect((await entryDecisions(A))[1]).toMatchObject({ status: 'ENTRY_APPROVED' });
    expect((await entryDecisions(A))[1]!.detail).toMatchObject({ reversal: true, fromPositionId: longA.id, fromSide: 'LONG', closeState: 'FILLED' });
    expect((await openPositionOf(B))!).toMatchObject({ side: 'LONG', status: 'OPEN' });
    expect(await venue()).toEqual(expect.arrayContaining([{ side: 'SHORT', contracts: n(short!.contracts) }]));
    expect(await reconciled()).toBe(true);
  });

  it('the owner sees the reversal outcome on both trades and in Signals', async () => {
    const [oldLong, short] = await positionsOf(A);
    const t = (await call(trade.GET, { path: '/x', cookie: cookies.a, params: { id: oldLong!.id } })).body;
    expect(t.reversal).toMatchObject({ status: 'ENTRY_APPROVED', side: 'SHORT', positionId: short!.id, orderState: 'FILLED' });
    const s = (await call(trade.GET, { path: '/x', cookie: cookies.a, params: { id: short!.id } })).body;
    expect(s.reversedFromPositionId).toBe(oldLong!.id);
    const outcome = (await call(signals.GET, { path: '/x', cookie: cookies.a })).body.items.find((o: any) => o.signal.action === 'BEARISH_FLIP');
    expect(outcome.exit).toMatchObject({ status: 'EXIT_REQUESTED', reason: 'REVERSAL_CLOSE', orderState: 'FILLED' });
    expect(outcome.entry).toMatchObject({ status: 'ENTRY_APPROVED', orderState: 'FILLED', positionId: short!.id });
    expect((await call(trade.GET, { path: '/x', cookie: cookies.b, params: { id: short!.id } })).status).toBe(404);
  });

  it('replaying the same event, re-running dispatch and the reversal job create no duplicate fill or entry', async () => {
    const before = {
      fills: await count(sql`SELECT count(*) AS n FROM fills`),
      opens: await count(sql`SELECT count(*) AS n FROM sim_orders WHERE kind = 'MARKET_OPEN'`),
      positions: await count(sql`SELECT count(*) AS n FROM positions`)
    };
    expect(await deliver('BEARISH_FLIP', NEXT)).toBe(200); // duplicate alert
    await direct.db
      .update(schema.jobs)
      .set({ status: 'PENDING', claimToken: null, runAfter: new Date(0) })
      .where(sql`${schema.jobs.kind} IN ('signal.dispatch', 'paper.close', 'paper.reverse', 'paper.submit')`);
    await Promise.all([work(), work(), work()]);
    await drain();
    expect(await count(sql`SELECT count(*) AS n FROM fills`)).toBe(before.fills);
    expect(await count(sql`SELECT count(*) AS n FROM sim_orders WHERE kind = 'MARKET_OPEN'`)).toBe(before.opens);
    expect(await count(sql`SELECT count(*) AS n FROM positions`)).toBe(before.positions);
    expect((await entryDecisions(A)).length).toBe(2);
    expect(await reconciled()).toBe(true);
  });

  it('a reverse position never coexists with the old one at the venue', async () => {
    const [v] = (await venue()).filter((x) => x.side === 'SHORT');
    const [, short] = await positionsOf(A);
    expect(v!.contracts).toBe(n(short!.contracts)); // net venue exposure is the Short only
  });
});

describe('an incomplete close cannot reverse', () => {
  it('a partial close keeps the remainder open and protected and withholds the opposite entry', async () => {
    await openFromAlert({ version: reverseVersion(), b: null });
    await flipBearish({ liquidity: '100' });
    const r = await drain();
    expect(r.find((x) => x.close)?.close).toMatchObject({ state: 'EXPIRED', filled: '100', remaining: '53', reversalQueued: true });
    expect(r.find((x) => x.reverse)?.reverse).toMatchObject({ outcome: 'WITHHELD', reason: 'REVERSAL_CLOSE_INCOMPLETE' });
    const [p, ...rest] = await positionsOf(A);
    expect(rest).toHaveLength(0);
    expect(p).toMatchObject({ side: 'LONG', status: 'OPEN', protectionStatus: 'PROTECTED' });
    expect(n(p!.contracts)).toBe('53');
    expect(n((await stopOf(p!)).contracts)).toBe('53');
    const [, withheld] = await entryDecisions(A);
    expect(withheld).toMatchObject({ status: 'SKIPPED', reason: 'REVERSAL_CLOSE_INCOMPLETE' });
    expect(withheld!.detail).toMatchObject({ reversal: true, remainingContracts: '53', closeState: 'EXPIRED' });
    // The next price does not open it later either.
    await tick('64900');
    await drain();
    expect((await positionsOf(A)).length).toBe(1);
    expect(await reconciled()).toBe(true);
  });

  it('an uncertain close (the venue stop flattened first, close refused) also withholds it', async () => {
    await openFromAlert({ version: reverseVersion(), b: null });
    await flipBearish();
    expect((await work()).summary).toMatchObject({ reversalsPending: 1 });
    await triggerStops(direct.db, BTC, { bid: '63999.5', ask: '64000.5', mark: '64000', last: '64000' }, clock.now); // venue only
    const r = await drain();
    expect(r.find((x) => x.close)?.close).toMatchObject({ state: 'REJECTED', reason: 'REDUCE_ONLY_NO_POSITION', reversalQueued: true });
    expect(r.find((x) => x.reverse)?.reverse).toMatchObject({ outcome: 'WITHHELD', reason: 'REVERSAL_CLOSE_INCOMPLETE' });
    await tick('64000'); // the platform then records the venue stop
    await drain();
    const all = await positionsOf(A);
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ status: 'CLOSED', closeReason: 'STOP_LOSS' });
    expect(await venue()).toEqual([{ side: 'LONG', contracts: '0' }]);
  });
});

describe('fresh eligibility for the opening leg', () => {
  it('a close that crosses local midnight into a disabled day closes, then stays flat (DAY_DISABLED)', async () => {
    // Saturday in Asia/Dhaka (UTC+6); Sunday disabled for A. A one-hour signal expiry so only the weekday decides.
    const satBar = new Date('2026-11-07T17:15:00Z'); // 23:15 Saturday local
    await openFromAlert({
      bar: satBar,
      version: reverseVersion({ signalMaxAgeSeconds: 3600 }),
      a: { weekdays: ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'] },
      b: null
    });
    expect((await openPositionOf(A))!.side).toBe('LONG');
    const flipBar = new Date('2026-11-07T17:30:00Z'); // closes 17:45Z = 23:45 Saturday local
    clock.now = new Date('2026-11-07T17:45:03Z');
    await tick('64900', { at: clock.now });
    expect((await work()).tick).toBeTruthy();
    expect(await deliver('BEARISH_FLIP', flipBar)).toBe(202);
    expect((await work()).summary).toMatchObject({ exitsRequested: 1, reversalsPending: 1 }); // dispatched on Saturday

    // The close executes after local midnight (00:00:05 Sunday).
    await tick('64950', { at: new Date('2026-11-07T18:00:05Z') });
    const r = await drain();
    expect(r.find((x) => x.close)?.close).toMatchObject({ state: 'FILLED', closed: true });
    expect(r.find((x) => x.reverse)?.reverse).toMatchObject({ outcome: 'SKIPPED', reason: 'DAY_DISABLED' });
    const all = await positionsOf(A);
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ status: 'CLOSED', closeReason: 'REVERSAL_CLOSE' });
    const [, skipped] = await entryDecisions(A);
    expect(skipped).toMatchObject({ status: 'SKIPPED', reason: 'DAY_DISABLED' });
    expect(skipped!.detail).toMatchObject({ reversal: true, failedChecks: ['DAY_DISABLED'] });
    expect(await venue()).toEqual([{ side: 'LONG', contracts: '0' }]);
    expect(await reconciled()).toBe(true);
  });

  it('a pause after the flip still closes (exit), but the opposite entry is skipped (PAUSED)', async () => {
    const blocks = await openFromAlert({ version: reverseVersion(), b: null });
    await flipBearish();
    expect((await work()).summary).toMatchObject({ reversalsPending: 1 });
    const cur = (await call(block.GET, { path: '/x', cookie: cookies.a, params: { id: blocks.a.id } })).body;
    expect((await call(pause.POST, { method: 'POST', path: '/x', cookie: cookies.a, params: { id: blocks.a.id }, ifMatch: cur.revision })).status).toBe(200);
    const r = await drain();
    expect(r.find((x) => x.reverse)?.reverse).toMatchObject({ outcome: 'SKIPPED', reason: 'PAUSED' });
    expect((await positionsOf(A)).map((p) => [p.side, p.status])).toEqual([['LONG', 'CLOSED']]);
  });

  it('an expired signal by the time the close is confirmed: stays flat (SIGNAL_STALE)', async () => {
    await openFromAlert({ version: reverseVersion(), b: null });
    await flipBearish();
    expect((await work()).summary).toMatchObject({ reversalsPending: 1 });
    await tick('64900', { at: plus(clock.now, 180) }); // the close is processed 3 minutes later (expiry 120 s)
    const r = await drain();
    expect(r.find((x) => x.reverse)?.reverse).toMatchObject({ outcome: 'SKIPPED', reason: 'SIGNAL_STALE' });
    expect((await positionsOf(A)).filter((p) => p.status === 'OPEN')).toHaveLength(0);
  });
});

