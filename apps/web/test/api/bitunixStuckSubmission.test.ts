// 19 Nov 2026 incident: a Bitunix Live OPEN stayed SUBMITTING with its reservation held after its
// submit job stopped retrying (DEAD), while private sync kept reporting "TrendPilot matches Bitunix"
// and order pushes only reached the account mirror. Reproduced through the REAL flow (Live gates,
// reservation, paper.submit job, Live guard, Bitunix venue) against a MOCKED Bitunix exchange:
//  - a lost REST response followed by a WebSocket fill, recovered after the job died;
//  - a missed WebSocket event, recovered through the REST sync alone;
//  - a failure before transmission: unresolved inside the visibility window, then released once
//    Bitunix evidence shows the order never existed;
//  - an order push arriving before the submit job's own result: booked once;
//  - repeated reconciliation and duplicate pushes change nothing;
//  - the private order frame parsed with Bitunix's actual fields.
import { and, desc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyBitunixEvent,
  BitunixPrivateError,
  BitunixQuoteWriter,
  evaluateAndReserveEntry,
  ExchangePriceCache,
  installBitunixTestSeam,
  installLiveTestSeam,
  parseBitunixPrivateFrame,
  reconcileBitunixIntents,
  requestExit,
  schema,
  syncBitunixConnection,
  type ConnectionRow
} from '@trendpilot/db';
import { Decimal } from '@trendpilot/domain';
import * as blocks from '@/app/v1/me/order-blocks/route';
import * as resume from '@/app/v1/me/order-blocks/[id]/resume/route';
import * as conn from '@/app/v1/me/exchange-connection/route';
import * as activate from '@/app/v1/me/live/activate/route';
import * as bitunixInstrument from '@/app/v1/admin/instruments/bitunix/route';
import * as approve from '@/app/v1/admin/live/connections/[id]/approve/route';
import * as capabilities from '@/app/v1/admin/live/capabilities/route';
import * as contracts from '@/app/v1/admin/live/contracts/[id]/route';
import * as platform from '@/app/v1/admin/live/platform/route';
import { setTestClock } from '@/server/clock';
import { BTC, blockBody, call, direct, teardown, userId, USERS } from '../helpers';
import { MockBitunixExchange } from '../bitunixOrderMock';
import { MockMexc } from '../mexcMock';
import { ALL_DAYS, clock, cookies, deliver, drain, M15, openFromAlert, plus, publishVersion } from '../paperReplay';

const A = USERS.investorA.email;
const D = (v: Decimal.Value) => new Decimal(v);
const LIMITS = { maxOrderContracts: '1', maxOrderNotionalUsdt: '500', maxLeverage: 10, maxExposureUsdt: '1000' };
const x = new MockBitunixExchange();
const mexc = new MockMexc();
let idA: string;
let bxInstrument: string;
let blockA: string;
let versionId: string;
let bar = new Date('2026-11-08T09:15:00Z');
const cache = new ExchangePriceCache();
const FAST = { lookup: { attempts: 1, delayMs: 0 }, confirm: { attempts: 2, delayMs: 0 } };

const bxConn = async (): Promise<ConnectionRow> => (await direct.db.select().from(schema.exchangeConnections).where(and(eq(schema.exchangeConnections.ownerId, idA), eq(schema.exchangeConnections.exchange, 'BITUNIX'))))[0]!;
const bxAccount = async () => (await direct.db.select().from(schema.paperAccounts).where(eq(schema.paperAccounts.ownerId, idA))).find((a) => a.mode === 'LIVE' && a.exchange === 'BITUNIX')!;
const intent = async (id: string) => (await direct.db.select().from(schema.orderIntents).where(eq(schema.orderIntents.id, id)))[0]!;
const openPositions = async () => (await direct.db.select().from(schema.positions).where(and(eq(schema.positions.ownerId, idA), eq(schema.positions.mode, 'LIVE')))).filter((p) => p.status === 'OPEN');
const fillsOf = async (intentId: string) => direct.db.select().from(schema.fills).where(eq(schema.fills.intentId, intentId));
const ledgerOf = async (intentId: string) => direct.db.select().from(schema.ledgerEntries).where(eq(schema.ledgerEntries.refId, intentId));
const jobOf = async (intentId: string) => (await direct.db.select().from(schema.jobs).where(eq(schema.jobs.dedupeKey, `paper.submit:${intentId}`)))[0]!;
/** The submit job ran out of attempts (as in production): it will never run again. */
const killJob = async (intentId: string) => direct.db.update(schema.jobs).set({ status: 'DEAD', attempts: 8, lastError: 'UncertainSubmissionError: mocked', claimToken: null, claimExpiresAt: null }).where(eq(schema.jobs.dedupeKey, `paper.submit:${intentId}`));
const sync = async (o: { visibilityMs?: number } = {}) => syncBitunixConnection(direct.db, (await bxConn()).id, x, { now: () => clock.now, intents: { ...FAST, ...o } });
const unhalt = async () => direct.db.update(schema.exchangeConnections).set({ entriesHalted: false, haltReason: null }).where(eq(schema.exchangeConnections.id, (await bxConn()).id));

