// M2 slice 3: paper exits — stop loss, fixed TP, signal close, manual close (EXT-01/02/05/06/07,
// STR-03/04/05, ARC-02). Deterministic fixture ticks and a controlled clock.
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { processNextJob, recordMarketTick, schema, triggerStops, writeMarketFixture } from '@trendpilot/db';
import { buildTradingViewPayload, Decimal, PAPER_TEMPLATE, type SignalAction } from '@trendpilot/domain';
import * as webhook from '@/app/v1/webhooks/tradingview/[ingressToken]/route';
import * as blocks from '@/app/v1/me/order-blocks/route';
import * as block from '@/app/v1/me/order-blocks/[id]/route';
import * as pause from '@/app/v1/me/order-blocks/[id]/pause/route';
import * as resume from '@/app/v1/me/order-blocks/[id]/resume/route';
import * as closePos from '@/app/v1/me/positions/[id]/close/route';
import * as command from '@/app/v1/me/commands/[id]/route';
import * as trade from '@/app/v1/me/trades/[id]/route';
import * as signals from '@/app/v1/me/signals/route';
import * as packages from '@/app/v1/admin/strategy-packages/route';
import * as versions from '@/app/v1/admin/strategy-packages/[id]/versions/route';
import * as publish from '@/app/v1/admin/strategy-versions/[id]/publish/route';
import { setTestClock } from '@/server/clock';
import { BTC, blockBody, call, direct, resetAndSeed, signIn, teardown, userId, USERS, VERSION } from '../helpers';

const TOKEN = process.env.DEV_INGRESS_TOKEN!;
const M15 = 15 * 60_000;
const BAR = new Date('2026-11-08T09:15:00Z'); // Sunday in Asia/Dhaka
const AT = new Date('2026-11-08T09:30:03Z');
const plus = (d: Date, s: number) => new Date(d.getTime() + s * 1000);
const ALL = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
const M = '0.0001'; // BTCUSDT contract size (fixture)

let clock = AT;
let a = '';
let b = '';
let admin = '';
let aBlock: any;
let bBlock: any;

