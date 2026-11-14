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
import * as holdingsRoute from '@/app/v1/me/holdings/route';
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
  it('MEXC holds none of the position but fills are delayed: closed at once (remaining 0, margin released, no stop coverage); fills backfilled once later', async () => {
    const p = await openLive();
    const mx = await mockOf(A);
    const owner = await userId(A);
    clock.now = later(10);
    const orderId = mx.manualClose('BTC_USDT', 1, human(p.contracts), '65300', { fee: '0.02', profit: '0.6', delayed: true });
    mx.assets = { equity: '1000.58', availableOpen: '1000.58', unrealized: '0' };
    let r = await syncLiveAccount(direct.db, owner, plus(clock.now, 5));
    expect(r).toMatchObject({ ok: true, exitsRecorded: 0, drift: [] });
    expect(r.closes).toEqual([expect.objectContaining({ result: 'FULL_FILLS_PENDING', pendingContracts: human(p.contracts) })]);
    let row = await posById(p.id);
    expect(row).toMatchObject({ status: 'CLOSED', closeReason: 'EXTERNAL_CLOSE', exchangeCloseState: 'FILLS_PENDING', protectionStatus: 'PENDING' });
    expect(D(row.contracts).isZero()).toBe(true);
    expect(D(row.initialContracts).eq(p.initialContracts)).toBe(true); // opening quantity kept
    expect(D(row.marginUsdt).isZero()).toBe(true);
    expect(D(row.exchangePendingContracts!).eq(p.contracts)).toBe(true);
    expect(row.closedAt).toEqual(plus(clock.now, 5));
    expect(await exitsOf(p.id)).toHaveLength(0);
    let acct = (await getMyPaperAccount(direct.db, owner, 'LIVE'))!;
    expect(D(acct.positionMarginUsdt).isZero()).toBe(true);
    expect(D(acct.walletBalanceUsdt).eq('1000.58')).toBe(true);
    // Open exposure, unrealized P&L and stop coverage: the position is no longer in the open lists.
    const holdings = await call(holdingsRoute.GET, { path: '/x?mode=LIVE', cookie: cookies.a });
    expect(holdings.body.positions).toHaveLength(0);
    const dto = (await listMyPositions(direct.db, owner)).find((x) => x.id === p.id)!;
    expect(dto).toMatchObject({ status: 'CLOSED', contracts: '0', venueSync: expect.objectContaining({ closeState: 'FILLS_PENDING' }) });
    const marginRows = async () => (await direct.db.select().from(schema.ledgerEntries).where(and(eq(schema.ledgerEntries.paperAccountId, p.paperAccountId), eq(schema.ledgerEntries.kind, 'POSITION_MARGIN_RELEASE')))).length;
    const releasesAfterClose = await marginRows();

    // Still delayed: repeated runs change nothing and book nothing twice.
    for (const s of [35, 65]) expect((await syncLiveAccount(direct.db, owner, plus(clock.now, s))).exitsRecorded).toBe(0);
    expect(await marginRows()).toBe(releasesAfterClose);
    expect((await posById(p.id)).closedAt).toEqual(plus(clock.now, 5));

    // Fills arrive: price, fee and MEXC's realized P&L are backfilled once; margin is not released again.
    mx.delayedDeals.delete(orderId);
    r = await syncLiveAccount(direct.db, owner, plus(clock.now, 95));
    expect(r.exitsRecorded).toBe(1);
    expect(r.closes).toEqual([expect.objectContaining({ result: 'FILLS_BACKFILLED' })]);
    row = await posById(p.id);
    expect(row).toMatchObject({ status: 'CLOSED', exchangeCloseState: null, exchangePendingContracts: null });
    expect(D(row.realizedPnlUsdt).eq('0.6')).toBe(true);
    expect(row.closedAt!.getTime()).toBe(clock.now.getTime()); // the fill time
    const [exit] = await exitsOf(p.id);
    expect(D(exit!.price).eq('65300')).toBe(true);
    expect(D(exit!.fee).eq('0.02')).toBe(true);
    expect(D(exit!.marginReleased).isZero()).toBe(true);
    expect(await marginRows()).toBe(releasesAfterClose);
    acct = (await getMyPaperAccount(direct.db, owner, 'LIVE'))!;
    expect(D(acct.walletBalanceUsdt).eq('1000.58')).toBe(true); // matched to MEXC again after the backfill
    for (const s of [125, 155]) expect((await syncLiveAccount(direct.db, owner, plus(clock.now, s))).exitsRecorded).toBe(0);
    expect(await exitsOf(p.id)).toHaveLength(1);
    expect((await fillLedger(p.paperAccountId)).filter((l) => l.refId === exit!.exchangeFillId)).toHaveLength(2); // P&L + fee
    expect(orderChanges(mx)).toHaveLength(1); // only the opening order from the alert
  });

  it('the production state left by the previous release (open, FILLS_PENDING, MEXC 0) closes on the next sync; other positions and reservations are untouched', async () => {
    await openLive({ both: true });
    const [p] = await livePos(A);
    const mx = await mockOf(A);
    const owner = await userId(A);
    expect((await syncLiveAccount(direct.db, owner, plus(clock.now, 5))).ok).toBe(true);
    // As stored at 13:14:45: open, 1 540-style quantity, Protected, margin held, FILLS_PENDING with MEXC 0.
    await direct.db.update(schema.positions).set({ exchangeCloseState: 'FILLS_PENDING', exchangeContracts: '0', exchangeFlatAt: later(9) }).where(eq(schema.positions.id, p!.id));
    // Another reservation on the same Live account must survive the margin refresh.
    await direct.db.update(schema.paperAccounts).set({ orderReserve: '5' }).where(eq(schema.paperAccounts.id, p!.paperAccountId));
    clock.now = later(10);
    mx.manualClose('BTC_USDT', 1, human(p!.contracts), '65200', { delayed: true });
    mx.assets = { equity: '1000', availableOpen: '1000', unrealized: '0' };
    const viaButton = await call(meSync.POST, { method: 'POST', path: '/x', cookie: cookies.a });
    expect(viaButton.body.sync.closes).toEqual([expect.objectContaining({ result: 'FULL_FILLS_PENDING' })]);
    expect(await posById(p!.id)).toMatchObject({ status: 'CLOSED', contracts: expect.stringMatching(/^0(\.0+)?$/), protectionStatus: 'PENDING', exchangeFlatAt: later(-1) });
    const acct = (await getMyPaperAccount(direct.db, owner, 'LIVE'))!;
    expect(D(acct.positionMarginUsdt).isZero()).toBe(true);
    expect(D(acct.orderReserveUsdt).eq('5')).toBe(true);
    expect(D(acct.availableUsdt).eq('995')).toBe(true); // MEXC available minus the reservation
    expect((await connRow(A)).drift).toEqual([]);
    // B's position is not touched.
    const [pb] = await livePos(B);
    expect(pb).toMatchObject({ status: 'OPEN' });
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
    r = await syncLiveAccount(direct.db, owner, clock.now);
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

describe('Exchange position identity, concurrency and drift', () => {
  it('a new MEXC position on the same symbol and side is not taken for the old one', async () => {
    const p = await openLive();
    const mx = await mockOf(A);
    const owner = await userId(A);
    expect((await syncLiveAccount(direct.db, owner, plus(clock.now, 5))).ok).toBe(true);
    const oldRef = (await posById(p.id)).exchangePositionRef;
    expect(oldRef).toBeTruthy();

    // Investor closes the old long on MEXC, then opens a new long of the SAME size there.
    clock.now = later(10);
    mx.manualClose('BTC_USDT', 1, human(p.contracts), '65210');
    mx.externalOpen('BTC_USDT', 1, human(p.contracts), '65220');
    const fresh = [...mx.positions.values()].find((x) => x.symbol === 'BTC_USDT' && x.positionType === 1)!;
    expect(String(fresh.positionId)).not.toBe(oldRef);

    const r = await syncLiveAccount(direct.db, owner, plus(clock.now, 5));
    expect(r.ok).toBe(true);
    expect(await posById(p.id)).toMatchObject({ status: 'CLOSED', closeReason: 'EXTERNAL_CLOSE', exchangePositionRef: oldRef });
    expect(r.drift).toEqual([expect.objectContaining({ kind: 'UNKNOWN_EXPOSURE', detail: expect.stringContaining(`is not TrendPilot's position ${oldRef}`) })]);
    expect(orderChanges(mx)).toHaveLength(1);
  });

  it('two syncs at the same time: one runs, the other is refused as busy; nothing is booked twice', async () => {
    const p = await openLive();
    const mx = await mockOf(A);
    const owner = await userId(A);
    clock.now = later(10);
    mx.manualClose('BTC_USDT', 1, human(p.contracts), '65200', { fee: '0.01' });
    const [r1, r2, r3] = await Promise.all([
      syncLiveAccount(direct.db, owner, plus(clock.now, 5)),
      syncLiveAccount(direct.db, owner, plus(clock.now, 5)),
      call(meSync.POST, { method: 'POST', path: '/x', cookie: cookies.a }).then((x) => x.body.sync)
    ]);
    const all = [r1, r2, r3];
    expect(all.filter((x) => x.ok)).toHaveLength(1);
    expect(all.filter((x) => x.busy)).toHaveLength(2);
    expect(all.reduce((t, x) => t + x.exitsRecorded, 0)).toBe(1);
    expect(await exitsOf(p.id)).toHaveLength(1);
    const exitFill = (await exitsOf(p.id))[0]!.exchangeFillId;
    expect((await fillLedger(p.paperAccountId)).filter((l) => l.refId === exitFill)).toHaveLength(3);
    expect((await connRow(A)).lastSyncError).toBeNull(); // busy is not a failure
    // The lease is released: the next run proceeds.
    expect((await syncLiveAccount(direct.db, owner, plus(clock.now, 10))).ok).toBe(true);
  });

  it('drift clears once MEXC and TrendPilot agree again; the entry halt stays for the operator', async () => {
    await openLive();
    const mx = await mockOf(A);
    const owner = await userId(A);
    mx.externalOpen('BTC_USDT', 2, '3', '65000');
    let r = await syncLiveAccount(direct.db, owner, plus(clock.now, 5));
    expect(r.drift.map((d) => d.kind)).toEqual(['SIDE_MISMATCH']);
    expect(await connRow(A)).toMatchObject({ entriesHalted: true });
    expect(((await connRow(A)).drift as unknown[]).length).toBe(1);

    // A failed run keeps the last drift.
    mx.faults.failingReads = ['/api/v1/private/position/open_positions'];
    expect((await syncLiveAccount(direct.db, owner, plus(clock.now, 10))).ok).toBe(false);
    expect(((await connRow(A)).drift as unknown[]).length).toBe(1);
    mx.faults.failingReads = [];

    mx.manualClose('BTC_USDT', 2, '3', '65000');
    r = await syncLiveAccount(direct.db, owner, plus(clock.now, 15));
    expect(r.drift).toEqual([]);
    const c = await connRow(A);
    expect(c.drift).toEqual([]);
    expect(c.entriesHalted).toBe(true);
    expect(c.haltReason).toMatch(/^DRIFT SIDE_MISMATCH/);
  });

  it('a stop removed on MEXC with no size change: shown UNPROTECTED with its reason; the sync places no close', async () => {
    const p = await openLive();
    const mx = await mockOf(A);
    const owner = await userId(A);
    for (const s of mx.stops.values()) if (s.state === 1) s.state = 2;
    mx.calls = [];
    const r = await syncLiveAccount(direct.db, owner, plus(clock.now, 5));
    expect(r).toMatchObject({ ok: true, protectionFailures: 1 });
    expect(r.drift).toEqual([expect.objectContaining({ kind: 'STOP_MISSING', detail: 'stop not listed at MEXC' })]);
    expect(await posById(p.id)).toMatchObject({ status: 'OPEN', protectionStatus: 'UNPROTECTED' });
    await drain(plus(clock.now, 5));
    expect(orderChanges(mx)).toEqual([]);
    expect(await direct.db.select().from(schema.orderIntents).where(and(eq(schema.orderIntents.ownerId, owner), eq(schema.orderIntents.kind, 'CLOSE')))).toHaveLength(0);
  });
});

describe('Live reversal: flat first, fresh MEXC margin, 32-character order IDs', () => {
  const reverseBlock = async () => ({ strategyVersionId: await publishVersion({ oppositePolicy: 'CLOSE_AND_REVERSE' }) });
  async function flip(mx: MockMexc) {
    const next = new Date(BAR.getTime() + M15);
    clock.now = plus(new Date(next.getTime() + M15), 3);
    setTestClock(() => clock.now);
    await recordMarketTick(direct.db, { instrumentId: BTC, asOf: clock.now, bid: '64899.5', ask: '64900.5', mark: '64900', last: '64900' });
    mx.price.BTC_USDT = '64900';
    expect(await deliver('BEARISH_FLIP', next, '64900.5')).toBe(202);
    await drain(clock.now);
    await drain(plus(clock.now, 5));
  }
  const reversalDecision = async (owner: string) =>
    (await direct.db.select().from(schema.signalDecisions).where(and(eq(schema.signalDecisions.ownerId, owner), eq(schema.signalDecisions.step, 'ENTRY_V1')))).find((d) => (d.detail as { reversal?: boolean }).reversal);
  const sides = (mx: MockMexc) => mx.creates().map((c) => (c.body as { side: number }).side);

  it('closes the long, confirms flat, reads MEXC margin again and opens the short with its stop; every external order ID is 32 hex and stable', async () => {
    const p = await openLive({ block: reverseBlock });
    const mx = await mockOf(A);
    const owner = await userId(A);
    await flip(mx);
    expect(await posById(p.id)).toMatchObject({ status: 'CLOSED', closeReason: 'REVERSAL_CLOSE' });
    const d = await reversalDecision(owner);
    expect(d).toMatchObject({ status: 'ENTRY_APPROVED' });
    expect((d!.detail as { liveBalance: { availableUsdt: string } }).liveBalance.availableUsdt).toBe('1000');
    const short = (await livePos(A)).find((x) => x.status === 'OPEN')!;
    expect(short).toMatchObject({ side: 'SHORT', protectionStatus: 'PROTECTED' });
    const intents = await direct.db.select().from(schema.orderIntents).where(eq(schema.orderIntents.ownerId, owner));
    const sent = mx.creates().map((c) => String((c.body as { externalOid: string }).externalOid));
    expect(sides(mx)).toEqual([1, 4, 3]); // open long, reversal close, open short
    for (const id of sent) expect(id).toMatch(/^[0-9a-f]{32}$/);
    expect(new Set(sent)).toEqual(new Set(intents.map((i) => i.clientOrderId)));
    // The assets read happened after the close was sent and before the short was sent.
    const seq = mx.calls.map((c) => `${c.method} ${c.path} ${(c.body as { side?: number } | undefined)?.side ?? ''}`);
    const closeAt = seq.indexOf('POST /api/v1/private/order/create 4');
    const shortAt = seq.indexOf('POST /api/v1/private/order/create 3');
    expect(closeAt).toBeGreaterThan(-1);
    expect(seq.slice(closeAt, shortAt).some((x) => x.startsWith('GET /api/v1/private/account/assets'))).toBe(true);
  });

  it('insufficient MEXC margin: required and available are recorded, the configured size is kept and nothing is sent', async () => {
    const p = await openLive({ block: reverseBlock });
    const mx = await mockOf(A);
    const owner = await userId(A);
    mx.assets = { equity: '1000', availableOpen: '1.5', unrealized: '0' };
    await flip(mx);
    expect((await posById(p.id)).status).toBe('CLOSED');
    const d = await reversalDecision(owner);
    expect(d).toMatchObject({ status: 'SKIPPED', reason: 'INSUFFICIENT_MARGIN' });
    const det = d!.detail as { requiredUsdt: string; availableUsdt: string; liveBalance: { availableUsdt: string } };
    expect(det.availableUsdt).toBe('1.5');
    expect(det.liveBalance.availableUsdt).toBe('1.5');
    expect(D(det.requiredUsdt).gt(det.availableUsdt)).toBe(true);
    expect(D(det.requiredUsdt).gt("15")).toBe(true); // the configured 20 USDT order (rounded to the contract step) + fee, not shrunk to fit
    expect(sides(mx)).toEqual([1, 4]);
  });

  it('the MEXC balance cannot be read: the opposite entry is withheld (REVERSAL_BALANCE_UNAVAILABLE)', async () => {
    const p = await openLive({ block: reverseBlock });
    const mx = await mockOf(A);
    const owner = await userId(A);
    mx.faults.failingReads = ['/api/v1/private/account/assets'];
    await flip(mx);
    expect((await posById(p.id)).status).toBe('CLOSED');
    expect(await reversalDecision(owner)).toMatchObject({ status: 'SKIPPED', reason: 'REVERSAL_BALANCE_UNAVAILABLE' });
    expect(sides(mx)).toEqual([1, 4]);
  });
});

describe('Importing the manual closing fill (14 Nov XAU follow-up)', () => {
  /** Closed on MEXC with fills delayed: the position is closed (fills pending), then MEXC lists them. */
  type CloseOpts = NonNullable<Parameters<MockMexc['manualClose']>[4]>;
  async function closedPending(opts: CloseOpts | ((contracts: string) => CloseOpts) = {}) {
    const p = await openLive();
    const mx = await mockOf(A);
    const owner = await userId(A);
    expect((await syncLiveAccount(direct.db, owner, plus(clock.now, 5))).ok).toBe(true); // stores the MEXC position ID
    clock.now = later(10);
    const o = typeof opts === 'function' ? opts(human(p.contracts)) : opts;
    const orderId = mx.manualClose('BTC_USDT', 1, human(p.contracts), '65300', { delayed: true, ...o });
    const flatAt = plus(clock.now, 60);
    expect((await syncLiveAccount(direct.db, owner, flatAt)).closes).toEqual([expect.objectContaining({ result: 'FULL_FILLS_PENDING' })]);
    return { p, mx, owner, orderId, flatAt, executedAt: clock.now };
  }

  it('the close time shown while pending is when TrendPilot detected it; after import it is MEXC’s execution time', async () => {
    const { p, mx, owner, orderId, flatAt, executedAt } = await closedPending({ fee: '0.03' });
    expect((await posById(p.id)).closedAt).toEqual(flatAt);
    expect((await posById(p.id)).exchangePendingReason).toMatch(/lists no unbooked closing fill/);
    mx.delayedDeals.delete(orderId);
    await syncLiveAccount(direct.db, owner, plus(flatAt, 30));
    const row = await posById(p.id);
    expect(row).toMatchObject({ exchangeCloseState: null, exchangePendingReason: null });
    expect(row.closedAt).toEqual(executedAt);
  });

  it('a One-way Sell (side 3) tied to the position ID is imported with a weighted price; one not tied to it is not', async () => {
    const { p, mx, owner, orderId } = await closedPending((contracts) => ({
      oneWaySide: true,
      dealPositionId: true,
      fee: '0.05',
      parts: [
        { vol: D(contracts).minus(1).toFixed(), price: '65300', fee: '0.04' },
        { vol: '1', price: '65200', fee: '0.01' }
      ]
    }));
    mx.delayedDeals.delete(orderId);
    const r = await syncLiveAccount(direct.db, owner, plus(clock.now, 120));
    expect(r.closes).toEqual([expect.objectContaining({ result: 'FILLS_BACKFILLED' })]);
    const [exit] = await exitsOf(p.id);
    const n = D(human(p.contracts));
    expect(D(exit!.price).eq(D('65300').times(n.minus(1)).plus('65200').div(n).toDecimalPlaces(12))).toBe(true);
    expect(D(exit!.fee).eq('0.05')).toBe(true);
    expect(exit!.exchangeFillId).toBe(`mexc:${orderId}`);
  });

  it('a side-3 order that MEXC does not tie to this position stays pending with the specific reason', async () => {
    const { p, mx, owner, orderId } = await closedPending({ oneWaySide: true, orderWithoutPositionId: true });
    mx.delayedDeals.delete(orderId);
    await syncLiveAccount(direct.db, owner, plus(clock.now, 120));
    const row = await posById(p.id);
    expect(row.exchangeCloseState).toBe('FILLS_PENDING');
    expect(row.exchangePendingReason).toMatch(new RegExp(`order ${orderId} \\(side 3\\) is not tied to position`));
    expect(await exitsOf(p.id)).toHaveLength(0);
    const dto = (await listMyPositions(direct.db, owner)).find((x) => x.id === p.id)!;
    expect(dto.venueSync!.pendingReason).toMatch(/not tied to position/);
  });

  it('a deal time returned as createTime is still read (not filtered out as time 0)', async () => {
    const { p, mx, owner, orderId, executedAt } = await closedPending({ createTimeOnly: true });
    mx.delayedDeals.delete(orderId);
    await syncLiveAccount(direct.db, owner, plus(clock.now, 120));
    expect((await exitsOf(p.id))[0]!.filledAt).toEqual(executedAt);
  });

  it('MEXC profit that already includes the fee: realized P&L is stored gross and the fee counted once', async () => {
    const p0 = await openLive();
    const n = D(human(p0.contracts));
    const gross = D('65300').minus(p0.avgEntryPrice).times(n).times('0.0001'); // BTC multiplier 0.0001
    const fee = '0.07';
    const mx = await mockOf(A);
    const owner = await userId(A);
    clock.now = later(10);
    mx.manualClose('BTC_USDT', 1, n.toFixed(), '65300', { fee, profit: gross.minus(fee).toFixed() });
    await syncLiveAccount(direct.db, owner, plus(clock.now, 5));
    const [exit] = await exitsOf(p0.id);
    expect(D(exit!.realizedPnl).minus(gross).abs().lt('0.00000001')).toBe(true);
    const row = await posById(p0.id);
    expect(D(row.realizedPnlUsdt).minus(gross).abs().lt('0.00000001')).toBe(true);
    // Net = gross − entry fee − exit fee; the exit fee appears once.
    const feeRows = (await fillLedger(p0.paperAccountId)).filter((l) => l.refId === exit!.exchangeFillId && l.kind === 'TRADING_FEE');
    expect(feeRows).toHaveLength(1);
    expect(D(feeRows[0]!.amount).eq(D(fee).neg())).toBe(true);
  });

  it('deal history unavailable: values stay pending with that reason; the account sync itself still completes', async () => {
    const { p, mx, owner, orderId } = await closedPending();
    mx.delayedDeals.delete(orderId);
    mx.faults.failingReads = ['/api/v1/private/order/list/order_deals'];
    const r = await syncLiveAccount(direct.db, owner, plus(clock.now, 120));
    expect(r.ok).toBe(true);
    expect(r.skipped).toEqual([expect.objectContaining({ positionId: p.id, reason: expect.stringMatching(/^MEXC history unavailable/) })]);
    expect(await posById(p.id)).toMatchObject({ status: 'CLOSED', exchangeCloseState: 'FILLS_PENDING' });
    expect((await posById(p.id)).exchangePendingReason).toMatch(/^MEXC history unavailable/);
    mx.faults.failingReads = [];
    await syncLiveAccount(direct.db, owner, plus(clock.now, 150));
    expect(await exitsOf(p.id)).toHaveLength(1);
    expect(orderChanges(mx)).toHaveLength(1);
  });
});