/** Bitunix's private order push for the order with this clientId, as Bitunix frames it. */
function orderFrame(clientId: string, status: string) {
  const o = x.orders.get(clientId)!;
  const iso = (ms: number) => new Date(ms).toISOString().replace('Z', '123456Z'); // nanosecond ISO, as Bitunix sends
  return parseBitunixPrivateFrame(
    {
      ch: 'order',
      ts: o.mtime,
      data: { event: 'UPDATE', orderId: o.orderId, clientId, symbol: o.symbol, side: o.side, type: 'MARKET', qty: o.qty, dealAmount: o.tradeQty, averagePrice: o.price, fee: '0.01', orderStatus: status, ctime: iso(o.ctime), mtime: iso(o.mtime), positionMode: 'HEDGE' }
    },
    clock.now,
    (() => {
      let n = 0;
      return () => ++n;
    })()
  )[0]!;
}

async function bitunixQuote(bid = '63999.9', ask = '64000.1', mark = '64000') {
  const at = clock.now;
  cache.putBook('BITUNIX', 'BTCUSDT', { bid, ask, last: mark, exchangeTimeMs: at.getTime(), receivedAt: at });
  cache.putMark('BITUNIX', 'BTCUSDT', { mark, index: mark, exchangeTimeMs: at.getTime(), receivedAt: at });
  const w = new BitunixQuoteWriter(direct.db, cache, { minIntervalMs: 0 });
  await w.refresh();
  await w.onUpdate('BTCUSDT', at);
}

/** A new alert bar, a fresh quote, then the real entry evaluation (reservation + paper.submit job). */
async function enterLong(): Promise<string> {
  bar = new Date(bar.getTime() + M15);
  clock.now = plus(new Date(bar.getTime() + M15), 3);
  setTestClock(() => clock.now);
  expect(await deliver('BULLISH_FLIP', bar, '64000.0')).toBe(202);
  await drain(clock.now);
  await bitunixQuote();
  const [event] = await direct.db.select().from(schema.signalEvents).orderBy(desc(schema.signalEvents.receivedAt)).limit(1);
  const [block] = await direct.db.select().from(schema.orderBlocks).where(eq(schema.orderBlocks.id, blockA));
  const [version] = await direct.db.select().from(schema.strategyVersions).where(eq(schema.strategyVersions.id, versionId));
  const out = await direct.db.transaction((tx) => evaluateAndReserveEntry(tx, { event: event!, block: block!, version: version!, side: 'LONG', now: clock.now }));
  expect(out).toMatchObject({ status: 'ENTRY_APPROVED' });
  return out.intentId!;
}

/** Flat again for the next test (one unresolved intent per scope). */
async function closeAll() {
  for (const p of await openPositions()) {
    await direct.db.transaction((tx) => requestExit(tx, { position: p, reason: 'MANUAL_CLOSE', now: clock.now }));
    await drain(clock.now);
  }
  expect(await openPositions()).toHaveLength(0);
  await unhalt();
}

