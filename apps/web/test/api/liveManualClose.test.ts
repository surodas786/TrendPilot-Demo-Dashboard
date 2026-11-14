// Live: positions closed directly on MEXC (14 Nov 2026, XAU_USDT 00:50 Dhaka follow-up). The
// automatic sync and the investor's "Sync with MEXC" button share one reconciliation: full and
// partial manual closes, delayed fills, failed queries, repeated runs, account isolation. A run
// never sends, replaces or cancels an order, never replays a signal and never opens the withheld
// opposite entry. Against a stateful mocked MEXC per investor; nothing leaves the process.
import { and, eq, like } from 'drizzle-orm';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getMyPaperAccount, installLiveSyncSeam, installLiveTestSeam, listMyPositions, recordMarketTick, schema, syncLiveAccount, writeMarketFixture, type ConnectionRow, type LiveTestSeam } from '@trendpilot/db';
import { Decimal } from '@trendpilot/domain';
import * as blocks from '@/app/v1/me/order-blocks/route';
import * as resume from '@/app/v1/me/order-blocks/[id]/resume/route';
import * as conn from '@/app/v1/me/exchange-connection/route';
import * as activate from '@/app/v1/me/live/activate/route';
import * as meSync from '@/app/v1/me/live/sync/route';
import * as mySignals from '@/app/v1/me/signals/route';
import * as platform from '@/app/v1/admin/live/platform/route';
import * as capabilities from '@/app/v1/admin/live/capabilities/route';
import * as contracts from '@/app/v1/admin/live/contracts/[id]/route';
import * as approve from '@/app/v1/admin/live/connections/[id]/approve/route';
import { setTestClock } from '@/server/clock';
import { BTC, blockBody, call, direct, teardown, userId, USERS } from '../helpers';
import { MockMexc } from '../mexcMock';
import { ALL_DAYS, clock, cookies, deliver, drain, M15, openFromAlert, plus, positionsOf, publishVersion } from '../paperReplay';

const A = USERS.investorA.email;
const B = USERS.investorB.email;
const D = (v: Decimal.Value) => new Decimal(v);
const LIMITS = { maxOrderContracts: '1000', maxOrderNotionalUsdt: '500', maxLeverage: 10, maxExposureUsdt: '500' };
const BAR = new Date('2026-11-08T09:15:00Z');

let mocks: Record<string, MockMexc> = {};
const mockFor = (c: ConnectionRow) => mocks[c.ownerId]!;

beforeEach(() => {
  mocks = {};
  const seam: LiveTestSeam = { requesterFor: (c) => mockFor(c), transportEnabled: true, confirm: { attempts: 2, delayMs: 0 } };
  installLiveTestSeam(seam);
  installLiveSyncSeam(mockFor);
});
afterEach(() => {
  installLiveTestSeam(null);
  installLiveSyncSeam(null);
});
afterAll(async () => {
  setTestClock(null);
  await teardown();
});

async function connectAndBlock(who: 'a' | 'b', email: string, block: Record<string, unknown> = {}) {
  const m = new MockMexc();
  m.positionMode = 2;
  m.now = () => clock.now.getTime();
  mocks[await userId(email)] = m;
  const put = await call(conn.PUT, {
    method: 'PUT',
    path: '/x',
    cookie: cookies[who],
    body: { accountRef: `UID …${who === 'a' ? '4821' : '7310'}`, apiKey: who === 'a' ? 'mx0vglTESTKEYAAAAAAA1234' : 'mx0vglTESTKEYBBBBBBB9876', secretKey: who === 'a' ? 'TESTSECRETaaaaaaaaaaaaaaaaaaaaaa' : 'TESTSECRETbbbbbbbbbbbbbbbbbbbbbb' }
  });
  expect(put.body.connection.status).toBe('VERIFIED');
  const created = await call(blocks.POST, { method: 'POST', path: '/x', cookie: cookies[who], body: blockBody({ mode: 'LIVE', orderCostUsdt: '20', leverage: 5, weekdays: ALL_DAYS, ...block }) });
  expect(created.status).toBe(201);
  expect((await call(resume.POST, { method: 'POST', path: '/x', cookie: cookies[who], params: { id: created.body.id }, ifMatch: created.body.revision })).status).toBe(200);
  expect((await call(approve.POST, { method: 'POST', path: '/x', cookie: cookies.admin, params: { id: put.body.connection.id }, body: LIMITS })).status).toBe(200);
  expect((await call(activate.POST, { method: 'POST', path: '/x', cookie: cookies[who] })).status).toBe(200);
}

