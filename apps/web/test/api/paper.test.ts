// M2 slice 2: paper entries from a confirmed flat state (STR-01/02/08/09, EXE-01..04, ARC-02).
// Deterministic market fixtures and a controlled clock; the simulator is the only "venue".
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { processNextJob, schema, writeMarketFixture } from '@trendpilot/db';
import { buildTradingViewPayload, Decimal, PAPER_POLICY, PAPER_TEMPLATE, type SignalAction } from '@trendpilot/domain';
import * as webhook from '@/app/v1/webhooks/tradingview/[ingressToken]/route';
import * as blocks from '@/app/v1/me/order-blocks/route';
import * as block from '@/app/v1/me/order-blocks/[id]/route';
import * as resume from '@/app/v1/me/order-blocks/[id]/resume/route';
import * as holdings from '@/app/v1/me/holdings/route';
import * as trades from '@/app/v1/me/trades/route';
import * as trade from '@/app/v1/me/trades/[id]/route';
import * as orders from '@/app/v1/me/orders/route';
import * as order from '@/app/v1/me/orders/[id]/route';
import * as ledger from '@/app/v1/me/ledger/route';
import * as signals from '@/app/v1/me/signals/route';
import * as packages from '@/app/v1/admin/strategy-packages/route';
import * as versions from '@/app/v1/admin/strategy-packages/[id]/versions/route';
import * as publish from '@/app/v1/admin/strategy-versions/[id]/publish/route';
import { setTestClock } from '@/server/clock';
import { BTC, blockBody, call, direct, resetAndSeed, signIn, teardown, userId, USERS, VERSION } from '../helpers';

const TOKEN = process.env.DEV_INGRESS_TOKEN!;
const M15 = 15 * 60_000;
// 2026-11-08 is a Sunday; 09:30:03Z is 15:30:03 in Asia/Dhaka.
const BAR = new Date('2026-11-08T09:15:00Z');
const AT = new Date('2026-11-08T09:30:03Z');
const plus = (d: Date, s: number) => new Date(d.getTime() + s * 1000);
const ALL = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];

let clock = AT;
let a = '';
let b = '';
let admin = '';
let aBlock: any;
let bBlock: any;