beforeAll(async () => {
  await openFromAlert({ a: null, b: null });
  idA = await userId(A);
  mexc.positionMode = 2;
  installLiveTestSeam({ requesterFor: () => mexc, bitunixRequesterFor: () => x, transportEnabled: true, confirm: { attempts: 2, delayMs: 0 } });
  installBitunixTestSeam({ requesterFor: () => x });
  x.usdt.available = '1000';
  x.setSettings('BTCUSDT', { longLeverage: 10, shortLeverage: 10 });
  const added = await call(bitunixInstrument.POST, { method: 'POST', path: '/x', cookie: cookies.admin, body: { symbol: 'BITUNIX:BTCUSDT.P' } });
  expect(added.status).toBe(200);
  bxInstrument = added.body.instrument.id;
  await direct.db.update(schema.instruments).set({ status: 'PUBLISHED', isFixture: false }).where(eq(schema.instruments.id, bxInstrument));
  versionId = await publishVersion({ instrumentIds: [BTC, bxInstrument] });
  expect((await call(contracts.POST, { method: 'POST', path: '/x', cookie: cookies.admin, params: { id: bxInstrument }, body: { allowed: true } })).status).toBe(200);
  for (const c of ['OPEN_WITH_ATTACHED_STOP', 'REDUCE_ONLY_CLOSE', 'STOP_RESIZE_AFTER_PARTIAL_CLOSE', 'CANCEL_STOP', 'BITUNIX_OPEN_WITH_ATTACHED_STOP', 'BITUNIX_HEDGE_CLOSE_BY_POSITION'])
    expect((await call(capabilities.POST, { method: 'POST', path: '/x', cookie: cookies.admin, body: { capability: c, state: 'PILOT_ACCEPTED', evidence: 'test: mocked exchange' } })).status).toBe(200);
  expect((await call(platform.POST, { method: 'POST', path: '/x', cookie: cookies.admin, body: { enabled: true, note: 'test' } })).status).toBe(200);
  expect((await call(conn.PUT, { method: 'PUT', cookie: cookies.a, body: { exchange: 'BITUNIX', accountRef: 'bx-a', apiKey: 'bitunix-key-A-1111', secretKey: 'bitunix-key-A-1111-secret' } })).body.connection).toMatchObject({ status: 'VERIFIED', positionMode: 'HEDGE' });
  expect((await call(approve.POST, { method: 'POST', path: '/x', cookie: cookies.admin, params: { id: (await bxConn()).id }, body: LIMITS })).status).toBe(200);
  expect((await call(activate.POST, { method: 'POST', path: '/v1/me/live/activate?exchange=BITUNIX', cookie: cookies.a })).status).toBe(200);
  expect((await sync()).ok).toBe(true);
  const created = await call(blocks.POST, { method: 'POST', path: '/x', cookie: cookies.a, body: blockBody({ instrumentId: bxInstrument, strategyVersionId: versionId, mode: 'LIVE', orderCostUsdt: '20', leverage: 10, weekdays: ALL_DAYS }) });
  expect(created.status).toBe(201);
  blockA = created.body.id;
  expect((await call(resume.POST, { method: 'POST', path: '/x', cookie: cookies.a, params: { id: blockA }, ifMatch: created.body.revision })).status).toBe(200);
});
beforeEach(() => {
  x.next = {};
  x.detailFailures = 0;
});
afterAll(async () => {
  installLiveTestSeam(null);
  installBitunixTestSeam(null);
  setTestClock(null);
  await teardown();
});

describe('private order frame (Bitunix field names)', () => {
  it('reads channel order, data object, orderStatus, clientId/orderId, ISO ctime/mtime and the gateway ts in ms', () => {
    const [e] = parseBitunixPrivateFrame(
      { ch: 'order', ts: 1795545901234, data: { event: 'UPDATE', orderId: '11111', clientId: 'e6d08d8e7da84c0696edd8ae89a435c3', symbol: 'XAUUSDT', side: 'BUY', type: 'MARKET', qty: '0.026', dealAmount: '0.026', averagePrice: '4061.2', fee: '0.06', orderStatus: 'FILLED', ctime: '2026-11-19T04:05:01.123456789Z', mtime: '2026-11-19T04:05:01.456Z' } },
      new Date(),
      () => 1
    );
    expect(e).toMatchObject({ channel: 'order', orderId: '11111', clientId: 'e6d08d8e7da84c0696edd8ae89a435c3', origin: 'TRENDPILOT', status: 'FILLED', qty: '0.026', dealAmount: '0.026', tsMs: 1795545901234, ctimeMs: Date.parse('2026-11-19T04:05:01.123Z'), mtimeMs: Date.parse('2026-11-19T04:05:01.456Z') });
    for (const s of ['NEW', 'PART_FILLED', 'CANCELED', 'PART_FILLED_CANCELED'])
      expect(parseBitunixPrivateFrame({ ch: 'order', ts: 1, data: { orderId: '1', symbol: 'XAUUSDT', orderStatus: s } }, new Date(), () => 1)[0]).toMatchObject({ status: s, origin: 'EXCHANGE' });
  });
});