async function platformOn() {
  for (const c of ['OPEN_WITH_ATTACHED_STOP', 'REDUCE_ONLY_CLOSE', 'STOP_RESIZE_AFTER_PARTIAL_CLOSE', 'CANCEL_STOP'])
    expect((await call(capabilities.POST, { method: 'POST', path: '/x', cookie: cookies.admin, body: { capability: c, state: 'PILOT_ACCEPTED', evidence: 'test' } })).status).toBe(200);
  await direct.db.update(schema.instruments).set({ isFixture: false, exchangeSymbol: 'BTC_USDT' }).where(eq(schema.instruments.id, BTC));
  expect((await call(contracts.POST, { method: 'POST', path: '/x', cookie: cookies.admin, params: { id: BTC }, body: { allowed: true } })).status).toBe(200);
  expect((await call(platform.POST, { method: 'POST', path: '/x', cookie: cookies.admin, body: { enabled: true, note: 'test' } })).status).toBe(200);
}

/** A (and optionally B) hold a protected Live Long opened from one alert. */
async function openLive(o: { both?: boolean; block?: () => Promise<Record<string, unknown>> } = {}) {
  await openFromAlert({
    a: null,
    b: null,
    market: async () => {
      const extra = o.block ? await o.block() : {};
      await connectAndBlock('a', A, extra);
      if (o.both) await connectAndBlock('b', B, extra);
      await platformOn();
      await writeMarketFixture(direct.db, { instrumentId: BTC, interval: '15', endBarOpen: BAR, count: 260, endClose: '65000', trend: 'UP', quoteAt: clock.now });
    }
  });
  const [p] = await livePos(A);
  expect(p).toMatchObject({ status: 'OPEN', protectionStatus: 'PROTECTED' });
  return p!;
}

const livePos = async (email: string) => (await positionsOf(email)).filter((p) => p.mode === 'LIVE');
const posById = async (id: string) => (await direct.db.select().from(schema.positions).where(eq(schema.positions.id, id)))[0]!;
const mockOf = async (email: string) => mocks[await userId(email)]!;
const connRow = async (email: string) => (await direct.db.select().from(schema.exchangeConnections).where(eq(schema.exchangeConnections.ownerId, await userId(email))))[0]!;
const exitsOf = (positionId: string) => direct.db.select().from(schema.positionExits).where(eq(schema.positionExits.positionId, positionId));
const fillLedger = async (accountId: string) => direct.db.select().from(schema.ledgerEntries).where(and(eq(schema.ledgerEntries.paperAccountId, accountId), like(schema.ledgerEntries.refId, 'mexc:%')));
/** Order-changing requests a reconciliation must never make. */
const orderChanges = (m: MockMexc) => m.calls.filter((c) => c.method === 'POST');
const later = (min: number) => plus(clock.now, min * 60);
const human = (v: string) => D(v).toFixed();

