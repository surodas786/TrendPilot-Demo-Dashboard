// Live mode through the normal UI/API and worker flows, against a stateful mocked MEXC (one mock
// exchange account per investor). Real TradingView alerts, durable intents, the job loop, the Live
// guard and the private sync run unchanged; only the signed HTTP transport is replaced (test seam,
// refused in production). Nothing leaves the process.
import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getMyPaperAccount, installLiveSyncSeam, installLiveTestSeam, reconcileMyAccount, schema, syncLiveAccount, type ConnectionRow, type LiveTestSeam } from '@trendpilot/db';
import { Decimal } from '@trendpilot/domain';
import * as blocks from '@/app/v1/me/order-blocks/route';
import * as resume from '@/app/v1/me/order-blocks/[id]/resume/route';
import * as conn from '@/app/v1/me/exchange-connection/route';
import * as meLive from '@/app/v1/me/live/route';
import * as activate from '@/app/v1/me/live/activate/route';
import * as meHalt from '@/app/v1/me/live/halt/route';
import * as holdings from '@/app/v1/me/holdings/route';
import * as dashboard from '@/app/v1/me/dashboard/route';
import * as closePos from '@/app/v1/me/positions/[id]/close/route';
import * as adminLive from '@/app/v1/admin/live/route';
import * as platform from '@/app/v1/admin/live/platform/route';
import * as platformHalt from '@/app/v1/admin/live/halt/route';
import * as capabilities from '@/app/v1/admin/live/capabilities/route';
import * as contracts from '@/app/v1/admin/live/contracts/[id]/route';
import * as approve from '@/app/v1/admin/live/connections/[id]/approve/route';
import * as connResume from '@/app/v1/admin/live/connections/[id]/resume/route';
import * as clearDrift from '@/app/v1/admin/live/connections/[id]/clear-drift/route';
import { setTestClock } from '@/server/clock';
import { BTC, blockBody, call, direct, teardown, userId, USERS } from '../helpers';
import { MockMexc } from '../mexcMock';
import { ALL_DAYS, clock, cookies, deliver, drain, M15, openFromAlert, plus, positionsOf } from '../paperReplay';
import { recordMarketTick } from '@trendpilot/db';

const A = USERS.investorA.email;
const B = USERS.investorB.email;
const D = (v: Decimal.Value) => new Decimal(v);
const KEY_A = 'mx0vglTESTKEYAAAAAAA1234';
const SECRET_A = 'TESTSECRETaaaaaaaaaaaaaaaaaaaaaa';
const LIMITS = { maxOrderContracts: '1000', maxOrderNotionalUsdt: '500', maxLeverage: 10, maxExposureUsdt: '500' };

let mocks: Record<string, MockMexc> = {};
let transportEnabled = true;
const mockFor = (c: ConnectionRow) => mocks[c.ownerId]!;

function freshMock(): MockMexc {
  const m = new MockMexc();
  m.positionMode = 2; // one-way, as recommended
  m.now = () => clock.now.getTime();
  return m;
}