describe('stuck SUBMITTING Bitunix entries are settled from exchange evidence', () => {
  it('lost REST response, job DEAD, then a WebSocket fill: the push keeps the order ID, the sync books it once', async () => {
    const id = await enterLong();
    const before = await bxAccount();
    // Bitunix accepts and fills, but the response is lost and every lookup fails: uncertain.
    x.next = { timeout: 'AFTER_ACCEPT', lookupsFailAfterAccept: 100 };
    await drain(clock.now);
    expect(await intent(id)).toMatchObject({ state: 'SUBMITTING' });
    expect((await intent(id)).venueRequest).toMatchObject({ path: '/api/v1/futures/trade/place_order', body: { clientId: (await intent(id)).clientOrderId, side: 'BUY', tradeSide: 'OPEN' } });
    expect((await intent(id)).venueResponse).toMatchObject({ code: 'TIMEOUT' });
    expect((await intent(id)).lastReconcileNote).toMatch(/UncertainSubmissionError/);
    await killJob(id);
    x.detailFailures = 0;
    const clientId = (await intent(id)).clientOrderId;
    const orderId = x.orders.get(clientId)!.orderId;

    // The push: matched by connection owner + clientId; order ID kept; reconciliation queued.
    const pushed = await applyBitunixEvent(direct.db, await bxConn(), orderFrame(clientId, 'FILLED'));
    expect(pushed).toMatchObject({ needsSync: true });
    expect(await intent(id)).toMatchObject({ state: 'SUBMITTING', exchangeOrderId: orderId });
    // Duplicate delivery: nothing new.
    expect(await applyBitunixEvent(direct.db, await bxConn(), orderFrame(clientId, 'FILLED'))).toMatchObject({ needsSync: true });
    expect(await intent(id)).toMatchObject({ state: 'SUBMITTING', exchangeOrderId: orderId });

    const r = await sync();
    expect(r.ok).toBe(true);
    expect(r.intents).toEqual([expect.objectContaining({ intentId: id, clientOrderId: clientId, result: 'FILLED', exchangeOrderId: orderId, jobStatus: 'DEAD (8/8)' })]);
    expect(await intent(id)).toMatchObject({ state: 'FILLED', exchangeOrderId: orderId, clientOrderId: clientId });
    expect(await fillsOf(id)).toHaveLength(1);
    const [p] = await openPositions();
    expect(p).toMatchObject({ openIntentId: id, contracts: '0.003100000000', exchangePositionRef: x.legOf('BTCUSDT', 'LONG')!.positionId, protectionStatus: 'PROTECTED' });
    expect(D((await bxAccount()).orderReserve).eq(before.orderReserve) || D((await bxAccount()).orderReserve).isZero()).toBe(true);
    // Reservation converted exactly once.
    expect((await ledgerOf(id)).filter((l) => l.kind === 'ORDER_RESERVE_RELEASE')).toHaveLength(1);
    expect(x.posts.filter((b) => b.clientId === clientId)).toHaveLength(1);

    // Repeated reconciliation is idempotent.
    const again = await sync();
    expect(again.intents ?? []).toHaveLength(0);
    expect(await fillsOf(id)).toHaveLength(1);
    expect((await ledgerOf(id)).length).toBe((await ledgerOf(id)).length);
    expect(await openPositions()).toHaveLength(1);
    await closeAll();
  });

  it('missed WebSocket event: the REST sync alone recovers the fill by the original clientId', async () => {
    const id = await enterLong();
    x.next = { timeout: 'AFTER_ACCEPT', lookupsFailAfterAccept: 100 };
    await drain(clock.now);
    await killJob(id);
    x.detailFailures = 0;
    const clientId = (await intent(id)).clientOrderId;
    // No push at all (reconnect gap). A lookup that is briefly unavailable stays unresolved.
    x.detailFailures = 1;
    const first = await sync();
    expect(first.intents).toEqual([expect.objectContaining({ intentId: id, result: 'PENDING' })]);
    expect(await intent(id)).toMatchObject({ state: 'SUBMITTING', reconcileAttempts: 1 });
    expect((await intent(id)).lastReconcileNote).toMatch(/lookup by clientId failed/);
    const r = await sync();
    expect(r.intents).toEqual([expect.objectContaining({ intentId: id, result: 'FILLED', exchangeOrderId: x.orders.get(clientId)!.orderId })]);
    expect(await intent(id)).toMatchObject({ state: 'FILLED', clientOrderId: clientId, reconcileAttempts: 2 });
    expect(await fillsOf(id)).toHaveLength(1);
    expect(x.posts.filter((b) => b.clientId === clientId)).toHaveLength(1);
    await closeAll();
  });

  it('failed before transmission: unresolved inside the visibility window, then released once Bitunix shows no such order', async () => {
    const id = await enterLong();
    const reserved = (await intent(id)).reservedUsdt;
    const reserveBefore = D((await bxAccount()).orderReserve);
    x.detailFailures = 100; // the pre-send lookup fails: nothing is sent
    await drain(clock.now);
    const cid = (await intent(id)).clientOrderId;
    expect(x.posts.filter((b) => b.clientId === cid)).toHaveLength(0);
    expect(await intent(id)).toMatchObject({ state: 'SUBMITTING', venueRequest: null });
    expect((await intent(id)).venueResponse).toMatchObject({ code: 'NOT_SENT' });
    // While the job may still retry, absence never releases anything.
    x.detailFailures = 0;
    const early = await sync({ visibilityMs: 0 });
    expect(early.intents).toEqual([expect.objectContaining({ result: 'PENDING', detail: expect.stringMatching(/submit job is still PENDING/) })]);
    await killJob(id);
    // Inside the visibility window: still unresolved, reservation held.
    const inWindow = await sync();
    expect(inWindow.intents).toEqual([expect.objectContaining({ result: 'PENDING', detail: expect.stringMatching(/visibility window/) })]);
    expect(D((await bxAccount()).orderReserve).eq(reserveBefore)).toBe(true);
    const clientId = (await intent(id)).clientOrderId;
    clock.now = plus(clock.now, 11 * 60);
    // Confirmed absence after the window: EXPIRED + reservation released atomically, once.
    const done = await sync();
    expect(done.intents).toEqual([expect.objectContaining({ intentId: id, result: 'NOT_AT_VENUE' })]);
    expect(await intent(id)).toMatchObject({ state: 'EXPIRED', clientOrderId: clientId });
    expect((await intent(id)).stateReason).toMatch(/^RECONCILED_NOT_AT_VENUE: Bitunix has no order with clientId/);
    expect(D((await bxAccount()).orderReserve).eq(reserveBefore.minus(reserved))).toBe(true);
    expect((await ledgerOf(id)).filter((l) => l.kind === 'ORDER_RESERVE_RELEASE')).toEqual([expect.objectContaining({ amount: D(reserved).neg().toFixed(8) })]);
    // Idempotent: nothing left to reconcile, nothing released twice, nothing ever sent.
    expect((await sync()).intents ?? []).toHaveLength(0);
    expect((await ledgerOf(id)).filter((l) => l.kind === 'ORDER_RESERVE_RELEASE')).toHaveLength(1);
    expect(x.posts.filter((b) => b.clientId === clientId)).toHaveLength(0);
    expect((await jobOf(id)).status).toBe('DEAD');
    await unhalt();
  });

  it('an order push before the submit job has its result: booked once, the job then finds it filled', async () => {
    const id = await enterLong();
    x.next = { timeout: 'AFTER_ACCEPT', lookupsFailAfterAccept: 100 };
    await drain(clock.now); // job left PENDING for a retry
    x.detailFailures = 0;
    expect((await jobOf(id)).status).toBe('PENDING');
    const clientId = (await intent(id)).clientOrderId;
    await applyBitunixEvent(direct.db, await bxConn(), orderFrame(clientId, 'FILLED'));
    const r = await sync();
    expect(r.intents).toEqual([expect.objectContaining({ result: 'FILLED' })]);
    clock.now = plus(clock.now, 5);
    await bitunixQuote();
    await drain(clock.now);
    expect((await jobOf(id)).status).toBe('DONE');
    expect(await intent(id)).toMatchObject({ state: 'FILLED' });
    expect(await fillsOf(id)).toHaveLength(1);
    expect(await openPositions()).toHaveLength(1);
    expect(x.posts.filter((b) => b.clientId === clientId)).toHaveLength(1);
    await closeAll();
  });

  it('dry run (ops trace) reports the outcome and writes nothing', async () => {
    const id = await enterLong();
    x.next = { timeout: 'AFTER_ACCEPT', lookupsFailAfterAccept: 100 };
    await drain(clock.now);
    await killJob(id);
    x.detailFailures = 0;
    const before = await intent(id);
    const out = await reconcileBitunixIntents(direct.db, await bxConn(), x, clock.now, { ...FAST, clientOrderId: before.clientOrderId, apply: false });
    expect(out).toEqual([expect.objectContaining({ result: 'FILLED', detail: expect.stringMatching(/dry run/) })]);
    expect(await intent(id)).toMatchObject({ state: 'SUBMITTING', reconcileAttempts: before.reconcileAttempts, exchangeOrderId: null });
    expect(await fillsOf(id)).toHaveLength(0);
    expect((await reconcileBitunixIntents(direct.db, await bxConn(), x, clock.now, { ...FAST, clientOrderId: before.clientOrderId }))[0]).toMatchObject({ result: 'FILLED' });
    await closeAll();
  });
  it('an order Bitunix ever listed with this clientId (even on a row tagged with a subAccountId, as production returns) is never released, even if a later read misses it', async () => {
    const id = await enterLong();
    x.detailFailures = 100; // nothing sent
    await drain(clock.now);
    await killJob(id);
    x.detailFailures = 0;
    const clientId = (await intent(id)).clientOrderId;
    const reserveBefore = D((await bxAccount()).orderReserve);
    clock.now = plus(clock.now, 11 * 60);
    x.historyOrders.push({ orderId: '777', clientId, subAccountId: '891435181', symbol: 'BTCUSDT', side: 'BUY', qty: '0.0031', tradeQty: '0', status: 'CANCELED', ctime: clock.now.getTime(), mtime: clock.now.getTime() });
    expect((await sync()).intents).toEqual([expect.objectContaining({ result: 'PENDING', exchangeOrderId: '777' })]);
    x.historyOrders = [];
    const later = await sync();
    expect(later.intents).toEqual([expect.objectContaining({ result: 'PENDING', detail: expect.stringMatching(/its Bitunix order ID 777 is known|reported this clientId to TrendPilot before/) })]);
    expect(await intent(id)).toMatchObject({ state: 'SUBMITTING', exchangeOrderId: '777' });
    expect(D((await bxAccount()).orderReserve).eq(reserveBefore)).toBe(true);
    // Test cleanup only (frees the scope for the next tests): not a recovery path.
    await direct.db.update(schema.orderIntents).set({ state: 'CANCELLED', resolvedAt: clock.now }).where(eq(schema.orderIntents.id, id));
    await unhalt();
  });
});