const deliver = async (action: SignalAction, barOpen = BAR) => {
  const raw = JSON.stringify(
    buildTradingViewPayload({ action, exchange: 'MEXC', symbol: 'BTCUSDT.P', interval: '15', barOpen, firedAt: plus(new Date(barOpen.getTime() + M15), 1), referencePrice: '65000.5' })
  );
  const res = await webhook.POST(new Request(`http://localhost/v1/webhooks/tradingview/${TOKEN}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: raw }), {
    params: Promise.resolve({ ingressToken: TOKEN })
  });
  return res.status;
};
const work = (now = clock, hooks?: Parameters<typeof processNextJob>[1]['hooks']) => processNextJob(direct.db, { workerId: 'test', now, hooks });
async function drain(now = clock) {
  const out = [];
  for (let i = 0; i < 30; i++) {
    const r = await work(now);
    if (r.outcome === 'IDLE') break;
    out.push(r);
  }
  return out;
}
/** A replayed price at `at` (the clock moves there). */
async function tick(mid: string, o: { mark?: string; last?: string; liquidity?: string; at?: Date } = {}) {
  clock = o.at ?? plus(clock, 10);
  await recordMarketTick(direct.db, {
    instrumentId: BTC,
    asOf: clock,
    bid: new Decimal(mid).minus('0.5').toFixed(),
    ask: new Decimal(mid).plus('0.5').toFixed(),
    mark: o.mark ?? mid,
    last: o.last ?? mid,
    liquidityContracts: o.liquidity ?? null
  });
}
const positionOf = async (email: string) => (await direct.db.select().from(schema.positions).where(eq(schema.positions.ownerId, await userId(email))))[0]!;
const exitsOf = async (positionId: string) => direct.db.select().from(schema.positionExits).where(eq(schema.positionExits.positionId, positionId));
const accountOf = async (email: string) => (await direct.db.select().from(schema.paperAccounts).where(eq(schema.paperAccounts.ownerId, await userId(email))))[0]!;
const ledgerCount = async (email: string, kind: string) =>
  (await direct.db.select().from(schema.ledgerEntries).where(and(eq(schema.ledgerEntries.ownerId, await userId(email)), eq(schema.ledgerEntries.kind, kind)))).length;
const reconciled = async () => {
  const r = await direct.db.execute(sql`SELECT * FROM paper_account_reconciliation`);
  return (r.rows as any[]).every((x) => new Decimal(x.wallet_balance).eq(x.ledger_wallet) && new Decimal(x.position_margin).eq(x.ledger_position_margin) && new Decimal(x.order_reserve).eq(x.ledger_order_reserve));
};
const venue = async () => (await direct.db.select().from(schema.simPositions)).map((v) => ({ side: v.side, contracts: new Decimal(v.contracts).toFixed() }));
const manualClose = (cookie: string, id: string, key: string | null = `key-${Math.random().toString(36).slice(2)}`) =>
  call(closePos.POST, { method: 'POST', path: '/x', cookie, params: { id }, headers: key ? { 'idempotency-key': key } : {} });

async function publishVersion(o: Record<string, unknown>): Promise<string> {
  const pkgs = await call(packages.GET, { path: '/x', cookie: admin });
  const pkgId = pkgs.body.items.find((p: any) => p.versions.some((v: any) => v.id === VERSION)).id;
  const d = await call(versions.POST, { method: 'POST', path: '/x', cookie: admin, params: { id: pkgId }, body: { ...PAPER_TEMPLATE, instrumentIds: [BTC], ...o } });
  const p = await call(publish.POST, { method: 'POST', path: '/x', cookie: admin, params: { id: d.body.id }, ifMatch: d.body.revision });
  return p.body.id;
}

/**
 * Fresh DB, both investors open a paper position on BTCUSDT from one shared alert.
 * A: 100 USDT ×10, stop 1.5 %, TP 3 %. B: 50 USDT ×5, stop 3 % (LAST basis), TP 6 %.
 */
async function openBoth(o: { side?: 'LONG' | 'SHORT'; aVersion?: (admin: string) => Promise<string>; aOverrides?: Record<string, unknown> } = {}) {
  await resetAndSeed();
  clock = AT;
  setTestClock(() => clock);
  a = await signIn(USERS.investorA.email);
  b = await signIn(USERS.investorB.email);
  admin = await signIn(USERS.admin.email);
  const tp = (movePct: string) => ({ mode: 'FIXED', levels: [{ id: 'tp1', movePct, closePct: '100' }] });
  const aVersion = o.aVersion ? await o.aVersion(admin) : VERSION;
  aBlock = (await call(blocks.POST, { method: 'POST', path: '/x', cookie: a, body: blockBody({ strategyVersionId: aVersion, orderCostUsdt: '100', leverage: 10, weekdays: ALL, takeProfit: tp('3'), ...o.aOverrides }) })).body;
  bBlock = (
    await call(blocks.POST, {
      method: 'POST',
      path: '/x',
      cookie: b,
      body: blockBody({ orderCostUsdt: '50', leverage: 5, weekdays: ALL, takeProfit: tp('6'), stop: { type: 'PERCENT', value: '3', basis: 'LAST' } })
    })
  ).body;
  aBlock = (await call(resume.POST, { method: 'POST', path: '/x', cookie: a, params: { id: aBlock.id }, ifMatch: aBlock.revision })).body;
  bBlock = (await call(resume.POST, { method: 'POST', path: '/x', cookie: b, params: { id: bBlock.id }, ifMatch: bBlock.revision })).body;
  await writeMarketFixture(direct.db, { instrumentId: BTC, interval: '15', endBarOpen: BAR, count: 260, endClose: '65000', trend: o.side === 'SHORT' ? 'DOWN' : 'UP', quoteAt: AT });
  expect(await deliver(o.side === 'SHORT' ? 'BEARISH_FLIP' : 'BULLISH_FLIP')).toBe(202);
  await drain();
  expect((await direct.db.select().from(schema.positions)).length).toBe(2);
}

afterAll(async () => {
  setTestClock(null);
  await teardown();
});

describe('fixed TP: two investors, different targets — only A closes', () => {
  beforeAll(() => openBoth());

  it('positions carry their saved TP targets from the confirmed fill', async () => {
    const pa = await positionOf(USERS.investorA.email);
    const pb = await positionOf(USERS.investorB.email);
    expect(new Decimal(pa.takeProfitPrice!).toFixed()).toBe('66950.5'); // 65000.5 × 1.03, toward entry
    expect(new Decimal(pb.takeProfitPrice!).toFixed()).toBe('68900.5'); // 65000.5 × 1.06
  });

  it('a price reaching only A\'s target closes A at market; B stays open with stop coverage', async () => {
    await tick('67000');
    const results = await drain();
    expect(results.find((r) => r.tick)?.tick).toMatchObject({ takeProfitsRequested: 1, stopsTriggered: 0 });
    expect(results.find((r) => r.close)?.close).toMatchObject({ state: 'FILLED', closed: true, filled: '153', remaining: '0' });

    const pa = await positionOf(USERS.investorA.email);
    expect(pa).toMatchObject({ status: 'CLOSED', closeReason: 'TAKE_PROFIT' });
    expect(new Decimal(pa.contracts).toFixed()).toBe('0');
    const [x] = await exitsOf(pa.id);
    const pnl = new Decimal('66999.5').minus('65000.5').times('153').times(M);
    const fee = new Decimal('153').times(M).times('66999.5').times('0.0004').toDecimalPlaces(8, Decimal.ROUND_UP);
    expect(x).toMatchObject({ reason: 'TAKE_PROFIT' });
    expect(new Decimal(x!.price).toFixed()).toBe('66999.5'); // a Long closes at the bid
    expect(new Decimal(x!.realizedPnl).toFixed()).toBe(pnl.toFixed());
    expect(new Decimal(x!.fee).toFixed()).toBe(fee.toFixed());
    expect(new Decimal(x!.marginReleased).toFixed()).toBe(new Decimal('153').times(M).times('65000.5').div(10).toDecimalPlaces(8, Decimal.ROUND_UP).toFixed());
    const acctA = await accountOf(USERS.investorA.email);
    expect(new Decimal(acctA.positionMargin).toFixed()).toBe('0');

    const pb = await positionOf(USERS.investorB.email);
    expect(pb).toMatchObject({ status: 'OPEN', protectionStatus: 'PROTECTED' });
    expect(new Decimal(pb.stopContracts!).eq(pb.contracts)).toBe(true);
    const [stopB] = await direct.db.select().from(schema.simOrders).where(eq(schema.simOrders.clientOrderId, pb.stopOrderRef!));
    expect(stopB).toMatchObject({ status: 'ACTIVE', reduceOnly: true });
    // A's stop was cleared only after the venue confirmed zero.
    const [stopA] = await direct.db.select().from(schema.simOrders).where(eq(schema.simOrders.clientOrderId, pa.stopOrderRef!));
    expect(stopA!.status).toBe('CANCELLED');
    expect(await reconciled()).toBe(true);
  });

  it('the owner sees reason, remaining quantity and realized P&L; B cannot see A\'s trade', async () => {
    const pa = await positionOf(USERS.investorA.email);
    const t = await call(trade.GET, { path: '/x', cookie: a, params: { id: pa.id } });
    expect(t.body).toMatchObject({ status: 'CLOSED', closeReason: 'TAKE_PROFIT', contracts: '0', initialContracts: '153', mode: 'PAPER' });
    expect(t.body.exits).toHaveLength(1);
    expect(t.body.exits[0]).toMatchObject({ reason: 'TAKE_PROFIT', contracts: '153', remainingContracts: '0' });
    expect(new Decimal(t.body.netRealizedUsdt).toFixed()).toBe(new Decimal(pa.realizedPnlUsdt).minus(pa.feesUsdt).toFixed());
    expect(t.body.ledger.map((l: any) => l.kind)).toEqual(expect.arrayContaining(['REALIZED_PNL', 'POSITION_MARGIN_RELEASE', 'TRADING_FEE']));
    expect((await call(trade.GET, { path: '/x', cookie: b, params: { id: pa.id } })).status).toBe(404);
  });

  it('the same price again does nothing more', async () => {
    await tick('67000');
    await drain();
    expect(await exitsOf((await positionOf(USERS.investorA.email)).id)).toHaveLength(1);
    expect((await positionOf(USERS.investorB.email)).status).toBe('OPEN');
  });
});

describe('stop loss on each position\'s saved trigger basis (Long)', () => {
  beforeAll(() => openBoth());

  it('mark crosses A\'s MARK stop but B\'s LAST stop is untouched by the last price', async () => {
    // A stop 64025.5 (MARK). B stop 63050.5 (LAST). Mark 63000 crosses both levels; last 64000 crosses neither for B.
    await tick('64000', { mark: '63000', last: '64000' });
    const results = await drain();
    expect(results.find((r) => r.tick)?.tick).toMatchObject({ stopsTriggered: 1, stopExitsRecorded: 1, takeProfitsRequested: 0 });
    const pa = await positionOf(USERS.investorA.email);
    expect(pa).toMatchObject({ status: 'CLOSED', closeReason: 'STOP_LOSS' });
    const [x] = await exitsOf(pa.id);
    expect(new Decimal(x!.price).toFixed()).toBe('63999.5'); // stop market sells at the bid
    expect(new Decimal(x!.realizedPnl).lt(0)).toBe(true);
    expect(x!.intentId).toBeNull(); // venue-triggered, no platform order
    expect((await positionOf(USERS.investorB.email)).status).toBe('OPEN');
  });

  it('then the last price reaches B\'s LAST stop', async () => {
    await tick('63000');
    await drain();
    const pb = await positionOf(USERS.investorB.email);
    expect(pb).toMatchObject({ status: 'CLOSED', closeReason: 'STOP_LOSS' });
    expect(await venue()).toEqual(expect.arrayContaining([{ side: 'LONG', contracts: '0' }]));
    expect(await reconciled()).toBe(true);
  });
});

describe('Short: TP below entry, stop above entry', () => {
  beforeAll(() => openBoth({ side: 'SHORT' }));

  it('a price at A\'s short target closes A at the ask; B (6 %) stays open', async () => {
    const pa0 = await positionOf(USERS.investorA.email);
    expect(pa0.side).toBe('SHORT');
    expect(new Decimal(pa0.takeProfitPrice!).toFixed()).toBe('63049.6'); // 64999.5 × 0.97, toward entry
    await tick('63000');
    await drain();
    const pa = await positionOf(USERS.investorA.email);
    expect(pa).toMatchObject({ status: 'CLOSED', closeReason: 'TAKE_PROFIT' });
    const [x] = await exitsOf(pa.id);
    expect(new Decimal(x!.price).toFixed()).toBe('63000.5'); // closing a Short buys at the ask
    expect(new Decimal(x!.realizedPnl).toFixed()).toBe(new Decimal('64999.5').minus('63000.5').times(pa.initialContracts).times(M).toFixed());
    expect((await positionOf(USERS.investorB.email)).status).toBe('OPEN');
  });

  it('a rising price reaches B\'s short stop (LAST basis)', async () => {
    const pb0 = await positionOf(USERS.investorB.email);
    await tick(new Decimal(pb0.stopPrice).plus(1).toFixed());
    await drain();
    const pb = await positionOf(USERS.investorB.email);
    expect(pb).toMatchObject({ status: 'CLOSED', closeReason: 'STOP_LOSS' });
    expect(new Decimal((await exitsOf(pb.id))[0]!.realizedPnl).lt(0)).toBe(true);
    expect(await reconciled()).toBe(true);
  });
});

describe('close on signal (saved policy) — also while entries are paused or the day is disabled', () => {
  it('explicit CLOSE_LONG closes matching Longs even though A is paused and today is disabled for A', async () => {
    await openBoth();
    // Entry restrictions on A: paused, and only Monday allowed (today is Sunday in Dhaka).
    const cur = (await call(block.GET, { path: '/x', cookie: a, params: { id: aBlock.id } })).body;
    const patched = (await call(block.PATCH, { method: 'PATCH', path: '/x', cookie: a, params: { id: aBlock.id }, ifMatch: cur.revision, body: { weekdays: ['MON'] } })).body;
    await call(pause.POST, { method: 'POST', path: '/x', cookie: a, params: { id: aBlock.id }, ifMatch: patched.revision });
    const next = new Date(BAR.getTime() + M15);
    clock = plus(new Date(next.getTime() + M15), 3);
    await tick('65100', { at: clock });
    expect(await deliver('CLOSE_LONG', next)).toBe(202);
    await drain();
    for (const email of [USERS.investorA.email, USERS.investorB.email]) {
      expect(await positionOf(email)).toMatchObject({ status: 'CLOSED', closeReason: 'SIGNAL_CLOSE' });
    }
    const screen = (await call(signals.GET, { path: '/x', cookie: a })).body.items[0];
    expect(screen.exit).toMatchObject({ status: 'EXIT_REQUESTED', reason: 'SIGNAL_CLOSE', orderState: 'FILLED' });
  });

  it('an opposite flip: KEEP_OPEN holds; CLOSE_ONLY closes and stays flat (reversals: reversal.test.ts)', async () => {
    // A pinned to a CLOSE_ONLY version, B on the fixture version (KEEP_OPEN).
    await openBoth({ aVersion: () => publishVersion({ oppositePolicy: 'CLOSE_ONLY' }) });
    const next = new Date(BAR.getTime() + M15);
    clock = plus(new Date(next.getTime() + M15), 3);
    await writeMarketFixture(direct.db, { instrumentId: BTC, interval: '15', endBarOpen: next, count: 260, endClose: '65000', trend: 'DOWN', quoteAt: clock });
    expect(await deliver('BEARISH_FLIP', next)).toBe(202);
    await drain();
    expect(await positionOf(USERS.investorA.email)).toMatchObject({ status: 'CLOSED', closeReason: 'OPPOSITE_SIGNAL_CLOSE' });
    expect(await positionOf(USERS.investorB.email)).toMatchObject({ status: 'OPEN', side: 'LONG' });
    const held = await direct.db.select().from(schema.signalDecisions).where(and(eq(schema.signalDecisions.ownerId, await userId(USERS.investorB.email)), eq(schema.signalDecisions.step, 'EXIT_V1')));
    expect(held[0]).toMatchObject({ status: 'HELD', reason: 'KEEP_OPEN' });
    // No reverse (Short) position for anyone.
    expect((await direct.db.select().from(schema.positions).where(eq(schema.positions.side, 'SHORT'))).length).toBe(0);
  });
});

describe('manual close from My Trades, partial fills and ownership', () => {
  beforeAll(() => openBoth());

  it('requires an idempotency key; B cannot close A\'s position by ID; admins cannot use it', async () => {
    const pa = await positionOf(USERS.investorA.email);
    expect((await manualClose(a, pa.id, null)).body.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    const byB = await manualClose(b, pa.id);
    expect(byB.status).toBe(404);
    expect(Object.keys(byB.body).sort()).toEqual(['code', 'correlationId', 'message']);
    expect((await manualClose(admin, pa.id)).status).toBe(403);
    expect(await direct.db.select().from(schema.orderIntents).where(eq(schema.orderIntents.kind, 'CLOSE'))).toHaveLength(0);
  });

  it('a partial fill closes part, keeps stop coverage for exactly the remainder, and the position stays open', async () => {
    const pa = await positionOf(USERS.investorA.email);
    await tick('65500', { liquidity: '100' });
    await drain(); // tick: no stop, no TP
    const r = await manualClose(a, pa.id, 'manual-close-0001');
    expect(r.status).toBe(202);
    expect(r.body).toMatchObject({ positionId: pa.id, state: 'INTENT', replayed: false });
    // Same key again → same command, no second intent; same key, other position → rejected.
    const again = await manualClose(a, pa.id, 'manual-close-0001');
    expect(again.body).toMatchObject({ commandId: r.body.commandId, replayed: true });
    const pb = await positionOf(USERS.investorB.email);
    expect((await manualClose(b, pb.id, 'manual-close-0001')).status).toBe(202); // keys are per owner
    expect((await manualClose(a, pb.id, 'manual-close-0001')).status).toBe(422);
    // A second exit for A while one is in flight is refused.
    expect((await manualClose(a, pa.id)).body.code).toBe('EXIT_IN_PROGRESS');

    const results = await drain();
    const mine = results.find((x) => x.close?.intentId === r.body.commandId)!.close!;
    expect(mine).toMatchObject({ state: 'EXPIRED', reason: 'PARTIAL_FILL', filled: '100', remaining: '53', closed: false });
    const p = await positionOf(USERS.investorA.email);
    expect(p).toMatchObject({ status: 'OPEN', protectionStatus: 'PROTECTED' });
    expect(new Decimal(p.contracts).toFixed()).toBe('53');
    expect(new Decimal(p.stopContracts!).toFixed()).toBe('53');
    const [stop] = await direct.db.select().from(schema.simOrders).where(eq(schema.simOrders.clientOrderId, p.stopOrderRef!));
    expect(new Decimal(stop!.contracts).toFixed()).toBe('53');
    const cmd = await call(command.GET, { path: '/x', cookie: a, params: { id: r.body.commandId } });
    expect(cmd.body).toMatchObject({ kind: 'POSITION_CLOSE', state: 'EXPIRED', exitReason: 'MANUAL_CLOSE', requestedContracts: '153', filledContracts: '100' });
    expect((await call(command.GET, { path: '/x', cookie: b, params: { id: r.body.commandId } })).status).toBe(404);
  });

  it('a second close takes the confirmed remainder; then zero is confirmed and the stop cleared', async () => {
    const pa = await positionOf(USERS.investorA.email);
    await tick('65400'); // unlimited liquidity
    await drain();
    expect((await manualClose(a, pa.id)).status).toBe(202);
    await drain();
    const p = await positionOf(USERS.investorA.email);
    expect(p).toMatchObject({ status: 'CLOSED', closeReason: 'MANUAL_CLOSE' });
    const xs = await exitsOf(p.id);
    expect(xs.map((x) => new Decimal(x.contracts).toFixed())).toEqual(['100', '53']);
    // Margin released twice, proportionally, adding up exactly to what was posted.
    const released = xs.reduce((s, x) => s.plus(x.marginReleased), new Decimal(0));
    expect(released.toFixed()).toBe(new Decimal('153').times(M).times('65000.5').div(10).toDecimalPlaces(8, Decimal.ROUND_UP).toFixed());
    expect(new Decimal((await accountOf(USERS.investorA.email)).positionMargin).toFixed()).toBe('0');
    expect((await manualClose(a, p.id)).body.code).toBe('POSITION_NOT_OPEN');
    expect(await reconciled()).toBe(true);
  });
});

describe('races and restart', () => {
  it('TP close and a stop race: the venue stop wins, the close is refused reduce-only, nothing flips', async () => {
    await openBoth();
    const pa = await positionOf(USERS.investorA.email);
    await tick('67000'); // TP for A requested (not yet sent)
    const t1 = await work(); // only the tick job runs
    expect(t1.tick).toMatchObject({ takeProfitsRequested: 1 });
    // Before the close job runs, the venue triggers A's stop (platform has not recorded it yet).
    clock = plus(clock, 5);
    await triggerStops(direct.db, BTC, { bid: '63999.5', ask: '64000.5', mark: '64000', last: '64000' }, clock);
    // A manual close and a CLOSE_LONG signal also arrive meanwhile.
    expect((await manualClose(a, pa.id)).body.code).toBe('EXIT_IN_PROGRESS');
    await drain(); // close job: venue flat → reduce-only REJECTED
    const [closeIntent] = await direct.db.select().from(schema.orderIntents).where(and(eq(schema.orderIntents.kind, 'CLOSE'), eq(schema.orderIntents.positionId, pa.id)));
    expect(closeIntent).toMatchObject({ state: 'REJECTED', stateReason: 'REDUCE_ONLY_NO_POSITION' });
    await tick('64000'); // the next tick reconciles the venue stop fill
    await drain();
    const p = await positionOf(USERS.investorA.email);
    expect(p).toMatchObject({ status: 'CLOSED', closeReason: 'STOP_LOSS' });
    expect(await exitsOf(p.id)).toHaveLength(1);
    expect(await ledgerCount(USERS.investorA.email, 'POSITION_MARGIN_RELEASE')).toBe(1);
    expect((await venue()).every((v) => new Decimal(v.contracts).gte(0))).toBe(true);
    expect((await direct.db.select().from(schema.positions).where(and(eq(schema.positions.side, 'SHORT')))).length).toBe(0);
    expect(await reconciled()).toBe(true);
  });

  it('restart after the simulated close fill: reconciled once; concurrent re-runs book nothing twice', async () => {
    await openBoth();
    const pa = await positionOf(USERS.investorA.email);
    await tick('65200');
    await drain();
    expect((await manualClose(a, pa.id)).status).toBe(202);
    const crashed = await work(clock, { afterSimulatorFill: () => Promise.reject(new Error('worker crashed after simulated close fill')) });
    expect(crashed.outcome).toBe('RETRY');
    expect((await venue()).find((v) => v.side === 'LONG' && v.contracts === '38')).toBeTruthy(); // B still at the venue
    expect(await exitsOf(pa.id)).toHaveLength(0); // platform has not recorded yet

    const after = await drain(plus(clock, 5));
    expect(after.find((r) => r.close)?.close).toMatchObject({ state: 'FILLED', closed: true, reconciled: true });
    await direct.db.update(schema.jobs).set({ status: 'PENDING', claimToken: null, runAfter: new Date(0) }).where(eq(schema.jobs.kind, 'paper.close'));
    await Promise.all([work(plus(clock, 9)), work(plus(clock, 9)), work(plus(clock, 9))]);
    await drain(plus(clock, 9));
    expect(await exitsOf(pa.id)).toHaveLength(1);
    expect(await ledgerCount(USERS.investorA.email, 'POSITION_MARGIN_RELEASE')).toBe(1);
    expect(await ledgerCount(USERS.investorA.email, 'REALIZED_PNL')).toBe(1);
    expect((await direct.db.select().from(schema.simOrders).where(eq(schema.simOrders.kind, 'MARKET_CLOSE'))).length).toBe(1);
    expect((await positionOf(USERS.investorA.email)).status).toBe('CLOSED');
    expect((await positionOf(USERS.investorB.email)).status).toBe('OPEN');
    expect(await reconciled()).toBe(true);
  });

  it('exit records are append-only', async () => {
    await expect(direct.pool.query('UPDATE position_exits SET realized_pnl = 0')).rejects.toThrow(/append-only/);
  });
});
