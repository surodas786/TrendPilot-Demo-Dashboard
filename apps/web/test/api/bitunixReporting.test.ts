// Bitunix Step 5: investor reporting for Bitunix Live through the real flow (mocked exchange):
// Holdings / trade details / chart scoped by investor, exchange and mode; Bitunix-reported
// liquidation and funding; both Hedge legs visible; P&L and fees from reconciled Bitunix fills
// (partial and exchange-originated closes) on the investor's reporting day; daily funding unknown
// (Bitunix has no settlement records); everything counted once across syncs and overlapping pages.
import { and, desc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  BitunixQuoteWriter,
  evaluateAndReserveEntry,
  ExchangePriceCache,
  installBitunixTestSeam,
  getMyDashboard,
  getMyHoldingChart,
  getMyTrade,
  installLiveTestSeam,
  listBitunixExchangeOnlyLegs,
  listMyHoldings,
  schema,
  syncBitunixConnection,
  type ConnectionRow
} from '@trendpilot/db';
import { Decimal } from '@trendpilot/domain';
import * as blocks from '@/app/v1/me/order-blocks/route';
import * as resume from '@/app/v1/me/order-blocks/[id]/resume/route';
import * as conn from '@/app/v1/me/exchange-connection/route';
import * as activate from '@/app/v1/me/live/activate/route';
import * as holdings from '@/app/v1/me/holdings/route';
import * as dashboard from '@/app/v1/me/dashboard/route';
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

// ---- Step 5: investor reporting for Bitunix Live ----
const conId = async (ownerId: string) => (await bxConn(ownerId)).id;
const sync = async (ownerId = idA) => {
  const r = await syncBitunixConnection(direct.db, await conId(ownerId), exOf(ownerId), { now: () => clock.now });
  expect(r.ok).toBe(true);
  return r;
};
const exitsOf = async (positionId: string) => direct.db.select().from(schema.positionExits).where(eq(schema.positionExits.positionId, positionId));
const TZ = 'Asia/Dhaka'; // UTC+6, no DST
let posId: string;
let longRef: string;

