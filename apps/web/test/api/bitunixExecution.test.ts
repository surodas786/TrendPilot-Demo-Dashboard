// Bitunix Step 3: Live execution through the REAL flow — Live gates, cost-based sizing on the
// Bitunix instrument (base-coin quantity), reservation on the Bitunix Live account, the worker's
// submit / close jobs, the Live guard and the Bitunix venue — against a mocked Bitunix exchange.
// Signal routing to Bitunix blocks is Step 4: here the real entry evaluation is called directly
// for a Bitunix block with a delivered alert's event.
import { and, desc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  BitunixQuoteWriter,
  evaluateAndReserveEntry,
  ExchangePriceCache,
  installBitunixTestSeam,
  installLiveTestSeam,
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
import * as closePos from '@/app/v1/me/positions/[id]/close/route';
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
const B = USERS.investorB.email;
const D = (v: Decimal.Value) => new Decimal(v);
const LIMITS = { maxOrderContracts: '1', maxOrderNotionalUsdt: '500', maxLeverage: 10, maxExposureUsdt: '1000' };
const exch: Record<string, MockBitunixExchange> = {};
const mexc = new MockMexc();
let idA: string;
let idB: string;
let bxInstrument: string;
let blockA: string;
let versionId: string;
let bar = new Date('2026-11-08T09:15:00Z');
const cache = new ExchangePriceCache();

const exOf = (ownerId: string) => (exch[ownerId] ??= Object.assign(new MockBitunixExchange(), {}));
const bxConn = async (ownerId: string): Promise<ConnectionRow> => (await direct.db.select().from(schema.exchangeConnections).where(and(eq(schema.exchangeConnections.ownerId, ownerId), eq(schema.exchangeConnections.exchange, 'BITUNIX'))))[0]!;
const accounts = async (ownerId: string) => direct.db.select().from(schema.paperAccounts).where(eq(schema.paperAccounts.ownerId, ownerId));
const bxAccount = async (ownerId: string) => (await accounts(ownerId)).find((a) => a.mode === 'LIVE' && a.exchange === 'BITUNIX')!;
const intents = async (ownerId: string) => direct.db.select().from(schema.orderIntents).where(eq(schema.orderIntents.ownerId, ownerId)).orderBy(desc(schema.orderIntents.createdAt));
const livePositions = async (ownerId: string) => direct.db.select().from(schema.positions).where(and(eq(schema.positions.ownerId, ownerId), eq(schema.positions.mode, 'LIVE'))).orderBy(desc(schema.positions.createdAt));

/** A fresh Bitunix quote for the Bitunix instrument, through the exchange-keyed cache and the quote writer. */
async function bitunixQuote(bid = '63999.9', ask = '64000.1', mark = '64000') {
  const at = clock.now;
  cache.putBook('BITUNIX', 'BTCUSDT', { bid, ask, last: mark, exchangeTimeMs: at.getTime(), receivedAt: at });
  cache.putMark('BITUNIX', 'BTCUSDT', { mark, index: mark, exchangeTimeMs: at.getTime(), receivedAt: at });
  const w = new BitunixQuoteWriter(direct.db, cache, { minIntervalMs: 0 });
  await w.refresh();
  expect(await w.onUpdate('BTCUSDT', at)).toBe('WRITTEN');
}

/** A new alert bar (its own event), a fresh quote, then the real entry evaluation for A's Bitunix block. */
async function enter(side: 'LONG' | 'SHORT') {
  bar = new Date(bar.getTime() + M15);
  clock.now = plus(new Date(bar.getTime() + M15), 3);
  setTestClock(() => clock.now);
  expect(await deliver(side === 'LONG' ? 'BULLISH_FLIP' : 'BEARISH_FLIP', bar, '64000.0')).toBe(202);
  await drain(clock.now); // the alert's own (MEXC) dispatch: no MEXC block exists
  await bitunixQuote();
  const [event] = await direct.db.select().from(schema.signalEvents).orderBy(desc(schema.signalEvents.receivedAt)).limit(1);
  const [block] = await direct.db.select().from(schema.orderBlocks).where(eq(schema.orderBlocks.id, blockA));
  const [version] = await direct.db.select().from(schema.strategyVersions).where(eq(schema.strategyVersions.id, versionId));
  const out = await direct.db.transaction((tx) => evaluateAndReserveEntry(tx, { event: event!, block: block!, version: version!, side, now: clock.now }));
  return out;
}

beforeAll(async () => {
  await openFromAlert({ a: null, b: null }); // seeded users, cookies, clock, one delivered alert
  idA = await userId(A);
  idB = await userId(B);
  mexc.positionMode = 2;
  installLiveTestSeam({ requesterFor: () => mexc, bitunixRequesterFor: (c) => exOf(c.ownerId), transportEnabled: true, confirm: { attempts: 2, delayMs: 0 } });
  installBitunixTestSeam({ requesterFor: (c) => exOf(c.ownerId) });
  for (const id of [idA, idB]) {
    exOf(id).usdt.available = '1000';
    exOf(id).setSettings('BTCUSDT', { longLeverage: 10, shortLeverage: 10 });
  }
  // A Bitunix instrument from Bitunix contract metadata, published and allowed for Live.
  const added = await call(bitunixInstrument.POST, { method: 'POST', path: '/x', cookie: cookies.admin, body: { symbol: 'BITUNIX:BTCUSDT.P' } });
  expect(added.status).toBe(200);
  expect(added.body.instrument).toMatchObject({ exchange: 'BITUNIX', symbol: 'BTCUSDT', exchangeSymbol: 'BTCUSDT', contractMultiplier: '1.000000000000', qtyStep: '0.000100000000', minQty: '0.000100000000', maxQty: '120.000000000000', priceTick: '0.100000000000', status: 'DISABLED', liveAllowed: false });
  bxInstrument = added.body.instrument.id;
  await direct.db.update(schema.instruments).set({ status: 'PUBLISHED', isFixture: false }).where(eq(schema.instruments.id, bxInstrument));
  // A published strategy version is immutable: publish one that includes the Bitunix contract.
  versionId = await publishVersion({ instrumentIds: [BTC, bxInstrument] });
  expect((await call(contracts.POST, { method: 'POST', path: '/x', cookie: cookies.admin, params: { id: bxInstrument }, body: { allowed: true } })).status).toBe(200);
  for (const c of ['OPEN_WITH_ATTACHED_STOP', 'REDUCE_ONLY_CLOSE', 'STOP_RESIZE_AFTER_PARTIAL_CLOSE', 'CANCEL_STOP', 'BITUNIX_OPEN_WITH_ATTACHED_STOP', 'BITUNIX_HEDGE_CLOSE_BY_POSITION'])
    expect((await call(capabilities.POST, { method: 'POST', path: '/x', cookie: cookies.admin, body: { capability: c, state: 'PILOT_ACCEPTED', evidence: 'test: mocked exchange' } })).status).toBe(200);
  expect((await call(platform.POST, { method: 'POST', path: '/x', cookie: cookies.admin, body: { enabled: true, note: 'test' } })).status).toBe(200);
  // Both investors connect Bitunix; A is approved, activated and holds the Live block. A also has MEXC.
  expect((await call(conn.PUT, { method: 'PUT', cookie: cookies.a, body: { accountRef: 'uid-1234', apiKey: 'mexc-key-12345678', secretKey: 'mexc-secret-12345678' } })).status).toBe(200);
  for (const [who, key] of [['a', 'bitunix-key-A-1111'], ['b', 'bitunix-key-B-2222']] as const)
    expect((await call(conn.PUT, { method: 'PUT', cookie: cookies[who], body: { exchange: 'BITUNIX', accountRef: `bx-${who}`, apiKey: key, secretKey: `${key}-secret` } })).body.connection).toMatchObject({ status: 'VERIFIED', positionMode: 'HEDGE' });
  expect((await call(approve.POST, { method: 'POST', path: '/x', cookie: cookies.admin, params: { id: (await bxConn(idA)).id }, body: LIMITS })).status).toBe(200);
  expect((await call(activate.POST, { method: 'POST', path: '/v1/me/live/activate?exchange=BITUNIX', cookie: cookies.a })).status).toBe(200);
  expect((await syncBitunixConnection(direct.db, (await bxConn(idA)).id, exOf(idA))).ok).toBe(true); // Bitunix balance → Bitunix Live account
  const created = await call(blocks.POST, { method: 'POST', path: '/x', cookie: cookies.a, body: blockBody({ instrumentId: bxInstrument, strategyVersionId: versionId, mode: 'LIVE', orderCostUsdt: '20', leverage: 10, weekdays: ALL_DAYS }) });
  expect(created.status).toBe(201);
  blockA = created.body.id;
  expect((await call(resume.POST, { method: 'POST', path: '/x', cookie: cookies.a, params: { id: blockA }, ifMatch: created.body.revision })).status).toBe(200);
});
beforeEach(() => {
  for (const x of Object.values(exch)) x.next = {};
});
afterAll(async () => {
  installLiveTestSeam(null);
  installBitunixTestSeam(null);
  setTestClock(null);
  await teardown();
});

describe('Bitunix Live entry (Hedge mode, stop loss in the entry request)', () => {
  it('sizes on the Bitunix instrument, reserves on the Bitunix Live account and sends BUY+OPEN with the stop', async () => {
    const x = exOf(idA);
    const acctBefore = await bxAccount(idA);
    expect(acctBefore).toMatchObject({ exchange: 'BITUNIX', mode: 'LIVE', exchangeAvailable: '1000.00000000' });
    expect(await enter('LONG')).toMatchObject({ status: 'ENTRY_APPROVED' });
    const [intent] = await intents(idA);
    // Cost-based sizing: 20 USDT × 10x / 64000.1 → 0.003124… BTC, rounded down to 0.0001.
    expect(intent).toMatchObject({ kind: 'OPEN', mode: 'LIVE', paperAccountId: acctBefore.id, contracts: '0.003100000000', side: 'LONG' });
    expect(D((await bxAccount(idA)).orderReserve).gt(0)).toBe(true); // reserved before sending
    await drain(clock.now);
    expect(x.posts).toHaveLength(1);
    expect(x.posts[0]).toEqual({ symbol: 'BTCUSDT', qty: '0.0031', side: 'BUY', tradeSide: 'OPEN', orderType: 'MARKET', clientId: intent!.clientOrderId, slPrice: D(intent!.stopPrice).toFixed(), slStopType: 'MARK_PRICE', slOrderType: 'MARKET' });
    const [p] = await livePositions(idA);
    const leg = x.legOf('BTCUSDT', 'LONG')!;
    expect(p).toMatchObject({ status: 'OPEN', side: 'LONG', contracts: '0.003100000000', paperAccountId: acctBefore.id, protectionStatus: 'PROTECTED', exchangePositionRef: leg.positionId });
    expect(p!.stopOrderRef).toMatch(/^bitunix-tpsl:\d+$/);
    const [fill] = await direct.db.select().from(schema.fills).where(eq(schema.fills.intentId, intent!.id));
    expect(fill!.exchangeFillId).toMatch(/^bitunix:\d+$/);
    expect((await intents(idA))[0]).toMatchObject({ state: 'FILLED' });
    expect(D((await bxAccount(idA)).orderReserve).isZero()).toBe(true); // released into position margin on the fill
    // The MEXC Live account (created when A verified the MEXC key) holds nothing from this order.
    const mexcLive = (await accounts(idA)).find((a) => a.mode === 'LIVE' && a.exchange === 'MEXC')!;
    expect(mexcLive.id).not.toBe(acctBefore.id);
    expect(D(mexcLive.orderReserve).isZero() && D(mexcLive.positionMargin).isZero()).toBe(true);
    expect(exOf(idB).posts).toHaveLength(0);
  });

  it('a manual close sends BUY+CLOSE with the long leg’s positionId; a Short leg on the same symbol is untouched', async () => {
    const x = exOf(idA);
    // A Short leg exists on Bitunix (opened outside TrendPilot): Hedge mode keeps it separate.
    const shortId = '700000099999';
    x.positions.set(shortId, { positionId: shortId, symbol: 'BTCUSDT', side: 'SHORT', qty: '0.0050', mtime: Date.now() });
    const [p] = await livePositions(idA);
    const r = await call(closePos.POST, { method: 'POST', path: '/x', cookie: cookies.a, params: { id: p!.id }, headers: { 'idempotency-key': 'close-long-1' } });
    expect(r.status).toBeLessThan(300);
    // A second close while the first is unresolved is not another order (one per account and contract).
    const [row] = await direct.db.select().from(schema.positions).where(eq(schema.positions.id, p!.id));
    expect(await direct.db.transaction((tx) => requestExit(tx, { position: row!, reason: 'STOP_LOSS', now: clock.now }))).toMatchObject({ status: 'IN_PROGRESS' });
    await drain(clock.now);
    const closes = x.posts.filter((b) => b.tradeSide === 'CLOSE');
    expect(closes).toEqual([{ symbol: 'BTCUSDT', qty: '0.0031', side: 'BUY', tradeSide: 'CLOSE', positionId: p!.exchangePositionRef, orderType: 'MARKET', clientId: closes[0]!.clientId }]);
    expect(await livePositions(idA).then((ps) => ps.find((q) => q.id === p!.id))).toMatchObject({ status: 'CLOSED', contracts: '0.000000000000' });
    expect(x.legOf('BTCUSDT', 'SHORT')).toMatchObject({ positionId: shortId, qty: '0.0050' });
    x.positions.delete(shortId);
  });

  it('a close against a stale positionId (closed on Bitunix meanwhile) sends nothing', async () => {
    const x = exOf(idA);
    expect(await enter('LONG')).toMatchObject({ status: 'ENTRY_APPROVED' });
    await drain(clock.now);
    const [p] = await livePositions(idA);
    expect(p).toMatchObject({ status: 'OPEN' });
    // Bitunix closes the leg (its stop fired) and a new Long leg opens with another ID.
    x.closeOnExchange(p!.exchangePositionRef!, { closePrice: '63000', mtime: Date.now() });
    x.positions.set('700000088888', { positionId: '700000088888', symbol: 'BTCUSDT', side: 'LONG', qty: '0.5', mtime: Date.now() });
    const posts = x.posts.length;
    const [row] = await direct.db.select().from(schema.positions).where(eq(schema.positions.id, p!.id));
    await direct.db.transaction((tx) => requestExit(tx, { position: row!, reason: 'MANUAL_CLOSE', now: clock.now }));
    await drain(clock.now);
    expect(x.posts).toHaveLength(posts); // the newer leg was never closed in its place
    const [close] = (await intents(idA)).filter((i) => i.kind === 'CLOSE');
    expect(close).toMatchObject({ state: 'REJECTED', stateReason: 'REDUCE_ONLY_NO_POSITION' });
    x.positions.delete('700000088888');
    // Housekeeping: the platform position follows the exchange (Step 2 sync / exit rules close it).
    await direct.db.update(schema.positions).set({ status: 'CLOSED', contracts: '0' }).where(eq(schema.positions.id, p!.id));
  });
});

describe('protection, partial fills and uncertain outcomes', () => {
  it('a partial fill opens only the filled quantity, covered by the leg’s stop', async () => {
    const x = exOf(idA);
    expect(await enter('SHORT')).toMatchObject({ status: 'ENTRY_APPROVED' });
    x.next = { fillFraction: '0.5' };
    await drain(clock.now);
    const [p] = await livePositions(idA);
    expect(p).toMatchObject({ side: 'SHORT', contracts: '0.001500000000', initialContracts: '0.001500000000', protectionStatus: 'PROTECTED' });
    expect(x.posts.at(-1)).toMatchObject({ side: 'SELL', tradeSide: 'OPEN', qty: '0.0031' });
    // Close it so the next scenario starts flat.
    const [row] = await direct.db.select().from(schema.positions).where(eq(schema.positions.id, p!.id));
    await direct.db.transaction((tx) => requestExit(tx, { position: row!, reason: 'MANUAL_CLOSE', now: clock.now }));
    await drain(clock.now);
    expect(x.posts.at(-1)).toMatchObject({ side: 'SELL', tradeSide: 'CLOSE', positionId: p!.exchangePositionRef, qty: '0.0015' });
    expect((await livePositions(idA))[0]).toMatchObject({ status: 'CLOSED' });
  });

  it('missing protection: the position is UNPROTECTED, an emergency close is queued and new entries halt', async () => {
    const x = exOf(idA);
    expect(await enter('LONG')).toMatchObject({ status: 'ENTRY_APPROVED' });
    x.next = { attachStop: 'NO' };
    await drain(clock.now);
    const ps = await livePositions(idA);
    const p = ps.find((q) => q.side === 'LONG' && q.openedAt && q.status !== 'OPEN') ?? ps[0]!;
    expect(p.protectionStatus === 'UNPROTECTED' || p.status === 'CLOSED').toBe(true);
    const closes = (await intents(idA)).filter((i) => i.kind === 'CLOSE' && i.positionId === p.id);
    expect(closes[0]).toMatchObject({ exitReason: 'PROTECTION_FAILURE' });
    expect(await bxConn(idA)).toMatchObject({ entriesHalted: true, haltReason: expect.stringMatching(/^PROTECTION_FAILURE/) });
    // Resume for the next scenarios (operator review).
    await direct.db.update(schema.exchangeConnections).set({ entriesHalted: false, haltReason: null }).where(eq(schema.exchangeConnections.id, (await bxConn(idA)).id));
  });

  it('a timeout before Bitunix accepted keeps the order pending with its reservation; once absence is confirmed it is never resent blind', async () => {
    const x = exOf(idA);
    expect(await enter('LONG')).toMatchObject({ status: 'ENTRY_APPROVED' });
    const [intent] = await intents(idA);
    x.next = { timeout: 'BEFORE_ACCEPT' };
    await drain(clock.now);
    expect((await intents(idA))[0]).toMatchObject({ id: intent!.id, state: 'SUBMITTING' });
    expect(D((await bxAccount(idA)).orderReserve).gt(0)).toBe(true); // reservation kept while unresolved
    expect(x.posts.filter((p) => p.clientId === intent!.clientOrderId)).toHaveLength(1);
    // The existing recovery policy: an uncertain submission halts new entries on that account.
    expect(await bxConn(idA)).toMatchObject({ entriesHalted: true, haltReason: `UNCERTAIN_ORDER ${intent!.clientOrderId}` });
    // Inside the grace period: lookup by clientId only (absent), nothing is resent, still pending.
    clock.now = plus(clock.now, 10);
    await bitunixQuote();
    await drain(clock.now);
    expect(x.posts.filter((p) => p.clientId === intent!.clientOrderId)).toHaveLength(1);
    expect((await intents(idA)).find((i) => i.id === intent!.id)).toMatchObject({ state: 'SUBMITTING' });
    expect(x.calls.filter((c) => c.path.endsWith('get_order_detail') && c.params.clientId === intent!.clientOrderId).length).toBeGreaterThan(1);
    // After it Bitunix still has no such order: the halted account refuses a new send, the intent is
    // rejected and only now — the outcome being "never accepted" — the reservation is released.
    clock.now = plus(clock.now, 40);
    await bitunixQuote();
    await drain(clock.now);
    expect(x.posts.filter((p) => p.clientId === intent!.clientOrderId)).toHaveLength(1);
    expect((await intents(idA)).find((i) => i.id === intent!.id)).toMatchObject({ state: 'REJECTED', stateReason: 'LIVE_REFUSED:LIVE_ACCOUNT_HALTED' });
    expect(D((await bxAccount(idA)).orderReserve).isZero()).toBe(true);
    expect(await livePositions(idA).then((ps) => ps.filter((p) => p.status === 'OPEN'))).toHaveLength(0);
    await direct.db.update(schema.exchangeConnections).set({ entriesHalted: false, haltReason: null }).where(eq(schema.exchangeConnections.id, (await bxConn(idA)).id));
  });

  it('a timeout after Bitunix accepted, or a duplicate clientId, is reconciled to the one order', async () => {
    const x = exOf(idA);
    expect(await enter('LONG')).toMatchObject({ status: 'ENTRY_APPROVED' });
    const [intent] = await intents(idA);
    x.next = { timeout: 'AFTER_ACCEPT' };
    await drain(clock.now);
    expect((await intents(idA)).find((i) => i.id === intent!.id)).toMatchObject({ state: 'FILLED' });
    expect(x.posts.filter((p) => p.clientId === intent!.clientOrderId)).toHaveLength(1);
    expect(await livePositions(idA).then((ps) => ps.filter((p) => p.status === 'OPEN'))).toHaveLength(1);
    await closeOpenLeg('LONG');
  });
});

describe('refusals before sending', () => {
  it('One-Way mode at Bitunix: nothing is sent, the mode is recorded, entries halt, the reservation is released', async () => {
    const x = exOf(idA);
    expect(await enter('LONG')).toMatchObject({ status: 'ENTRY_APPROVED' });
    const [intent] = await intents(idA);
    x.mode = 'ONE_WAY';
    const posts = x.posts.length;
    await drain(clock.now);
    expect(x.posts).toHaveLength(posts);
    expect((await intents(idA))[0]).toMatchObject({ id: intent!.id, state: 'REJECTED', stateReason: 'LIVE_REFUSED:LIVE_POSITION_MODE' });
    expect(await bxConn(idA)).toMatchObject({ positionMode: 'ONE_WAY', entriesHalted: true });
    expect(D((await bxAccount(idA)).orderReserve).isZero()).toBe(true);
    x.mode = 'HEDGE';
    await direct.db.update(schema.exchangeConnections).set({ positionMode: 'HEDGE', entriesHalted: false, haltReason: null }).where(eq(schema.exchangeConnections.id, (await bxConn(idA)).id));
  });

  it('a leverage set differently at Bitunix is refused and never changed by TrendPilot', async () => {
    const x = exOf(idA);
    x.setSettings('BTCUSDT', { longLeverage: 20, shortLeverage: 10 });
    expect(await enter('LONG')).toMatchObject({ status: 'ENTRY_APPROVED' });
    const posts = x.posts.length;
    await drain(clock.now);
    expect(x.posts).toHaveLength(posts);
    expect((await intents(idA))[0]).toMatchObject({ state: 'REJECTED', stateReason: expect.stringMatching(/^BITUNIX_SETTINGS_MISMATCH:LEVERAGE/) });
    expect(x.settings.BTCUSDT).toMatchObject({ longLeverage: 20 });
    expect(x.calls.some((c) => /change_/.test(c.path))).toBe(false);
    x.setSettings('BTCUSDT', { longLeverage: 10, shortLeverage: 10 });
  });
});

describe('isolation', () => {
  it('only A’s Bitunix key and account were used; B, MEXC and Paper are untouched', async () => {
    expect(exOf(idB).posts).toHaveLength(0);
    expect(exOf(idB).calls.filter((c) => /get_order_detail|trading_settings/.test(c.path))).toHaveLength(0);
    expect(await livePositions(idB)).toHaveLength(0);
    expect((await accounts(idA)).map((a) => `${a.mode}:${a.exchange}`).sort()).toEqual(['LIVE:BITUNIX', 'LIVE:MEXC', 'PAPER:MEXC']);
    const mexcLive = (await accounts(idA)).find((a) => a.mode === 'LIVE' && a.exchange === 'MEXC')!;
    expect(await direct.db.select().from(schema.orderIntents).where(eq(schema.orderIntents.paperAccountId, mexcLive.id))).toHaveLength(0);
    expect(mexc.creates()).toHaveLength(0); // no MEXC order request
    expect(await direct.db.select().from(schema.positions).where(and(eq(schema.positions.ownerId, idA), eq(schema.positions.mode, 'PAPER')))).toHaveLength(0);
    // Every Live order of A sits on A's Bitunix account; none on another account.
    const acct = await bxAccount(idA);
    expect((await intents(idA)).filter((i) => i.mode === 'LIVE').every((i) => i.paperAccountId === acct.id)).toBe(true);
    // Quotes: the Bitunix instrument has only BITUNIX_PUBLIC quotes.
    const qs = await direct.db.select().from(schema.marketQuotes).where(eq(schema.marketQuotes.instrumentId, bxInstrument));
    expect(new Set(qs.map((q) => q.source))).toEqual(new Set(['BITUNIX_PUBLIC']));
  });
});

/** Closes A's open position on `side` through the real close flow. */
async function closeOpenLeg(side: 'LONG' | 'SHORT') {
  const p = (await livePositions(idA)).find((q) => q.status === 'OPEN' && q.side === side);
  if (!p) return;
  await direct.db.transaction((tx) => requestExit(tx, { position: p, reason: 'MANUAL_CLOSE', now: clock.now }));
  await drain(clock.now);
  expect((await livePositions(idA)).find((q) => q.id === p.id)).toMatchObject({ status: 'CLOSED' });
}