/** Bitunix over HTTP for the REAL transport: signed requests in, the mock exchange answers, envelopes out. */
function bitunixHttp() {
  const seen: { method: string; path: string; headers: Record<string, string> }[] = [];
  const f = vi.fn(async (url: string, init: RequestInit) => {
    const u = new URL(url);
    seen.push({ method: String(init.method), path: u.pathname, headers: init.headers as Record<string, string> });
    try {
      const data = init.method === 'POST' ? await x.post(u.pathname, JSON.parse(String(init.body))) : await x.get(u.pathname, Object.fromEntries(u.searchParams));
      return new Response(JSON.stringify({ code: 0, msg: 'Success', data }), { status: 200 });
    } catch (e) {
      if (e instanceof BitunixPrivateError && e.kind === 'API') return new Response(JSON.stringify({ code: e.code, msg: e.message }), { status: 200 });
      throw e;
    }
  });
  return { f, seen };
}

describe('worker job entry point with production dependency construction', () => {
  it('paper.submit builds the real Bitunix order transport (no clock/nonce/fetch overrides); the order is sent and booked', async () => {
    // Same venue construction as production (liveMode: new BitunixOrderTransport({ credentials, baseUrl, env })),
    // with HTTP mocked. Before the fix every attempt threw "this.o.now is not a function" here.
    installLiveTestSeam({ requesterFor: () => mexc, transportEnabled: true, confirm: { attempts: 2, delayMs: 0 }, bitunixTransportEnv: { LIVE_ORDER_TRANSPORT: 'enabled', NODE_ENV: 'production' } });
    const http = bitunixHttp();
    vi.stubGlobal('fetch', http.f);
    try {
      const id = await enterLong();
      await drain(clock.now);
      const job = await jobOf(id);
      expect({ status: job.status, attempts: job.attempts, lastError: job.lastError }).toEqual({ status: 'DONE', attempts: 1, lastError: null });
      const i = await intent(id);
      expect(i).toMatchObject({ state: 'FILLED', exchangeOrderId: x.orders.get(i.clientOrderId)!.orderId });
      expect(i.venueRequest).toMatchObject({ path: '/api/v1/futures/trade/place_order', body: { clientId: i.clientOrderId, side: 'BUY', tradeSide: 'OPEN', orderType: 'MARKET' } });
      expect(http.seen.filter((c) => c.method === 'POST').map((c) => c.path)).toEqual(['/api/v1/futures/trade/place_order']);
      for (const c of http.seen) expect(c.headers).toMatchObject({ timestamp: expect.stringMatching(/^\d{13}$/), nonce: expect.stringMatching(/^[0-9a-f]{32}$/), sign: expect.stringMatching(/^[0-9a-f]{64}$/) });
      expect(await openPositions()).toHaveLength(1);
      await closeAll();
    } finally {
      vi.unstubAllGlobals();
      installLiveTestSeam({ requesterFor: () => mexc, bitunixRequesterFor: () => x, transportEnabled: true, confirm: { attempts: 2, delayMs: 0 } });
    }
  });
});