beforeEach(() => {
  mocks = {};
  transportEnabled = true;
  const seam: LiveTestSeam = {
    requesterFor: (c) => mockFor(c),
    get transportEnabled() {
      return transportEnabled;
    },
    confirm: { attempts: 2, delayMs: 0 }
  };
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

const liveBlock = (o: Record<string, unknown> = {}) => blockBody({ mode: 'LIVE', orderCostUsdt: '20', leverage: 5, weekdays: ALL_DAYS, ...o });

/** Connects an investor's mocked MEXC account (verified read-only) and creates + activates a Live block. */
async function connectAndBlock(who: 'a' | 'b', email: string, o: { approve?: boolean; activate?: boolean; block?: Record<string, unknown> } = {}) {
  mocks[await userId(email)] = freshMock();
  const put = await call(conn.PUT, { method: 'PUT', path: '/x', cookie: cookies[who], body: { accountRef: `UID …${who === 'a' ? '4821' : '7310'}`, apiKey: who === 'a' ? KEY_A : 'mx0vglTESTKEYBBBBBBB9876', secretKey: who === 'a' ? SECRET_A : 'TESTSECRETbbbbbbbbbbbbbbbbbbbbbb' } });
  expect(put.status).toBe(200);
  expect(put.body.connection.status).toBe('VERIFIED');
  const created = await call(blocks.POST, { method: 'POST', path: '/x', cookie: cookies[who], body: liveBlock(o.block) });
  expect(created.status).toBe(201);
  const resumed = await call(resume.POST, { method: 'POST', path: '/x', cookie: cookies[who], params: { id: created.body.id }, ifMatch: created.body.revision });
  expect(resumed.status).toBe(200);
  if (o.approve !== false) expect((await call(approve.POST, { method: 'POST', path: '/x', cookie: cookies.admin, params: { id: put.body.connection.id }, body: LIMITS })).status).toBe(200);
  if (o.approve !== false && o.activate !== false) expect((await call(activate.POST, { method: 'POST', path: '/x', cookie: cookies[who] })).status).toBe(200);
  return put.body.connection.id as string;
}

/** Platform: capability evidence (accepted for the supervised pilot), contract allowlist, switch on. */
async function platformOn() {
  for (const c of ['OPEN_WITH_ATTACHED_STOP', 'REDUCE_ONLY_CLOSE', 'STOP_RESIZE_AFTER_PARTIAL_CLOSE', 'CANCEL_STOP'])
    expect((await call(capabilities.POST, { method: 'POST', path: '/x', cookie: cookies.admin, body: { capability: c, state: 'PILOT_ACCEPTED', evidence: 'test: supervised pilot' } })).status).toBe(200);
  await direct.db.update(schema.instruments).set({ isFixture: false, exchangeSymbol: 'BTC_USDT' }).where(eq(schema.instruments.id, BTC));
  expect((await call(contracts.POST, { method: 'POST', path: '/x', cookie: cookies.admin, params: { id: BTC }, body: { allowed: true } })).status).toBe(200);
  expect((await call(platform.POST, { method: 'POST', path: '/x', cookie: cookies.admin, body: { enabled: true, note: 'test' } })).status).toBe(200);
}

const decisionsOf = async (email: string) => direct.db.select().from(schema.signalDecisions).where(eq(schema.signalDecisions.ownerId, await userId(email)));
const livePos = async (email: string) => (await positionsOf(email)).filter((p) => p.mode === 'LIVE');
const paperPos = async (email: string) => (await positionsOf(email)).filter((p) => p.mode === 'PAPER');
const liveIntents = async (email: string) => direct.db.select().from(schema.orderIntents).where(and(eq(schema.orderIntents.ownerId, await userId(email)), eq(schema.orderIntents.mode, 'LIVE'))).orderBy(schema.orderIntents.createdAt);
const connRow = async (email: string) => (await direct.db.select().from(schema.exchangeConnections).where(eq(schema.exchangeConnections.ownerId, await userId(email))))[0]!;
const mockOf = async (email: string) => mocks[await userId(email)]!;

/** A later alert on the next bar, with a fresh quote. */
async function nextAlert(action: 'BULLISH_FLIP' | 'CLOSE_LONG', barOffsetBars = 1) {
  const bar = new Date(new Date('2026-11-08T09:15:00Z').getTime() + barOffsetBars * M15);
  clock.now = plus(new Date(bar.getTime() + M15), 3);
  setTestClock(() => clock.now);
  await recordMarketTick(direct.db, { instrumentId: BTC, asOf: clock.now, bid: '64999.5', ask: '65000.5', mark: '65000', last: '65000' });
  expect(await deliver(action, bar)).toBe(202);
  return drain(clock.now);
}

describe('Live is Off by default; credentials stay server-side', () => {
  it('a verified, approved and activated account still opens nothing while the platform switch is Off; Paper is unaffected', async () => {
    await openFromAlert({
      market: async () => {
        await connectAndBlock('a', A);
        await direct.db.update(schema.instruments).set({ isFixture: false, exchangeSymbol: 'BTC_USDT' }).where(eq(schema.instruments.id, BTC));
        await call(contracts.POST, { method: 'POST', path: '/x', cookie: cookies.admin, params: { id: BTC }, body: { allowed: true } });
        const { writeMarketFixture } = await import('@trendpilot/db');
        await writeMarketFixture(direct.db, { instrumentId: BTC, interval: '15', endBarOpen: new Date('2026-11-08T09:15:00Z'), count: 260, endClose: '65000', trend: 'UP', quoteAt: clock.now });
      }
    });
    const ctrl = (await direct.db.select().from(schema.liveControl))[0]!;
    expect(ctrl.liveEnabled).toBe(false);
    const live = (await decisionsOf(A)).find((d) => d.status === 'SKIPPED' && d.reason === 'LIVE_NOT_ELIGIBLE');
    expect((live!.detail as any).liveReason).toBe('LIVE_PLATFORM_DISABLED');
    expect((await mockOf(A)).creates()).toHaveLength(0);
    expect(await livePos(A)).toHaveLength(0);
    expect(await paperPos(A)).toHaveLength(1);
    expect(await paperPos(B)).toHaveLength(1);

    // The key and secret are sealed at rest and never returned.
    const row = await connRow(A);
    expect(row.apiKeySealed).not.toContain(KEY_A);
    expect(row.secretSealed).not.toContain(SECRET_A);
    const got = await call(conn.GET, { path: '/x', cookie: cookies.a });
    expect(JSON.stringify(got.body)).not.toContain(KEY_A);
    expect(JSON.stringify(got.body)).not.toContain(SECRET_A);
    expect(got.body.connection.keyFingerprint).toBe('…1234');
    expect(got.body.connection.positionMode).toBe('ONE_WAY');
    const list = await call(adminLive.GET, { path: '/x', cookie: cookies.admin });
    expect(JSON.stringify(list.body)).not.toContain(SECRET_A);
    // Investor B sees no connection, and cannot reach A's.
    expect((await call(conn.GET, { path: '/x', cookie: cookies.b })).body.connection).toBeNull();
    expect((await call(meLive.GET, { path: '/x', cookie: cookies.a })).body.entries.reason).toBe('LIVE_PLATFORM_DISABLED');
    // Investors cannot use admin controls.
    expect((await call(platform.POST, { method: 'POST', path: '/x', cookie: cookies.a, body: { enabled: true, note: 'x' } })).status).toBe(403);
  });

  it('the platform switch needs order capability evidence, and activation needs approval', async () => {
    await openFromAlert({ a: null, b: null, market: async () => {} }).catch(() => undefined);
    const r = await call(platform.POST, { method: 'POST', path: '/x', cookie: cookies.admin, body: { enabled: true, note: 'x' } });
    expect(r.status).toBe(409);
    mocks[await userId(A)] = freshMock();
    await call(conn.PUT, { method: 'PUT', path: '/x', cookie: cookies.a, body: { accountRef: 'UID …4821', apiKey: KEY_A, secretKey: SECRET_A } });
    expect((await call(activate.POST, { method: 'POST', path: '/x', cookie: cookies.a })).status).toBe(409);
    // An API key is not an account reference.
    expect((await call(conn.PUT, { method: 'PUT', path: '/x', cookie: cookies.a, body: { accountRef: KEY_A, apiKey: KEY_A, secretKey: SECRET_A } })).status).toBe(400);
  });
});

describe('Live entry, attached stop, partial fill, reduce-only close — next to Paper on the same alert', () => {
  it('opens Paper and Live from one alert with separate accounts; the Live stop covers the confirmed (partial) fill; a manual close is reduce-only', async () => {
    await openFromAlert({
      market: async () => {
        await connectAndBlock('a', A);
        await platformOn();
        (await mockOf(A)).faults.fillRatio = 0.6;
        const { writeMarketFixture } = await import('@trendpilot/db');
        await writeMarketFixture(direct.db, { instrumentId: BTC, interval: '15', endBarOpen: new Date('2026-11-08T09:15:00Z'), count: 260, endClose: '65000', trend: 'UP', quoteAt: clock.now });
      }
    });
    const mx = await mockOf(A);
    const [create] = mx.creates().map((c) => c.body as Record<string, unknown>);
    expect(create).toMatchObject({ symbol: 'BTC_USDT', side: 1, type: 5, leverage: 5, openType: 1, positionMode: 2, lossTrend: 2 });
    expect(create!.stopLossPrice).toBeTruthy();
    expect(String(create!.externalOid)).toMatch(/^tp-/);

    const [lp] = await livePos(A);
    const [pp] = await paperPos(A);
    expect(lp!.paperAccountId).not.toBe(pp!.paperAccountId);
    const requested = (await liveIntents(A))[0]!.contracts;
    expect(D(lp!.contracts).eq(D(requested).times('0.6').floor())).toBe(true);
    expect(lp!.protectionStatus).toBe('PROTECTED');
    expect(D(lp!.stopContracts!).eq(lp!.contracts)).toBe(true);
    const stop = [...mx.stops.values()].find((s) => s.state === 1)!;
    expect(D(stop.vol).eq(lp!.contracts)).toBe(true);
    expect(await paperPos(B)).toHaveLength(1);
    expect(await livePos(B)).toHaveLength(0);

    // Holdings and dashboard keep Live and Paper apart.
    const h = await call(holdings.GET, { path: '/x?mode=LIVE', cookie: cookies.a });
    expect(h.body.positions.map((p: any) => p.mode)).toEqual(['LIVE']);
    expect(h.body.accounts.live.mode).toBe('LIVE');
    expect(h.body.accounts.paper.mode).toBe('PAPER');
    const dl = await call(dashboard.GET, { path: '/x?mode=LIVE', cookie: cookies.a });
    expect(dl.body.mode).toBe('LIVE');
    expect(dl.body.daily.entryFills).toBe(1);
    expect((await call(holdings.GET, { path: '/x?mode=LIVE', cookie: cookies.b })).body.positions).toHaveLength(0);

    // Manual close: reduce-only market close for the MEXC position, never more than it holds.
    clock.now = plus(clock.now, 20);
    setTestClock(() => clock.now);
    await recordMarketTick(direct.db, { instrumentId: BTC, asOf: clock.now, bid: '65099.5', ask: '65100.5', mark: '65100', last: '65100' });
    mx.price.BTC_USDT = '65100';
    const r = await call(closePos.POST, { method: 'POST', path: '/x', cookie: cookies.a, params: { id: lp!.id }, headers: { 'idempotency-key': 'live-close-0001' } });
    expect(r.status).toBe(202);
    await drain(clock.now);
    const close = mx.creates().map((c) => c.body as Record<string, unknown>)[1]!;
    expect(close).toMatchObject({ side: 4, type: 5, reduceOnly: true, positionMode: 2 });
    expect(D(String(close.vol)).eq(lp!.contracts)).toBe(true);
    expect(close.positionId).toBeTruthy();
    const [after] = await livePos(A);
    expect(after!.status).toBe('CLOSED');
    expect(after!.closeReason).toBe('MANUAL_CLOSE');
    expect([...mx.positions.values()].every((p) => D(p.holdVol).isZero())).toBe(true);
    expect([...mx.stops.values()].every((s) => s.state !== 1)).toBe(true);
    // The Paper position is untouched; the Live account reconciles with its own ledger.
    expect((await paperPos(A))[0]!.status).toBe('OPEN');
    expect((await reconcileMyAccount(direct.db, await userId(A), 'LIVE'))!.ok).toBe(true);
    expect((await reconcileMyAccount(direct.db, await userId(A), 'PAPER'))!.ok).toBe(true);
  });

  it('a partial take-profit close resizes the MEXC stop to the remainder', async () => {
    await openFromAlert({
      b: null,
      market: async () => {
        await connectAndBlock('a', A, { block: { takeProfit: { mode: 'FIXED', levels: [{ id: 'tp1', movePct: '1', closePct: '100' }] }, trailing: { enabled: true, activationPct: '5', distancePct: '1', closePct: '50', basis: 'MARK' } } });
        await platformOn();
        const { writeMarketFixture } = await import('@trendpilot/db');
        await writeMarketFixture(direct.db, { instrumentId: BTC, interval: '15', endBarOpen: new Date('2026-11-08T09:15:00Z'), count: 260, endClose: '65000', trend: 'UP', quoteAt: clock.now });
      }
    });
    const mx = await mockOf(A);
    const [lp] = await livePos(A);
    const tick = async (mid: string) => {
      clock.now = plus(clock.now, 10);
      setTestClock(() => clock.now);
      mx.price.BTC_USDT = mid;
      await recordMarketTick(direct.db, { instrumentId: BTC, asOf: clock.now, bid: D(mid).minus('0.5').toFixed(), ask: D(mid).plus('0.5').toFixed(), mark: mid, last: mid });
      await drain(clock.now);
    };
    await tick('65800'); // arms TP (+1%) — nothing closes
    expect(mx.creates()).toHaveLength(1);
    await tick('65600'); // pullback through the target → reduce-only close of the TP share (50%)
    const close = mx.creates()[1]!.body as Record<string, unknown>;
    expect(close).toMatchObject({ side: 4, reduceOnly: true });
    const [after] = await livePos(A);
    expect(after!.status).toBe('OPEN');
    expect(D(after!.contracts).lt(lp!.contracts)).toBe(true);
    expect(after!.protectionStatus).toBe('PROTECTED');
    const active = [...mx.stops.values()].filter((s) => s.state === 1);
    expect(active).toHaveLength(1);
    expect(D(active[0]!.vol).eq(after!.contracts)).toBe(true);
    const place = mx.calls.find((c) => c.path === '/api/v1/private/stoporder/place')!.body as Record<string, unknown>;
    expect(place).toMatchObject({ stopLossReverse: 2, takeProfitReverse: 2, stopLossType: 0 });
  });
});

describe('Operator halt, missing stop, uncertain submission', () => {
  const setup = async (o: { fault?: (m: MockMexc) => void } = {}) =>
    openFromAlert({
      b: null,
      market: async () => {
        await connectAndBlock('a', A);
        await platformOn();
        o.fault?.(await mockOf(A));
        const { writeMarketFixture } = await import('@trendpilot/db');
        await writeMarketFixture(direct.db, { instrumentId: BTC, interval: '15', endBarOpen: new Date('2026-11-08T09:15:00Z'), count: 260, endClose: '65000', trend: 'UP', quoteAt: clock.now });
      }
    });

  it('halting entries refuses the next Live entry (also at submission) while closes keep working', async () => {
    await setup();
    const [lp] = await livePos(A);
    expect((await call(platformHalt.POST, { method: 'POST', path: '/x', cookie: cookies.admin, body: { reason: 'operator review' } })).status).toBe(200);
    const r = await call(closePos.POST, { method: 'POST', path: '/x', cookie: cookies.a, params: { id: lp!.id }, headers: { 'idempotency-key': 'live-close-0002' } });
    expect(r.status).toBe(202);
    await drain(clock.now);
    expect((await livePos(A))[0]!.status).toBe('CLOSED');
    await nextAlert('BULLISH_FLIP');
    const skipped = (await decisionsOf(A)).filter((d) => d.reason === 'LIVE_NOT_ELIGIBLE');
    expect(skipped.map((d) => (d.detail as any).liveReason)).toContain('LIVE_PLATFORM_HALTED');
    expect((await mockOf(A)).creates()).toHaveLength(2); // entry + close only
  });

  it('a gate closed between evaluation and submission rejects in the worker without sending', async () => {
    await setup();
    await call(closePos.POST, { method: 'POST', path: '/x', cookie: cookies.a, params: { id: (await livePos(A))[0]!.id }, headers: { 'idempotency-key': 'live-close-0003' } });
    await drain(clock.now);
    // Next alert: approved in phase 1, then the investor halts before the worker submits.
    const bar = new Date(new Date('2026-11-08T09:15:00Z').getTime() + M15);
    clock.now = plus(new Date(bar.getTime() + M15), 3);
    setTestClock(() => clock.now);
    await recordMarketTick(direct.db, { instrumentId: BTC, asOf: clock.now, bid: '64999.5', ask: '65000.5', mark: '65000', last: '65000' });
    expect(await deliver('BULLISH_FLIP', bar)).toBe(202);
    const { processNextJob } = await import('@trendpilot/db');
    // Run jobs until the signal dispatch (phase 1) has run; the submit job is still pending.
    for (let i = 0; i < 10; i++) if ((await processNextJob(direct.db, { workerId: 'test', now: clock.now })).summary) break;
    expect((await liveIntents(A)).at(-1)!.state).toBe('INTENT');
    expect((await call(meHalt.POST, { method: 'POST', path: '/x', cookie: cookies.a, body: { reason: 'stop for today' } })).status).toBe(200);
    await drain(clock.now);
    const last = (await liveIntents(A)).at(-1)!;
    expect(last.state).toBe('REJECTED');
    expect(last.stateReason).toBe('LIVE_REFUSED:LIVE_ACCOUNT_HALTED');
    expect((await mockOf(A)).creates()).toHaveLength(2);
    const acct = (await getMyPaperAccount(direct.db, await userId(A), 'LIVE'))!;
    expect(D(acct.orderReserveUsdt).isZero()).toBe(true);
  });

  it('a fill without a verified stop is closed at once and halts the account; resume needs a review note', async () => {
    await setup({ fault: (m) => (m.faults.attachStop = 'missing') });
    const [lp] = await livePos(A);
    expect(lp!.status).toBe('CLOSED');
    expect(lp!.closeReason).toBe('PROTECTION_FAILURE');
    const c = await connRow(A);
    expect(c.entriesHalted).toBe(true);
    expect(c.haltReason).toMatch(/^PROTECTION_FAILURE/);
    expect((await call(connResume.POST, { method: 'POST', path: '/x', cookie: cookies.admin, params: { id: c.id }, body: {} })).status).toBe(400);
    expect((await call(connResume.POST, { method: 'POST', path: '/x', cookie: cookies.admin, params: { id: c.id }, body: { note: 'reviewed on MEXC' } })).status).toBe(200);
  });

  it('a timeout after MEXC accepted the order halts entries and is reconciled by client order ID before any retry (one order only)', async () => {
    await setup({
      fault: (m) => {
        m.faults.timeoutAfterAccept = 1;
        // Not visible to the lookup right after the timeout: the outcome is unknown.
        m.faults.invisibleLookups = 1;
      }
    });
    const [intent] = await liveIntents(A);
    expect(intent!.state).toBe('SUBMITTING');
    expect((await connRow(A)).haltReason).toMatch(/^UNCERTAIN_ORDER/);
    const c = await connRow(A);
    expect((await call(connResume.POST, { method: 'POST', path: '/x', cookie: cookies.admin, params: { id: c.id }, body: { note: 'x' } })).status).toBe(409);
    clock.now = plus(clock.now, 40);
    setTestClock(() => clock.now);
    await drain(clock.now);
    const [after] = await liveIntents(A);
    expect(after!.state).toBe('FILLED');
    expect((await mockOf(A)).creates()).toHaveLength(1);
    expect((await livePos(A))[0]!.protectionStatus).toBe('PROTECTED');
  });
});

describe('Uncertain order that stays invisible past the grace period', () => {
  it('never sends a second order while halted; the private sync then flags the exposure as drift', async () => {
    await openFromAlert({
      b: null,
      market: async () => {
        await connectAndBlock('a', A);
        await platformOn();
        const m = await mockOf(A);
        m.faults.timeoutAfterAccept = 1;
        m.faults.invisibleLookups = 2;
        const { writeMarketFixture } = await import('@trendpilot/db');
        await writeMarketFixture(direct.db, { instrumentId: BTC, interval: '15', endBarOpen: new Date('2026-11-08T09:15:00Z'), count: 260, endClose: '65000', trend: 'UP', quoteAt: clock.now });
      }
    });
    clock.now = plus(clock.now, 40);
    setTestClock(() => clock.now);
    await drain(clock.now);
    const [intent] = await liveIntents(A);
    expect(intent!.state).toBe('REJECTED');
    expect(intent!.stateReason).toBe('LIVE_REFUSED:LIVE_ACCOUNT_HALTED');
    expect((await mockOf(A)).creates()).toHaveLength(1); // the retry was refused: no duplicate
    const r = await syncLiveAccount(direct.db, await userId(A), plus(clock.now, 5));
    expect(r.drift.map((d) => d.kind)).toEqual(['UNKNOWN_EXPOSURE']);
    expect((await connRow(A)).entriesHalted).toBe(true);
  });
});

describe('Private sync: balances, exchange-side stop, drift', () => {
  it('books a stop triggered at MEXC once, follows the MEXC balance, and halts on unknown exposure until reviewed', async () => {
    await openFromAlert({
      b: null,
      market: async () => {
        await connectAndBlock('a', A);
        await platformOn();
        const { writeMarketFixture } = await import('@trendpilot/db');
        await writeMarketFixture(direct.db, { instrumentId: BTC, interval: '15', endBarOpen: new Date('2026-11-08T09:15:00Z'), count: 260, endClose: '65000', trend: 'UP', quoteAt: clock.now });
      }
    });
    const mx = await mockOf(A);
    const owner = await userId(A);
    mx.assets = { equity: '987.5', availableOpen: '960', unrealized: '-2.5' };
    mx.liquidatePrice = '52000';
    mx.holdFee = '-0.012';
    let r = await syncLiveAccount(direct.db, owner, clock.now);
    expect(r.ok).toBe(true);
    expect(r.drift).toHaveLength(0);
    const acct = (await getMyPaperAccount(direct.db, owner, 'LIVE'))!;
    expect(D(acct.walletBalanceUsdt).eq('990')).toBe(true); // equity − unrealized
    expect(acct.exchange!.availableUsdt).toBe('960');
    let [lp] = await livePos(A);
    expect(lp!.exchangeLiquidationPrice && D(lp!.exchangeLiquidationPrice).eq('52000')).toBe(true);
    expect(D(lp!.exchangeFundingUsdt!).eq('-0.012')).toBe(true);

    // MEXC triggers the stop: the sync books it as STOP_LOSS, exactly once.
    const stop = [...mx.stops.values()].find((s) => s.state === 1)!;
    mx.triggerStop(stop.id, D(lp!.stopPrice).minus(1).toFixed());
    r = await syncLiveAccount(direct.db, owner, plus(clock.now, 5));
    expect(r.exitsRecorded).toBe(1);
    r = await syncLiveAccount(direct.db, owner, plus(clock.now, 10));
    expect(r.exitsRecorded).toBe(0);
    [lp] = await livePos(A);
    expect(lp!.status).toBe('CLOSED');
    expect(lp!.closeReason).toBe('STOP_LOSS');
    expect(await direct.db.select().from(schema.positionExits).where(eq(schema.positionExits.positionId, lp!.id))).toHaveLength(1);
    expect((await reconcileMyAccount(direct.db, owner, 'LIVE'))!.ok).toBe(true);

    // Exposure opened directly on MEXC on a contract TrendPilot trades: drift, entries halted.
    mx.externalOpen('BTC_USDT', 2, '3', '65000');
    r = await syncLiveAccount(direct.db, owner, plus(clock.now, 15));
    expect(r.drift.map((d) => d.kind)).toEqual(['UNKNOWN_EXPOSURE']);
    const c = await connRow(A);
    expect(c.entriesHalted).toBe(true);
    expect((await call(connResume.POST, { method: 'POST', path: '/x', cookie: cookies.admin, params: { id: c.id }, body: { note: 'x' } })).status).toBe(409);
    mx.manualClose('BTC_USDT', 2, '3', '65000');
    expect((await call(clearDrift.POST, { method: 'POST', path: '/x', cookie: cookies.admin, params: { id: c.id }, body: { note: 'closed the manual short on MEXC' } })).status).toBe(200);
    expect((await syncLiveAccount(direct.db, owner, plus(clock.now, 20))).drift).toHaveLength(0);
    expect((await call(connResume.POST, { method: 'POST', path: '/x', cookie: cookies.admin, params: { id: c.id }, body: { note: 'flat again' } })).status).toBe(200);
  });

  it('a position reduced by a manual close on MEXC is booked as EXTERNAL_CLOSE and the stop is re-checked', async () => {
    await openFromAlert({
      b: null,
      market: async () => {
        await connectAndBlock('a', A);
        await platformOn();
        const { writeMarketFixture } = await import('@trendpilot/db');
        await writeMarketFixture(direct.db, { instrumentId: BTC, interval: '15', endBarOpen: new Date('2026-11-08T09:15:00Z'), count: 260, endClose: '65000', trend: 'UP', quoteAt: clock.now });
      }
    });
    const mx = await mockOf(A);
    const owner = await userId(A);
    const [lp] = await livePos(A);
    mx.manualClose('BTC_USDT', 1, lp!.contracts.replace(/\.0+$/, ''), '65200');
    const r = await syncLiveAccount(direct.db, owner, plus(clock.now, 5));
    expect(r.exitsRecorded).toBe(1);
    const [after] = await livePos(A);
    expect(after!.status).toBe('CLOSED');
    expect(after!.closeReason).toBe('EXTERNAL_CLOSE');
  });
});

describe('Two investors on the same contract', () => {
  it('each Live order goes to the investor’s own MEXC account; private records stay isolated', async () => {
    await openFromAlert({
      market: async () => {
        await connectAndBlock('a', A);
        await connectAndBlock('b', B);
        await platformOn();
        const { writeMarketFixture } = await import('@trendpilot/db');
        await writeMarketFixture(direct.db, { instrumentId: BTC, interval: '15', endBarOpen: new Date('2026-11-08T09:15:00Z'), count: 260, endClose: '65000', trend: 'UP', quoteAt: clock.now });
      }
    });
    const ma = await mockOf(A);
    const mb = await mockOf(B);
    expect(ma.creates()).toHaveLength(1);
    expect(mb.creates()).toHaveLength(1);
    const [la] = await livePos(A);
    const [lb] = await livePos(B);
    expect(la!.paperAccountId).not.toBe(lb!.paperAccountId);
    // B cannot close A's position, and sees only their own holdings.
    expect((await call(closePos.POST, { method: 'POST', path: '/x', cookie: cookies.b, params: { id: la!.id }, headers: { 'idempotency-key': 'cross-close-0001' } })).status).toBe(404);
    const hb = await call(holdings.GET, { path: '/x', cookie: cookies.b });
    expect(hb.body.positions.every((p: any) => p.id !== la!.id)).toBe(true);
    // A's close reaches only A's exchange account.
    await call(closePos.POST, { method: 'POST', path: '/x', cookie: cookies.a, params: { id: la!.id }, headers: { 'idempotency-key': 'live-close-0004' } });
    await drain(clock.now);
    expect(ma.creates()).toHaveLength(2);
    expect(mb.creates()).toHaveLength(1);
    expect((await livePos(B))[0]!.status).toBe('OPEN');
  });
});

describe('Deployment transport off', () => {
  it('refuses Live entries at evaluation with LIVE_TRANSPORT_DISABLED and sends nothing', async () => {
    await openFromAlert({
      b: null,
      market: async () => {
        await connectAndBlock('a', A);
        await platformOn();
        transportEnabled = false;
        const { writeMarketFixture } = await import('@trendpilot/db');
        await writeMarketFixture(direct.db, { instrumentId: BTC, interval: '15', endBarOpen: new Date('2026-11-08T09:15:00Z'), count: 260, endClose: '65000', trend: 'UP', quoteAt: clock.now });
      }
    });
    const live = (await decisionsOf(A)).find((d) => d.reason === 'LIVE_NOT_ELIGIBLE');
    expect((live!.detail as any).liveReason).toBe('LIVE_TRANSPORT_DISABLED');
    expect((await mockOf(A)).creates()).toHaveLength(0);
  });

  it('refuses limits: an order above the approved notional is skipped', async () => {
    await openFromAlert({
      b: null,
      market: async () => {
        await connectAndBlock('a', A, { block: { orderCostUsdt: '200', leverage: 5 } }); // 1000 USDT notional > 500
        await platformOn();
        const { writeMarketFixture } = await import('@trendpilot/db');
        await writeMarketFixture(direct.db, { instrumentId: BTC, interval: '15', endBarOpen: new Date('2026-11-08T09:15:00Z'), count: 260, endClose: '65000', trend: 'UP', quoteAt: clock.now });
      }
    });
    const live = (await decisionsOf(A)).find((d) => d.reason === 'LIVE_NOT_ELIGIBLE');
    expect((live!.detail as any).liveReason).toBe('LIVE_ORDER_NOTIONAL');
  });
});