const deliver = async (action: SignalAction = 'BULLISH_FLIP', barOpen = BAR) => {
  const raw = JSON.stringify(
    buildTradingViewPayload({ action, exchange: 'MEXC', symbol: 'BTCUSDT.P', interval: '15', barOpen, firedAt: plus(new Date(barOpen.getTime() + M15), 1), referencePrice: '65000.5' })
  );
  const res = await webhook.POST(new Request(`http://localhost/v1/webhooks/tradingview/${TOKEN}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: raw }), {
    params: Promise.resolve({ ingressToken: TOKEN })
  });
  return { status: res.status, body: await res.json() };
};
const work = (now = clock, hooks?: Parameters<typeof processNextJob>[1]['hooks']) => processNextJob(direct.db, { workerId: 'test', now, hooks });
async function drain(now = clock) {
  const out = [];
  for (let i = 0; i < 20; i++) {
    const r = await work(now);
    if (r.outcome === 'IDLE') break;
    out.push(r);
  }
  return out;
}
const market = (trend: 'UP' | 'DOWN' | 'FLAT', o: { omit?: Date[]; quote?: boolean; count?: number; endBar?: Date; at?: Date } = {}) =>
  writeMarketFixture(direct.db, { instrumentId: BTC, interval: '15', endBarOpen: o.endBar ?? BAR, count: o.count ?? 260, endClose: '65000', trend, omit: o.omit, quoteAt: o.quote === false ? null : (o.at ?? AT) });

const entryFor = async (ownerEmail: string) => {
  const id = await userId(ownerEmail);
  return direct.db.select().from(schema.signalDecisions).where(and(eq(schema.signalDecisions.ownerId, id), eq(schema.signalDecisions.step, 'ENTRY_V1')));
};
const screenFor = async (ownerEmail: string) => {
  const id = await userId(ownerEmail);
  return direct.db.select().from(schema.signalDecisions).where(and(eq(schema.signalDecisions.ownerId, id), eq(schema.signalDecisions.step, 'ENTRY_SCREEN_V1')));
};
const accountOf = async (email: string) => (await direct.db.select().from(schema.paperAccounts).where(eq(schema.paperAccounts.ownerId, await userId(email))))[0]!;
const rows = async (t: any) => (await direct.db.select().from(t)).length;

/** Fresh DB: A active every day; B active every day except Sunday (the clock's Dhaka weekday). */
async function scenario(o: { versionId?: string; aOverrides?: Record<string, unknown>; bWeekdays?: string[] } = {}) {
  await resetAndSeed();
  setTestClock(() => clock);
  clock = AT;
  a = await signIn(USERS.investorA.email);
  b = await signIn(USERS.investorB.email);
  admin = await signIn(USERS.admin.email);
  aBlock = (await call(blocks.POST, { method: 'POST', path: '/x', cookie: a, body: blockBody({ orderCostUsdt: '100', leverage: 10, weekdays: ALL, ...o.aOverrides }) })).body;
  bBlock = (await call(blocks.POST, { method: 'POST', path: '/x', cookie: b, body: blockBody({ orderCostUsdt: '50', leverage: 5, weekdays: o.bWeekdays ?? ALL.filter((d) => d !== 'SUN') }) })).body;
  expect(aBlock.id).toBeTruthy();
  expect(bBlock.id).toBeTruthy();
  aBlock = (await call(resume.POST, { method: 'POST', path: '/x', cookie: a, params: { id: aBlock.id }, ifMatch: aBlock.revision })).body;
  bBlock = (await call(resume.POST, { method: 'POST', path: '/x', cookie: b, params: { id: bBlock.id }, ifMatch: bBlock.revision })).body;
}

async function publishEmaVersion(): Promise<string> {
  const pkgs = await call(packages.GET, { path: '/x', cookie: admin });
  const pkgId = pkgs.body.items.find((p: any) => p.versions.some((v: any) => v.id === VERSION)).id;
  const d = await call(versions.POST, { method: 'POST', path: '/x', cookie: admin, params: { id: pkgId }, body: { ...PAPER_TEMPLATE, emaFilter: 'EMA200', instrumentIds: [BTC] } });
  const p = await call(publish.POST, { method: 'POST', path: '/x', cookie: admin, params: { id: d.body.id }, ifMatch: d.body.revision });
  expect(p.body.status).toBe('PUBLISHED');
  return p.body.id;
}

async function pinA(versionId: string) {
  const cur = (await call(block.GET, { path: '/x', cookie: a, params: { id: aBlock.id } })).body;
  const r = await call(block.PATCH, { method: 'PATCH', path: '/x', cookie: a, params: { id: aBlock.id }, ifMatch: cur.revision, body: { strategyVersionId: versionId } });
  expect(r.status).toBe(200);
}

afterAll(async () => {
  setTestClock(null);
  await teardown();
});

describe('one shared alert: A opens a protected paper Long, B gets DAY_DISABLED', () => {
  let intentId = '';
  let positionId = '';

  beforeAll(async () => {
    await scenario();
    await market('UP');
  });

  it('the alert is accepted and the dispatch records both investors independently', async () => {
    expect((await deliver()).status).toBe(202);
    const r = await work();
    expect(r.summary).toMatchObject({ evaluated: 2, ready: 1, skipped: 1, entriesApproved: 1, entriesSkipped: 0 });
    expect((await screenFor(USERS.investorB.email))[0]).toMatchObject({ status: 'SKIPPED', reason: 'DAY_DISABLED' });
    const [entry] = await entryFor(USERS.investorA.email);
    expect(entry).toMatchObject({ status: 'ENTRY_APPROVED', reason: null });
    expect(await entryFor(USERS.investorB.email)).toHaveLength(0);
  });

  it('the order intent (stable client ID, stop included) and margin reservation are committed before submission', async () => {
    const [intent] = await direct.db.select().from(schema.orderIntents);
    intentId = intent!.id;
    expect(intent).toMatchObject({ state: 'INTENT', side: 'LONG', kind: 'OPEN', mode: 'PAPER', stopBasis: 'MARK' });
    expect(intent!.clientOrderId).toMatch(/^[0-9a-f]{32}$/); // fits MEXC's 32-character externalOid
    // EXE-01: 100 USDT × 10 at the 65000.5 fixture ask, 0.0001 BTC per contract, rounded down.
    expect(new Decimal(intent!.contracts).toFixed()).toBe('153');
    expect(new Decimal(intent!.expectedPrice).toFixed()).toBe('65000.5');
    expect(new Decimal(intent!.stopPrice).toFixed()).toBe('64025.5');
    const acct = await accountOf(USERS.investorA.email);
    expect(new Decimal(acct.orderReserve).toFixed()).toBe(new Decimal(intent!.reservedUsdt).toFixed());
    expect(await rows(schema.simOrders)).toBe(0); // nothing sent yet
  });

  it('the simulator fills it with the stop attached; the stop covers the filled quantity', async () => {
    const r = await work();
    expect(r.submit).toMatchObject({ intentId, state: 'FILLED', reconciled: false });
    positionId = r.submit!.positionId!;
    const [pos] = await direct.db.select().from(schema.positions).where(eq(schema.positions.id, positionId));
    expect(pos).toMatchObject({ side: 'LONG', status: 'OPEN', protectionStatus: 'PROTECTED', stopBasis: 'MARK' });
    expect(new Decimal(pos!.contracts).toFixed()).toBe('153');
    expect(new Decimal(pos!.stopContracts!).toFixed()).toBe('153');
    expect(new Decimal(pos!.stopPrice).lt(pos!.avgEntryPrice)).toBe(true);
    expect(new Decimal(pos!.liquidationEstimate).lt(pos!.stopPrice)).toBe(true);
    const sim = await direct.db.select().from(schema.simOrders).orderBy(schema.simOrders.kind);
    expect(sim.map((o) => [o.kind, o.side, new Decimal(o.contracts).toFixed(), o.reduceOnly])).toEqual([
      ['MARKET_OPEN', 'LONG', '153', false],
      ['STOP_MARKET', 'SHORT', '153', true]
    ]);
    const [intent] = await direct.db.select().from(schema.orderIntents);
    expect(intent!.state).toBe('FILLED');
  });

  it('balances move once: fee from wallet, margin to position, reservation released', async () => {
    const [fill] = await direct.db.select().from(schema.fills);
    const fee = new Decimal('153').times('0.0001').times('65000.5').times('0.0004').toDecimalPlaces(8, Decimal.ROUND_UP);
    expect(new Decimal(fill!.fee).toFixed()).toBe(fee.toFixed());
    const acct = await accountOf(USERS.investorA.email);
    expect(new Decimal(acct.walletBalance).toFixed()).toBe(new Decimal(PAPER_POLICY.startingBalanceUsdt).minus(fee).toFixed());
    expect(new Decimal(acct.orderReserve).toFixed()).toBe('0');
    expect(new Decimal(acct.positionMargin).toFixed()).toBe(new Decimal('153').times('0.0001').times('65000.5').div(10).toDecimalPlaces(8, Decimal.ROUND_UP).toFixed());
    const recon = await direct.db.execute(sql`SELECT * FROM paper_account_reconciliation`);
    for (const r of recon.rows as any[]) {
      expect(new Decimal(r.wallet_balance).eq(r.ledger_wallet)).toBe(true);
      expect(new Decimal(r.position_margin).eq(r.ledger_position_margin)).toBe(true);
      expect(new Decimal(r.order_reserve).eq(r.ledger_order_reserve)).toBe(true);
    }
    const bAcct = await accountOf(USERS.investorB.email);
    expect(new Decimal(bAcct.walletBalance).toFixed()).toBe(PAPER_POLICY.startingBalanceUsdt);
  });

  it('each investor sees only their own holdings, orders, trades and ledger', async () => {
    const ha = await call(holdings.GET, { path: '/x', cookie: a });
    expect(ha.body.positions).toHaveLength(1);
    expect(ha.body.positions[0]).toMatchObject({ id: positionId, side: 'LONG', stop: { price: '64025.5', basis: 'MARK', protection: 'PROTECTED', contracts: '153' } });
    const hb = await call(holdings.GET, { path: '/x', cookie: b });
    expect(hb.body.positions).toHaveLength(0);
    expect(hb.body.account.walletBalanceUsdt).toBe('10000');

    // B submits A's IDs directly.
    for (const [h, id] of [[trade, positionId], [order, intentId]] as const) {
      const r = await call(h.GET, { path: '/x', cookie: b, params: { id } });
      expect(r.status).toBe(404);
      expect(Object.keys(r.body).sort()).toEqual(['code', 'correlationId', 'message']);
      expect((await call(h.GET, { path: '/x', cookie: a, params: { id } })).status).toBe(200);
    }
    expect((await call(trades.GET, { path: '/x', cookie: b })).body.items).toHaveLength(0);
    expect((await call(orders.GET, { path: '/x', cookie: b })).body.items).toHaveLength(0);
    const lb = await call(ledger.GET, { path: '/x', cookie: b });
    expect(lb.body.items.map((l: any) => l.kind)).toEqual(['OPENING_BALANCE']);
    for (const h of [holdings, trades, orders, ledger]) expect((await call(h.GET, { path: '/x', cookie: admin })).status).toBe(403);

    const detail = await call(trade.GET, { path: '/x', cookie: a, params: { id: positionId } });
    expect(detail.body.order.fills).toHaveLength(1);
    expect(detail.body.ledger.map((l: any) => l.kind).sort()).toEqual(['ORDER_RESERVE', 'ORDER_RESERVE_RELEASE', 'POSITION_MARGIN', 'TRADING_FEE']);
  });

  it('the Signals outcome links A to the order and position; B shows DAY_DISABLED', async () => {
    const sa = (await call(signals.GET, { path: '/x', cookie: a })).body.items[0];
    expect(sa.entry).toMatchObject({ status: 'ENTRY_APPROVED', orderId: intentId, orderState: 'FILLED', positionId });
    const sb = (await call(signals.GET, { path: '/x', cookie: b })).body.items[0];
    expect(sb).toMatchObject({ status: 'SKIPPED', reason: 'DAY_DISABLED' });
    expect(sb.entry).toBeUndefined();
  });

  it('the next bullish alert on an open position is POSITION_NOT_FLAT (adds are later)', async () => {
    const next = new Date(BAR.getTime() + M15);
    clock = plus(new Date(next.getTime() + M15), 3);
    await market('UP', { endBar: next, at: clock });
    expect((await deliver('BULLISH_FLIP', next)).status).toBe(202);
    await drain();
    const entries = await entryFor(USERS.investorA.email);
    expect(entries.find((e) => e.reason === 'POSITION_NOT_FLAT')).toBeTruthy();
    expect(await rows(schema.positions)).toBe(1);
  });
});

describe('duplicate alert, restart after a simulated fill, concurrent workers', () => {
  beforeAll(async () => {
    await scenario({ bWeekdays: ALL });
    await market('UP');
  });

  it('a crash after the simulator filled but before the platform recorded leaves the order SUBMITTING', async () => {
    expect((await deliver()).status).toBe(202);
    await work(); // dispatch: two intents (A and B both trade every day here)
    const crashing = { afterSimulatorFill: () => Promise.reject(new Error('worker crashed after simulated fill')) };
    const r = await work(clock, crashing);
    expect(r.outcome).toBe('RETRY');
    const states = (await direct.db.select().from(schema.orderIntents)).map((i) => i.state).sort();
    expect(states).toEqual(['INTENT', 'SUBMITTING']);
    expect(await rows(schema.simFills)).toBe(1); // the venue did fill
    expect(await rows(schema.fills)).toBe(0); // the platform did not record yet
    expect(await rows(schema.positions)).toBe(0);
  });

  it('a duplicate delivery and a re-run dispatch create nothing new', async () => {
    expect((await deliver()).status).toBe(200);
    await direct.db.update(schema.jobs).set({ status: 'PENDING', claimToken: null, runAfter: new Date(0) }).where(eq(schema.jobs.kind, 'signal.dispatch'));
    const r = await work(plus(clock, 1));
    expect(r.summary).toMatchObject({ inserted: 0 });
    expect(await rows(schema.orderIntents)).toBe(2);
  });

  it('after restart the worker reconciles by client order ID instead of submitting again', async () => {
    const results = await drain(plus(clock, 5)); // retry backoff elapsed
    const reconciled = results.find((r) => r.submit?.reconciled);
    expect(reconciled?.submit).toMatchObject({ state: 'FILLED' });
    expect(await rows(schema.simFills)).toBe(2); // one per investor, never two for the same order
    expect(await rows(schema.fills)).toBe(2);
    expect(await rows(schema.positions)).toBe(2);
  });

  it('re-running the submit jobs (also concurrently) books nothing twice', async () => {
    await direct.db.update(schema.jobs).set({ status: 'PENDING', claimToken: null, runAfter: new Date(0) }).where(eq(schema.jobs.kind, 'paper.submit'));
    await Promise.all([work(plus(clock, 10)), work(plus(clock, 10)), work(plus(clock, 10))]);
    await drain(plus(clock, 10));
    const aId = await userId(USERS.investorA.email);
    const count = async (kind: string) => (await direct.db.select().from(schema.ledgerEntries).where(and(eq(schema.ledgerEntries.ownerId, aId), eq(schema.ledgerEntries.kind, kind)))).length;
    expect(await count('POSITION_MARGIN')).toBe(1); // one margin debit for the entry
    expect(await count('ORDER_RESERVE')).toBe(1);
    expect(await count('TRADING_FEE')).toBe(1);
    expect((await direct.db.select().from(schema.fills).where(eq(schema.fills.ownerId, aId))).length).toBe(1);
    expect((await direct.db.select().from(schema.positions).where(eq(schema.positions.ownerId, aId))).length).toBe(1);
    expect((await direct.db.select().from(schema.simOrders).where(eq(schema.simOrders.kind, 'MARKET_OPEN'))).length).toBe(2);
  });

  it('financial rows are append-only', async () => {
    await expect(direct.pool.query("UPDATE ledger_entries SET amount = 0")).rejects.toThrow(/append-only/);
    await expect(direct.pool.query('DELETE FROM fills')).rejects.toThrow(/append-only/);
  });
});

describe('Short case', () => {
  it('a bearish flip opens a Short at the bid with the stop above entry', async () => {
    await scenario();
    await market('DOWN');
    expect((await deliver('BEARISH_FLIP')).status).toBe(202);
    await drain();
    const [pos] = await direct.db.select().from(schema.positions);
    expect(pos).toMatchObject({ side: 'SHORT', protectionStatus: 'PROTECTED' });
    expect(new Decimal(pos!.avgEntryPrice).toFixed()).toBe('64999.5');
    expect(new Decimal(pos!.stopPrice).gt(pos!.avgEntryPrice)).toBe(true);
    expect(new Decimal(pos!.liquidationEstimate).gt(pos!.stopPrice)).toBe(true);
    const [stop] = await direct.db.select().from(schema.simOrders).where(eq(schema.simOrders.kind, 'STOP_MARKET'));
    expect(stop).toMatchObject({ side: 'LONG', reduceOnly: true });
  });
});

describe('EMA 200 filter (fixture candles aligned to the signal bar)', () => {
  const runCase = async (o: { ema: boolean; trend?: 'UP' | 'DOWN' | 'FLAT'; omit?: boolean; candles?: boolean; action?: SignalAction }) => {
    await scenario();
    if (o.ema) await pinA(await publishEmaVersion());
    if (o.candles === false) await market('UP', { count: 0 });
    else await market(o.trend ?? 'UP', { omit: o.omit ? [new Date(BAR.getTime() - 50 * M15)] : [] });
    expect((await deliver(o.action ?? 'BULLISH_FLIP')).status).toBe(202);
    await drain();
    return (await entryFor(USERS.investorA.email))[0]!;
  };

  it('EMA on, close above EMA, bullish → entry', async () => {
    const e = await runCase({ ema: true, trend: 'UP' });
    expect(e.status).toBe('ENTRY_APPROVED');
    expect((e.detail as any).checks.ema).toMatchObject({ emaFilter: 'EMA200', relation: 'ABOVE', candlesUsed: 260 });
  });
  it('EMA on, close below EMA, bearish → entry (Short)', async () => {
    const e = await runCase({ ema: true, trend: 'DOWN', action: 'BEARISH_FLIP' });
    expect(e.status).toBe('ENTRY_APPROVED');
  });
  it('EMA on, close below EMA, bullish → EMA_FILTERED', async () => {
    expect(await runCase({ ema: true, trend: 'DOWN' })).toMatchObject({ status: 'SKIPPED', reason: 'EMA_FILTERED' });
  });
  it('EMA on, close equal to EMA → EMA_FILTERED (equality blocks)', async () => {
    const e = await runCase({ ema: true, trend: 'FLAT' });
    expect(e).toMatchObject({ status: 'SKIPPED', reason: 'EMA_FILTERED' });
    expect((e.detail as any).relation).toBe('EQUAL');
  });
  it('EMA on, a gap in recent history → EMA_UNAVAILABLE', async () => {
    const e = await runCase({ ema: true, omit: true });
    expect(e).toMatchObject({ status: 'SKIPPED', reason: 'EMA_UNAVAILABLE' });
    expect((e.detail as any).cause).toBe('INSUFFICIENT_HISTORY');
  });
  it('EMA on, no candles at all → EMA_UNAVAILABLE', async () => {
    expect(await runCase({ ema: true, candles: false })).toMatchObject({ status: 'SKIPPED', reason: 'EMA_UNAVAILABLE' });
  });
  it('EMA off bypasses the filter, even with no candle history', async () => {
    const e = await runCase({ ema: false, candles: false });
    expect(e.status).toBe('ENTRY_APPROVED');
    expect((e.detail as any).checks.ema).toEqual({ emaFilter: 'OFF' });
    expect(await rows(schema.positions)).toBe(1);
  });
});

describe('other entry checks', () => {
  it('no quote → FEED_STALE; nothing reserved', async () => {
    await scenario();
    await market('UP', { quote: false });
    await deliver();
    await drain();
    expect((await entryFor(USERS.investorA.email))[0]).toMatchObject({ status: 'SKIPPED', reason: 'FEED_STALE' });
    expect(await rows(schema.orderIntents)).toBe(0);
  });

  it('cost above the paper balance → INSUFFICIENT_MARGIN', async () => {
    await scenario({ aOverrides: { orderCostUsdt: '20000' } });
    await market('UP');
    await deliver();
    await drain();
    expect((await entryFor(USERS.investorA.email))[0]).toMatchObject({ status: 'SKIPPED', reason: 'INSUFFICIENT_MARGIN' });
    expect(new Decimal((await accountOf(USERS.investorA.email)).orderReserve).toFixed()).toBe('0');
  });

  it('CFG-04: weekday rechecked at submission; crossing into a disabled day cancels and releases the reservation', async () => {
    // Sunday 23:59:50 in Dhaka = 17:59:50Z. A trades on Sunday only.
    await scenario({ aOverrides: { weekdays: ['SUN'] } });
    const bar = new Date('2026-11-08T17:30:00Z');
    clock = new Date('2026-11-08T17:45:03Z');
    await market('UP', { endBar: bar, at: clock });
    expect((await deliver('BULLISH_FLIP', bar)).status).toBe(202);
    await work(clock); // dispatch on Sunday → intent + reservation
    expect((await entryFor(USERS.investorA.email))[0]!.status).toBe('ENTRY_APPROVED');
    expect(new Decimal((await accountOf(USERS.investorA.email)).orderReserve).gt(0)).toBe(true);
    const r = await work(new Date('2026-11-08T18:00:10Z')); // submission on Monday 00:00:10 Dhaka
    expect(r.submit).toMatchObject({ state: 'CANCELLED', reason: 'DAY_DISABLED' });
    expect(new Decimal((await accountOf(USERS.investorA.email)).orderReserve).toFixed()).toBe('0');
    expect(await rows(schema.simOrders)).toBe(0);
  });
});