describe('Full close made directly on MEXC', () => {
  it('moves the position to Closed Trades with MEXC price, time, fee and P&L; wallet, margin and available follow MEXC; nothing is sent', async () => {
    const p = await openLive();
    const mx = await mockOf(A);
    const owner = await userId(A);
    mx.calls = [];
    mx.price.BTC_USDT = '65200';
    clock.now = later(10);
    const closedAt = clock.now.getTime();
    mx.manualClose('BTC_USDT', 1, human(p.contracts), '65200', { fee: '0.0123', profit: '0.5' });
    mx.assets = { equity: '1000.4877', availableOpen: '1000.4877', unrealized: '0' };
    const stopBefore = [...mx.stops.values()].find((s) => s.positionId && s.state === 2);
    expect(stopBefore).toBeTruthy(); // MEXC cancelled the position stop with the close

    const r = await syncLiveAccount(direct.db, owner, plus(clock.now, 5));
    expect(r).toMatchObject({ ok: true, exitsRecorded: 1, drift: [] });
    expect(r.closes).toEqual([expect.objectContaining({ positionId: p.id, result: 'FULL' })]);
    const after = await posById(p.id);
    expect(after).toMatchObject({ status: 'CLOSED', closeReason: 'EXTERNAL_CLOSE', exchangeCloseState: null });
    expect(D(after.contracts).isZero()).toBe(true);
    expect(D(after.marginUsdt).isZero()).toBe(true);
    expect(after.closedAt!.getTime()).toBe(closedAt);
    const [exit] = await exitsOf(p.id);
    expect(exit).toMatchObject({ reason: 'EXTERNAL_CLOSE', intentId: null });
    expect(D(exit!.price).eq('65200')).toBe(true);
    expect(D(exit!.fee).eq('0.0123')).toBe(true);
    expect(D(exit!.realizedPnl).eq('0.5')).toBe(true); // MEXC's own realized P&L
    expect(exit!.exchangeFillId).toMatch(/^mexc:\d+$/);

    const acct = (await getMyPaperAccount(direct.db, owner, 'LIVE'))!;
    expect(D(acct.walletBalanceUsdt).eq('1000.4877')).toBe(true);
    expect(D(acct.positionMarginUsdt).isZero()).toBe(true);
    expect(acct.exchange!.availableUsdt).toBe('1000.4877');
    expect((await listMyPositions(direct.db, owner)).find((x) => x.id === p.id)).toMatchObject({ status: 'CLOSED', mode: 'LIVE' });
    expect(orderChanges(mx)).toEqual([]);
    expect((await connRow(A)).lastSyncOkAt).toEqual(plus(clock.now, 5));
  });

  it('a repeated sync (worker and button) books no second exit, fill ledger row or balance correction', async () => {
    const p = await openLive();
    const mx = await mockOf(A);
    const owner = await userId(A);
    clock.now = later(10);
    mx.manualClose('BTC_USDT', 1, human(p.contracts), '65100', { fee: '0.01' });
    mx.assets = { equity: '1000.2', availableOpen: '1000.2', unrealized: '0' };
    expect((await syncLiveAccount(direct.db, owner, plus(clock.now, 5))).exitsRecorded).toBe(1);
    const acctId = (await posById(p.id)).paperAccountId;
    const exitFill = (await exitsOf(p.id))[0]!.exchangeFillId;
    const exitLedger = async () => (await fillLedger(acctId)).filter((l) => l.refId === exitFill);
    const ledger = await exitLedger();
    expect(ledger.map((l) => l.kind).sort()).toEqual(['POSITION_MARGIN_RELEASE', 'REALIZED_PNL', 'TRADING_FEE']);
    const balanceRows = async () => (await direct.db.select().from(schema.ledgerEntries).where(and(eq(schema.ledgerEntries.paperAccountId, acctId), eq(schema.ledgerEntries.kind, 'EXCHANGE_BALANCE_SYNC')))).length;
    const rowsBefore = await balanceRows();

    const again = await call(meSync.POST, { method: 'POST', path: '/x', cookie: cookies.a });
    expect(again.status).toBe(200);
    expect(again.body.sync).toMatchObject({ ok: true, exitsRecorded: 0, closes: [] });
    expect((await syncLiveAccount(direct.db, owner, plus(clock.now, 60))).exitsRecorded).toBe(0);
    expect(await exitsOf(p.id)).toHaveLength(1);
    expect(await exitLedger()).toHaveLength(3);
    expect(await balanceRows()).toBe(rowsBefore); // wallet already equals MEXC: no new correction
    expect(D((await getMyPaperAccount(direct.db, owner, 'LIVE'))!.walletBalanceUsdt).eq('1000.2')).toBe(true);
  });
});