describe('Bitunix positions in Holdings, scoped by investor, exchange and mode', () => {
  it('a Bitunix Live position appears only in the Bitunix Live scope, with Bitunix-reported liquidation and funding', async () => {
    for (const id of [idA, idB]) exOf(id).nowMs = () => clock.now.getTime(); // the exchange runs on the test clock
    expect(await enter('LONG')).toMatchObject({ status: 'ENTRY_APPROVED' });
    await drain(clock.now);
    const [p] = await livePositions(idA);
    expect(p).toMatchObject({ status: 'OPEN', side: 'LONG' });
    posId = p!.id;
    longRef = p!.exchangePositionRef!;
    // Bitunix reports the leg's estimated liquidation price and its running funding total.
    Object.assign(exOf(idA).positions.get(longRef)!, { liqPrice: '57612.3', funding: '-0.0123' });
    await sync();
    const [row] = await direct.db.select().from(schema.positions).where(eq(schema.positions.id, posId));
    expect(D(row!.exchangeLiquidationPrice!).eq('57612.3')).toBe(true);
    expect(D(row!.exchangeFundingUsdt!).eq('-0.0123')).toBe(true);
    expect(D(row!.exchangeContracts!).eq('0.0031')).toBe(true);

    const bx = await listMyHoldings(direct.db, idA, clock.now, 'LIVE', 'BITUNIX');
    expect(bx).toHaveLength(1);
    expect(bx[0]).toMatchObject({ id: posId, exchange: 'BITUNIX', exchangeSymbol: 'BTCUSDT', side: 'LONG', mode: 'LIVE', liquidation: { price: '57612.3', label: 'Bitunix liquidation price (as reported, last sync)' } });
    expect(D(bx[0]!.contracts).eq('0.0031')).toBe(true);
    expect(D(bx[0]!.avgEntryPrice).eq('64000')).toBe(true);
    expect(bx[0]!.venueSync).toMatchObject({ positionRef: longRef, fundingUsdt: '-0.0123' });
    // Isolation: not in MEXC Live, not in Paper, not for investor B.
    expect(await listMyHoldings(direct.db, idA, clock.now, 'LIVE', 'MEXC')).toEqual([]);
    expect((await listMyHoldings(direct.db, idA, clock.now, 'PAPER')).some((h) => h.id === posId)).toBe(false);
    expect(await listMyHoldings(direct.db, idB, clock.now, 'LIVE', 'BITUNIX')).toEqual([]);
  });

  it('the API scopes by exchange: /v1/me/holdings?mode=LIVE&exchange=BITUNIX (and rejects an unknown exchange)', async () => {
    const r = await call(holdings.GET, { method: 'GET', path: '/v1/me/holdings?mode=LIVE&exchange=BITUNIX', cookie: cookies.a });
    expect(r.status).toBe(200);
    expect(r.body.positions.map((p: { id: string }) => p.id)).toEqual([posId]);
    expect(r.body.accounts.bitunixLive).toMatchObject({ mode: 'LIVE' });
    const m = await call(holdings.GET, { method: 'GET', path: '/v1/me/holdings?mode=LIVE&exchange=MEXC', cookie: cookies.a });
    expect(m.body.positions).toEqual([]);
    expect((await call(holdings.GET, { method: 'GET', path: '/v1/me/holdings?mode=LIVE&exchange=BINANCE', cookie: cookies.a })).status).toBe(422);
    const b = await call(holdings.GET, { method: 'GET', path: '/v1/me/holdings?mode=LIVE&exchange=BITUNIX', cookie: cookies.b });
    expect(b.body.positions).toEqual([]);
  });

  it('both Hedge legs stay visible: a short opened on Bitunix is listed read-only next to the TrendPilot long', async () => {
    const x = exOf(idA);
    await x.post('/api/v1/futures/trade/place_order', { symbol: 'BTCUSDT', qty: '0.002', side: 'SELL', tradeSide: 'OPEN', orderType: 'MARKET', clientId: 'manual-short-1' });
    const shortRef = x.legOf('BTCUSDT', 'SHORT')!.positionId;
    await sync();
    const legs = await listBitunixExchangeOnlyLegs(direct.db, idA);
    expect(legs).toEqual([expect.objectContaining({ exchange: 'BITUNIX', exchangePositionId: shortRef, side: 'SHORT', symbol: 'BTCUSDT' })]);
    expect(D(legs[0]!.qty).eq('0.002')).toBe(true);
    // The TrendPilot long is unchanged and still the only TrendPilot holding.
    const bx = await listMyHoldings(direct.db, idA, clock.now, 'LIVE', 'BITUNIX');
    expect(bx.map((h) => [h.id, h.side])).toEqual([[posId, 'LONG']]);
    expect(await listBitunixExchangeOnlyLegs(direct.db, idB)).toEqual([]);
  });
});

describe('Holdings chart: TradingView source, entry and the exchange-confirmed stop', () => {
  it('shows the stop Bitunix lists for this leg as confirmed; without it the stop is marked not confirmed', async () => {
    const x = exOf(idA);
    const listed = x.tpsl.find((t) => t.positionId === longRef)!;
    const c = await getMyHoldingChart(direct.db, idA, posId, { now: clock.now });
    expect(c!.tradingView).toMatchObject({ interval: '15' });
    expect(c!.tradingView!.source).toMatch(/:/);
    expect(c!.protection).toMatchObject({ status: 'CONFIRMED', kind: 'WHOLE_LEG' });
    expect(D(c!.protection.exchangeStopPrice!).eq(String(listed.slPrice))).toBe(true);
    const stop = c!.lines.find((l) => l.kind === 'STOP')!;
    expect(stop.label).toBe('Exchange stop (confirmed)');
    expect(D(stop.price).eq(String(listed.slPrice))).toBe(true);
    expect(D(c!.lines.find((l) => l.kind === 'ENTRY')!.price).eq('64000')).toBe(true);
    // The account sync no longer lists a stop for this leg (state as stored by the last sync).
    const conn = await bxConn(idA);
    const state = conn.accountState as { tpsl: { positionId: string }[] };
    await direct.db.update(schema.exchangeConnections).set({ accountState: { ...state, tpsl: state.tpsl.filter((t) => t.positionId !== longRef) } }).where(eq(schema.exchangeConnections.id, conn.id));
    const u = await getMyHoldingChart(direct.db, idA, posId, { now: clock.now });
    expect(u!.protection).toMatchObject({ status: 'MISSING', exchangeStopPrice: null });
    expect(u!.lines.find((l) => l.kind === 'STOP')!.label).toBe('Planned stop (not confirmed)');
    // Investor B cannot read A's chart.
    expect(await getMyHoldingChart(direct.db, idB, posId, { now: clock.now })).toBeUndefined();
    await sync(); // restores the listed stop
  });
});