describe('production-shaped history (19 Nov 2026)', () => {
  const tagged = (o: Record<string, unknown>) => ({ marginCoin: null, positionMode: 'HEDGE', marginMode: 'ISOLATION', leverage: 20, price: 'MARKET', orderType: 'MARKET', effect: 'IOC', status: 'FILLED', tpPrice: null, slPrice: null, subAccountId: '891435181', ...o });

  it('a market order listed with price "MARKET" no longer stops the search; an unparseable row that could be ours keeps it incomplete', async () => {
    const id = await enterLong();
    x.detailFailures = 100; // pre-send lookup fails: nothing is sent
    await drain(clock.now);
    await killJob(id);
    x.detailFailures = 0;
    clock.now = plus(clock.now, 11 * 60);
    const t = clock.now.getTime();
    x.historyOrders = [
      tagged({ orderId: '2123307529551073280', clientId: '2123307529555795969', symbol: 'BTCUSDT', qty: '0.024', tradeQty: '0.024', avgPrice: '64001.5', side: 'SELL', reduceOnly: true, fee: '0.04', ctime: t, mtime: t }),
      tagged({ orderId: '2123300000000000009', clientId: null, subAccountId: null, symbol: 'BTCUSDT', qty: '0.0031', tradeQty: 'n/a', side: 'BUY', ctime: t, mtime: t })
    ];
    const r1 = await sync();
    expect(r1.ok).toBe(true); // the mirror's history read no longer fails the whole sync
    expect(r1.unparsedHistoryRows).toBe(1);
    expect(r1.intents).toEqual([expect.objectContaining({ intentId: id, result: 'PENDING', detail: expect.stringContaining('order list incomplete: 1 unparseable row(s) could be this order (order 2123300000000000009: order 2123300000000000009: tradeQty is not a number)') })]);
    expect(await intent(id)).toMatchObject({ state: 'SUBMITTING' });
    // The same row, now carrying another clientId: it cannot be this order; absence is established.
    x.historyOrders[1]!.clientId = '2123300000000000010';
    const r2 = await sync();
    expect(r2.intents).toEqual([expect.objectContaining({ intentId: id, result: 'NOT_AT_VENUE' })]);
    expect(await intent(id)).toMatchObject({ state: 'EXPIRED' });
    x.historyOrders = [];
    await unhalt();
  });

  it('NEW pushed after FILLED (later timestamp) never regresses the order; REST settles it', async () => {
    const id = await enterLong();
    x.next = { timeout: 'AFTER_ACCEPT', lookupsFailAfterAccept: 100 };
    await drain(clock.now);
    await killJob(id);
    x.detailFailures = 0;
    const clientId = (await intent(id)).clientOrderId;
    const filled = orderFrame(clientId, 'FILLED') as Extract<ReturnType<typeof orderFrame>, { channel: 'order' }>;
    const lateNew = { ...orderFrame(clientId, 'NEW'), mtimeMs: (filled.mtimeMs ?? 0) + 110, tsMs: (filled.tsMs ?? 0) + 110, dealAmount: '0' } as typeof filled;
    expect(await applyBitunixEvent(direct.db, await bxConn(), filled)).toMatchObject({ needsSync: true });
    expect(await intent(id)).toMatchObject({ exchangeOrderStatus: 'FILLED' });
    expect(await applyBitunixEvent(direct.db, await bxConn(), lateNew)).toMatchObject({ needsSync: true }); // conflict → REST
    expect(await intent(id)).toMatchObject({ state: 'SUBMITTING', exchangeOrderStatus: 'FILLED' });
    expect((await intent(id)).lastReconcileNote).toMatch(/WS order [0-9]+ NEW .*— conflicts with stored FILLED; REST decides/);
    expect((await sync()).intents).toEqual([expect.objectContaining({ result: 'FILLED' })]);
    expect(await intent(id)).toMatchObject({ state: 'FILLED', exchangeOrderStatus: 'FILLED' });
    await closeAll();
  });

  it("an exchange-originated leg in rows tagged with the key's own account: its close is confirmed from its own position history", async () => {
    const c = await bxConn();
    // The manual BUY that opened the leg (Bitunix-generated clientId) and the leg itself, both tagged
    // with the account's own ID; get_order_detail returns that order as this key's own.
    const t = clock.now.getTime();
    x.orders.set('2123290721968840706', { orderId: '2123290722031226880', clientId: '2123290721968840706', symbol: 'BTCUSDT', side: 'BUY', tradeSide: 'OPEN', orderType: 'MARKET', qty: '0.024', tradeQty: '0.024', price: '64000', status: 'FILLED', ctime: t, mtime: t });
    x.historyOrders = [tagged({ orderId: '2123290722031226880', clientId: '2123290721968840706', symbol: 'BTCUSDT', qty: '0.024', tradeQty: '0.024', avgPrice: '64000', side: 'BUY', reduceOnly: false, ctime: t, mtime: t })];
    x.positions.set('275788944450665588', { positionId: '275788944450665588', symbol: 'BTCUSDT', side: 'LONG', qty: '0.024', avgOpenPrice: '64000', ctime: t, mtime: t, subAccountId: '891435181' as unknown as number });
    expect((await sync()).ok).toBe(true);
    expect((await bxConn()).accountState).toMatchObject({ ownSubAccountId: '891435181', ownSubAccountEvidence: expect.stringContaining('history order 2123290722031226880 tagged subAccountId 891435181') });
    const mirror = async () => (await direct.db.select().from(schema.exchangePositions).where(and(eq(schema.exchangePositions.connectionId, c.id), eq(schema.exchangePositions.exchangePositionId, '275788944450665588'))))[0]!;
    expect(await mirror()).toMatchObject({ status: 'OPEN', origin: 'EXCHANGE', qty: '0.024' });
    // Closed manually on Bitunix (reduce-only SELL, another Bitunix clientId): the history row is tagged too.
    x.closeOnExchange('275788944450665588', { closePrice: '63990', mtime: t + 60_000, fee: '0.0897552', realizedPNL: '-0.0955152' });
    x.history[0]!.subAccountId = '891435181';
    await sync();
    const closed = await mirror();
    expect(closed.status).toBe('CLOSED');
    expect(closed.closeCheck).not.toBe('PENDING');
    // Never linked to a TrendPilot intent or position (different clientIds, order and position references).
    expect(await openPositions()).toHaveLength(0);
    x.historyOrders = [];
    x.orders.delete('2123290721968840706');
  });
});