describe('Partial close made directly on MEXC', () => {
  it('updates the remaining quantity and shows the active stop still covers it; nothing is sent', async () => {
    const p = await openLive();
    const mx = await mockOf(A);
    const total = D(p.contracts);
    const part = total.div(2).floor();
    mx.calls = [];
    clock.now = later(10);
    mx.manualClose('BTC_USDT', 1, part.toFixed(), '65150', { fee: '0.004' });
    const r = await syncLiveAccount(direct.db, await userId(A), plus(clock.now, 5));
    expect(r).toMatchObject({ ok: true, exitsRecorded: 1, drift: [] });
    expect(r.closes).toEqual([expect.objectContaining({ result: 'PARTIAL', platformContracts: total.minus(part).toFixed(), stopCoverage: 'FULL' })]);
    const after = await posById(p.id);
    expect(after.status).toBe('OPEN');
    expect(D(after.contracts).eq(total.minus(part))).toBe(true);
    expect(D(after.exchangeContracts!).eq(total.minus(part))).toBe(true);
    expect(after.protectionStatus).toBe('PROTECTED');
    expect(D(after.stopContracts!).gte(after.contracts)).toBe(true);
    expect(orderChanges(mx)).toEqual([]); // the stop was not resized or replaced
    const [exit] = await exitsOf(p.id);
    expect(D(exit!.contracts).eq(part)).toBe(true);
    expect(D(exit!.remainingContracts).eq(total.minus(part))).toBe(true);
  });

  it('a stop removed on MEXC before the partial close: shown as not covering, entries halted, and still no close order (button or worker)', async () => {
    const p = await openLive();
    const mx = await mockOf(A);
    const owner = await userId(A);
    for (const s of mx.stops.values()) if (s.state === 1) s.state = 2; // investor cancelled the stop on MEXC
    mx.calls = [];
    clock.now = later(10);
    mx.manualClose('BTC_USDT', 1, '1', '65150');
    const viaButton = await call(meSync.POST, { method: 'POST', path: '/x', cookie: cookies.a });
    expect(viaButton.body.sync.closes).toEqual([expect.objectContaining({ result: 'PARTIAL', stopCoverage: 'NONE' })]);
    expect(viaButton.body.sync.drift.map((d: { kind: string }) => d.kind)).toEqual(['STOP_MISSING']);
    expect((await posById(p.id)).protectionStatus).toBe('UNPROTECTED');
    expect((await connRow(A)).entriesHalted).toBe(true);
    // The scheduled run afterwards does not turn it into an emergency close either.
    const worker = await syncLiveAccount(direct.db, owner, plus(clock.now, 30));
    expect(worker.protectionFailures).toBe(0);
    await drain(plus(clock.now, 30));
    expect(orderChanges(mx)).toEqual([]);
    expect((await direct.db.select().from(schema.orderIntents).where(and(eq(schema.orderIntents.ownerId, owner), eq(schema.orderIntents.kind, 'CLOSE'))))).toHaveLength(0);
  });
});