describe('P&L, fees and funding from reconciled Bitunix fills', () => {
  // The long's partial close on Bitunix lands 30 s after midnight in Dhaka (18:00:30 UTC), the same
  // UTC day as the entry but the NEXT reporting day for a UTC+6 investor.
  const partialAt = new Date('2026-11-08T18:00:30Z');
  const trade = { tradeId: '991000000001', orderId: '981000000001', symbol: 'BTCUSDT', side: 'SELL', qty: '0.001', price: '64500', fee: '0.0387', realizedPNL: '0.5', reduceOnly: true, clientId: null, ctime: partialAt.getTime() };

  it('a partial close on Bitunix is booked once with its fee, on the reporting day of its fill time', async () => {
    const x = exOf(idA);
    clock.now = new Date('2026-11-08T18:05:00Z');
    setTestClock(() => clock.now);
    x.positions.get(longRef)!.qty = '0.0021';
    // Returned twice (as overlapping offset pages do): its fee must still be booked once.
    x.trades.push({ ...trade, positionId: longRef }, { ...trade, positionId: longRef });
    await sync();
    const ex = await exitsOf(posId);
    expect(ex).toHaveLength(1);
    expect(ex[0]).toMatchObject({ exchangeFillId: 'bitunix:981000000001', reason: 'EXTERNAL_CLOSE' });
    expect(D(ex[0]!.contracts).eq('0.001')).toBe(true);
    expect(D(ex[0]!.fee).eq('0.0387')).toBe(true);
    expect(ex[0]!.filledAt.toISOString()).toBe(partialAt.toISOString());
    const [row] = await direct.db.select().from(schema.positions).where(eq(schema.positions.id, posId));
    expect(row).toMatchObject({ status: 'OPEN' });
    expect(D(row!.contracts).eq('0.0021')).toBe(true);

    const day = (date: string, timezone = TZ) => getMyDashboard(direct.db, { id: idA, timezone }, { now: clock.now, date, mode: 'LIVE', exchange: 'BITUNIX' });
    const nov9 = await day('2026-11-09');
    expect(nov9).toMatchObject({ mode: 'LIVE', exchange: 'BITUNIX', daily: { exitFills: 1, partialExits: 1 } });
    expect(nov9.label).toContain('Bitunix');
    expect(D(nov9.daily.exitFeesUsdt).eq('0.0387')).toBe(true);
    expect(D(nov9.daily.grossRealizedUsdt).eq('0.5')).toBe(true);
    // Dhaka 8 Nov holds the entry, not the close; the same instant is 8 Nov in UTC.
    expect((await day('2026-11-08')).daily).toMatchObject({ exitFills: 0, entryFills: 1 });
    expect((await day('2026-11-08', 'UTC')).daily).toMatchObject({ exitFills: 1, entryFills: 1 });
  });

  it('daily funding for Bitunix is unknown (no settlement records), never estimated or zero', async () => {
    const d = await getMyDashboard(direct.db, { id: idA, timezone: TZ }, { now: clock.now, date: '2026-11-09', mode: 'LIVE', exchange: 'BITUNIX' });
    expect(d.daily.funding).toMatchObject({ amountUsdt: null, status: 'UNAVAILABLE' });
    expect(d.daily.funding.statusText).toContain('Bitunix reports funding only as a running total per position');
    // MEXC Live (default) keeps its own account, fills and wording.
    const m = await getMyDashboard(direct.db, { id: idA, timezone: TZ }, { now: clock.now, date: '2026-11-09', mode: 'LIVE' });
    expect(m).toMatchObject({ exchange: 'MEXC', daily: { exitFills: 0 } });
    expect(m.daily.funding.statusText).toContain('MEXC');
    const api = await call(dashboard.GET, { method: 'GET', path: '/v1/me/dashboard?date=2026-11-09&mode=live&exchange=bitunix', cookie: cookies.a });
    expect(api.status).toBe(200);
    expect(api.body).toMatchObject({ exchange: 'BITUNIX', daily: { funding: { amountUsdt: null, status: 'UNAVAILABLE' } } });
    expect((await call(dashboard.GET, { method: 'GET', path: '/v1/me/dashboard?mode=live&exchange=okx', cookie: cookies.a })).status).toBe(422);
    // B's Bitunix dashboard has none of A's fills.
    const b = await getMyDashboard(direct.db, { id: idB, timezone: TZ }, { now: clock.now, date: '2026-11-09', mode: 'LIVE', exchange: 'BITUNIX' });
    expect(b.daily).toMatchObject({ exitFills: 0, entryFills: 0 });
  });

  it('fees and funding are counted once across repeated syncs and overlapping history pages', async () => {
    const x = exOf(idA);
    // The same trade row returned twice (overlapping pages), then two more syncs.
    x.trades.push({ ...trade, positionId: longRef });
    await sync();
    await sync();
    const ex = await exitsOf(posId);
    expect(ex).toHaveLength(1);
    expect(D(ex[0]!.fee).eq('0.0387')).toBe(true);
    const d = await getMyDashboard(direct.db, { id: idA, timezone: TZ }, { now: clock.now, date: '2026-11-09', mode: 'LIVE', exchange: 'BITUNIX' });
    expect(D(d.daily.exitFeesUsdt).eq('0.0387')).toBe(true);
    expect(d.daily.exitFills).toBe(1);
    const [row] = await direct.db.select().from(schema.positions).where(eq(schema.positions.id, posId));
    expect(D(row!.exchangeFundingUsdt!).eq('-0.0123')).toBe(true); // the running total, replaced, not added
    expect(D(row!.contracts).eq('0.0021')).toBe(true);
  });

  it('the remainder closed on Bitunix: booked once, the position closes with Bitunix’s settled funding total', async () => {
    const x = exOf(idA);
    clock.now = new Date('2026-11-08T19:00:00Z');
    const at = clock.now.getTime() - 10_000;
    x.trades.push({ tradeId: '991000000002', orderId: '981000000002', positionId: longRef, symbol: 'BTCUSDT', side: 'SELL', qty: '0.0021', price: '64600', fee: '0.0814', realizedPNL: '1.26', reduceOnly: true, clientId: null, ctime: at });
    x.closeOnExchange(longRef, { closePrice: '64600', mtime: at, fee: '0.1585', funding: '-0.0456', realizedPNL: '1.76' });
    await sync();
    await sync();
    const ex = await exitsOf(posId);
    expect(ex.map((e) => e.exchangeFillId).sort()).toEqual(['bitunix:981000000001', 'bitunix:981000000002']);
    const [row] = await direct.db.select().from(schema.positions).where(eq(schema.positions.id, posId));
    expect(row).toMatchObject({ status: 'CLOSED' });
    expect(D(row!.exchangeFundingUsdt!).eq('-0.0456')).toBe(true);
    expect(row!.exchangeLiquidationPrice).toBeNull();
    const t = await getMyTrade(direct.db, idA, posId);
    expect(t).toMatchObject({ exchange: 'BITUNIX', status: 'CLOSED' });
    expect(D(t!.contracts).eq(0)).toBe(true);
    // Closed lists stay per exchange too.
    expect(await listMyHoldings(direct.db, idA, clock.now, 'LIVE', 'BITUNIX')).toEqual([]);
  });
});

describe('capability evidence: Bitunix VERIFIED needs real-exchange (pilot) evidence', () => {
  it('refuses VERIFIED with a note; accepts it with a pilot evidence reference; PILOT_ACCEPTED is unchanged', async () => {
    const post = (body: Record<string, unknown>) => call(capabilities.POST, { method: 'POST', path: '/x', cookie: cookies.admin, body });
    const bad = await post({ capability: 'BITUNIX_TPSL_RESIZE', state: 'VERIFIED', evidence: 'looked fine in the mock' });
    expect(bad.status).toBe(400);
    expect(JSON.stringify(bad.body)).toContain('bitunix-pilot:<sha256>');
    expect((await post({ capability: 'BITUNIX_TPSL_RESIZE', state: 'VERIFIED', evidence: `pilot run: bitunix-pilot:${'a'.repeat(64)}` })).status).toBe(200);
    expect((await post({ capability: 'BITUNIX_TPSL_RESIZE', state: 'PENDING', evidence: 'reset after test' })).status).toBe(200);
    // MEXC capabilities keep their existing rule.
    expect((await post({ capability: 'CANCEL_STOP', state: 'PILOT_ACCEPTED', evidence: 'test' })).status).toBe(200);
  });
});