describe('Delayed fills and failed queries', () => {
  it('MEXC confirms the close before its fills are listed: FILLS_PENDING, nothing booked; the fills are booked once when they appear', async () => {
    const p = await openLive();
    const mx = await mockOf(A);
    const owner = await userId(A);
    clock.now = later(10);
    const orderId = mx.manualClose('BTC_USDT', 1, human(p.contracts), '65300', { fee: '0.02', delayed: true });
    let r = await syncLiveAccount(direct.db, owner, plus(clock.now, 5));
    expect(r).toMatchObject({ ok: true, exitsRecorded: 0, drift: [] });
    expect(r.closes).toEqual([expect.objectContaining({ result: 'FILLS_PENDING', exchangeContracts: '0' })]);
    let row = await posById(p.id);
    expect(row).toMatchObject({ status: 'OPEN', exchangeCloseState: 'FILLS_PENDING' });
    expect(D(row.contracts).eq(p.contracts)).toBe(true);
    expect(D(row.exchangeContracts!).isZero()).toBe(true);
    expect(row.exchangeFlatAt).toEqual(plus(clock.now, 5));
    expect(await exitsOf(p.id)).toHaveLength(0);
    const dto = (await listMyPositions(direct.db, owner)).find((x) => x.id === p.id)!;
    expect(dto.venueSync).toMatchObject({ closeState: 'FILLS_PENDING', contracts: '0' });

    // Still delayed on the next run: unchanged, first-seen time kept.
    r = await syncLiveAccount(direct.db, owner, plus(clock.now, 35));
    expect(r.exitsRecorded).toBe(0);
    expect((await posById(p.id)).exchangeFlatAt).toEqual(plus(clock.now, 5));

    mx.delayedDeals.delete(orderId);
    r = await syncLiveAccount(direct.db, owner, plus(clock.now, 65));
    expect(r.exitsRecorded).toBe(1);
    row = await posById(p.id);
    expect(row).toMatchObject({ status: 'CLOSED', closeReason: 'EXTERNAL_CLOSE', exchangeCloseState: null });
    expect(D((await exitsOf(p.id))[0]!.price).eq('65300')).toBe(true);
    expect(orderChanges(mx)).toHaveLength(1); // only the opening order from the alert
  });

  it('a failed deal-history or position query leaves the position unconfirmed and records the error', async () => {
    const p = await openLive();
    const mx = await mockOf(A);
    const owner = await userId(A);
    const okAt = (await connRow(A)).lastSyncOkAt;
    clock.now = later(10);
    mx.manualClose('BTC_USDT', 1, human(p.contracts), '65200');

    mx.faults.failingReads = ['/api/v1/private/order/list/order_deals'];
    let r = await syncLiveAccount(direct.db, owner, plus(clock.now, 5));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/network error/);
    let row = await posById(p.id);
    expect(row).toMatchObject({ status: 'OPEN', exchangeCloseState: null });
    expect(D(row.contracts).eq(p.contracts)).toBe(true);
    let c = await connRow(A);
    expect(c.lastSyncError).toMatch(/order_deals/);
    expect(c.lastSyncOkAt).toEqual(okAt);

    mx.faults.failingReads = ['/api/v1/private/position/open_positions'];
    r = await syncLiveAccount(direct.db, owner, plus(clock.now, 10));
    expect(r.ok).toBe(false);
    row = await posById(p.id);
    expect(row).toMatchObject({ status: 'OPEN', exchangeCloseState: null });

    // The button reports the failure; the page shows it next to the last successful sync.
    const viaButton = await call(meSync.POST, { method: 'POST', path: '/x', cookie: cookies.a });
    expect(viaButton.status).toBe(200);
    expect(viaButton.body.sync.ok).toBe(false);
    expect(viaButton.body.connection.lastSyncError).toMatch(/open_positions/);
    expect(await exitsOf(p.id)).toHaveLength(0);

    mx.faults.failingReads = [];
    c = await connRow(A);
    expect((await syncLiveAccount(direct.db, owner, plus(clock.now, 20))).ok).toBe(true);
    expect((await posById(p.id)).status).toBe('CLOSED');
    expect((await connRow(A)).lastSyncError).toBeNull();
  });
});

describe('Sync with MEXC button: account isolation', () => {
  it('reconciles only the signed-in investor’s account; another investor’s position, ledger and MEXC account are untouched', async () => {
    await openLive({ both: true });
    const [pa] = await livePos(A);
    const [pb] = await livePos(B);
    const ma = await mockOf(A);
    const mb = await mockOf(B);
    clock.now = later(10);
    ma.manualClose('BTC_USDT', 1, human(pa!.contracts), '65200');
    mb.manualClose('BTC_USDT', 1, human(pb!.contracts), '65250'); // B also closed on MEXC, but B does not sync
    ma.calls = [];
    mb.calls = [];
    const bLedgerBefore = (await direct.db.select().from(schema.ledgerEntries).where(eq(schema.ledgerEntries.paperAccountId, pb!.paperAccountId))).length;

    const r = await call(meSync.POST, { method: 'POST', path: '/x', cookie: cookies.a });
    expect(r.status).toBe(200);
    expect(r.body.sync.ownerId).toBe(await userId(A));
    expect(r.body.sync.closes.map((x: { positionId: string }) => x.positionId)).toEqual([pa!.id]);
    expect(JSON.stringify(r.body)).not.toContain(pb!.id);
    expect((await posById(pa!.id)).status).toBe('CLOSED');
    expect((await posById(pb!.id)).status).toBe('OPEN');
    expect(mb.calls).toEqual([]);
    expect((await direct.db.select().from(schema.ledgerEntries).where(eq(schema.ledgerEntries.paperAccountId, pb!.paperAccountId))).length).toBe(bLedgerBefore);
    expect((await connRow(B)).lastSyncOkAt).not.toEqual((await connRow(A)).lastSyncOkAt);

    // An investor without a connection gets a 404, and an anonymous request is refused.
    expect((await call(meSync.POST, { method: 'POST', path: '/x', cookie: cookies.admin })).status).toBeGreaterThanOrEqual(400);
    expect((await call(meSync.POST, { method: 'POST', path: '/x' })).status).toBe(401);
  });
});

describe('Reversal overtaken by a manual close (the 14 Nov 00:50 XAU case)', () => {
  it('the stuck closing leg does not block the sync; afterwards the old signal is not replayed, no close is sent and the short stays withheld', async () => {
    const p = await openLive({ block: async () => ({ strategyVersionId: await publishVersion({ oppositePolicy: 'CLOSE_AND_REVERSE' }) }) });
    const mx = await mockOf(A);
    const owner = await userId(A);

    // Bearish flip on the next bar: the reversal close times out before MEXC receives it (stays SUBMITTING).
    const next = new Date(BAR.getTime() + M15);
    clock.now = plus(new Date(next.getTime() + M15), 3);
    setTestClock(() => clock.now);
    await recordMarketTick(direct.db, { instrumentId: BTC, asOf: clock.now, bid: '64899.5', ask: '64900.5', mark: '64900', last: '64900' });
    mx.price.BTC_USDT = '64900';
    mx.faults.timeoutBeforeAccept = 1;
    expect(await deliver('BEARISH_FLIP', next, '64900.5')).toBe(202);
    await drain(clock.now);
    const [close] = await direct.db.select().from(schema.orderIntents).where(and(eq(schema.orderIntents.ownerId, owner), eq(schema.orderIntents.kind, 'CLOSE')));
    expect(close).toMatchObject({ state: 'SUBMITTING', exitReason: 'REVERSAL_CLOSE' });
    const createsBefore = mx.creates().length;

    // Within the grace period the sync leaves it to the close job.
    clock.now = plus(clock.now, 30);
    mx.manualClose('BTC_USDT', 1, human(p.contracts), '64880');
    let r = await syncLiveAccount(direct.db, owner, clock.now);
    expect(r.skipped).toEqual([expect.objectContaining({ positionId: p.id })]);
    expect((await posById(p.id)).status).toBe('OPEN');

    // Past it, the manual close is booked (the investor's order, not TrendPilot's).
    clock.now = plus(clock.now, 180);
    setTestClock(() => clock.now);
    r = await syncLiveAccount(direct.db, owner, clock.now, { protectiveClose: false });
    expect(r.closes).toEqual([expect.objectContaining({ result: 'FULL' })]);
    expect((await posById(p.id))).toMatchObject({ status: 'CLOSED', closeReason: 'EXTERNAL_CLOSE' });
    const [ex] = await exitsOf(p.id);
    expect(ex!.intentId).toBeNull();

    // The stuck close job resumes: MEXC holds nothing, so nothing is sent; the opposite entry is withheld.
    await drain(clock.now);
    await drain(plus(clock.now, 120));
    expect(mx.creates()).toHaveLength(createsBefore);
    const [closeAfter] = await direct.db.select().from(schema.orderIntents).where(eq(schema.orderIntents.id, close!.id));
    expect(closeAfter!.state).toBe('REJECTED');
    const entries = await direct.db.select().from(schema.signalDecisions).where(and(eq(schema.signalDecisions.ownerId, owner), eq(schema.signalDecisions.step, 'ENTRY_V1')));
    const reversal = entries.find((d) => (d.detail as { reversal?: boolean }).reversal);
    expect(reversal).toMatchObject({ status: 'SKIPPED', reason: 'REVERSAL_CLOSED_ON_EXCHANGE' });
    expect((await livePos(A)).filter((x) => x.status === 'OPEN')).toHaveLength(0);
    expect((await direct.db.select().from(schema.orderIntents).where(and(eq(schema.orderIntents.ownerId, owner), eq(schema.orderIntents.kind, 'OPEN'))))).toHaveLength(1);

    // Signals labels it as a withheld reverse entry, not "stayed flat".
    const sig = await call(mySignals.GET, { method: 'GET', path: '/v1/me/signals', cookie: cookies.a });
    const flip = (sig.body.items as { exit?: { reason: string }; entry?: { reason: string } }[]).find((o) => o.exit?.reason === 'REVERSAL_CLOSE');
    expect(flip!.entry!.reason).toBe('REVERSAL_CLOSED_ON_EXCHANGE');

    // Re-running the sync never replays anything.
    expect((await syncLiveAccount(direct.db, owner, plus(clock.now, 300))).exitsRecorded).toBe(0);
    expect(mx.creates()).toHaveLength(createsBefore);
  });
});
