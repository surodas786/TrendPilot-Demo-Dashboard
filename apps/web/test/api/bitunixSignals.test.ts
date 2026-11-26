// Bitunix Step 4, end to end through the SHARED TradingView webhook (no direct entry calls):
// explicit Bitunix route targets next to the unchanged MEXC route, each block dispatched once,
// duplicate alerts, price-gap / stale-feed rejections with exchange context, EMA 200 on Bitunix
// candles kept separate from MEXC, long and short trailing take profit with target close through
// the Bitunix close path, close-and-reverse that waits for the confirmed close, and manual / stop
// closes made on Bitunix reconciled into TrendPilot positions exactly once. Orders run against a
// mocked Bitunix exchange.
import { and, asc, desc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  applyBitunixEvent,
  BitunixKlineSource,
  BitunixQuoteWriter,
  ExchangePriceCache,
  installBitunixTestSeam,
  installLiveTestSeam,
  listSignalRoutes,
  MarketFeed,
  requestExit,
  schema,
  syncBitunixConnection,
  type BitunixPrivateEvent,
  type ConnectionRow
} from '@trendpilot/db';
import { Decimal } from '@trendpilot/domain';
import * as blocks from '@/app/v1/me/order-blocks/route';
import * as resume from '@/app/v1/me/order-blocks/[id]/resume/route';
import * as conn from '@/app/v1/me/exchange-connection/route';
import * as activate from '@/app/v1/me/live/activate/route';
import * as bitunixInstrument from '@/app/v1/admin/instruments/bitunix/route';
import * as routeTarget from '@/app/v1/admin/signal-routes/[id]/bitunix-target/route';
import * as instrumentsApi from '@/app/v1/instruments/route';
import * as approve from '@/app/v1/admin/live/connections/[id]/approve/route';
import * as capabilities from '@/app/v1/admin/live/capabilities/route';
import * as contracts from '@/app/v1/admin/live/contracts/[id]/route';
import * as platform from '@/app/v1/admin/live/platform/route';
import { setTestClock } from '@/server/clock';
import { BTC, blockBody, call, direct, teardown, userId, USERS } from '../helpers';
import { MockBitunixExchange } from '../bitunixOrderMock';
import { MockMexc } from '../mexcMock';
import { ALL_DAYS, clock, cookies, deliver, drain, M15, openFromAlert, plus, publishVersion, tick as mexcTick } from '../paperReplay';

const D = (v: Decimal.Value) => new Decimal(v);
const LIMITS = { maxOrderContracts: '1', maxOrderNotionalUsdt: '5000', maxLeverage: 10, maxExposureUsdt: '10000' };
const exch: Record<string, MockBitunixExchange> = {};
const exOf = (ownerId: string) => (exch[ownerId] ??= Object.assign(new MockBitunixExchange(), { nowMs: () => clock.now.getTime() }));
const cache = new ExchangePriceCache();
let idA: string;
let idB: string;
let bx: string;
let blockA: string;
let blockB: string;
let bar = new Date('2026-11-08T09:15:00Z');

const bxConn = async (ownerId: string): Promise<ConnectionRow> => (await direct.db.select().from(schema.exchangeConnections).where(and(eq(schema.exchangeConnections.ownerId, ownerId), eq(schema.exchangeConnections.exchange, 'BITUNIX'))))[0]!;
const posOf = async (ownerId: string, mode: 'LIVE' | 'PAPER' = 'LIVE') => direct.db.select().from(schema.positions).where(and(eq(schema.positions.ownerId, ownerId), eq(schema.positions.mode, mode))).orderBy(desc(schema.positions.createdAt));
const openPos = async (ownerId: string) => (await posOf(ownerId)).find((p) => p.status === 'OPEN');
const exitsOf = (positionId: string) => direct.db.select().from(schema.positionExits).where(eq(schema.positionExits.positionId, positionId)).orderBy(asc(schema.positionExits.filledAt), asc(schema.positionExits.createdAt));
const decisions = (eventId: string, blockId: string) => direct.db.select().from(schema.signalDecisions).where(and(eq(schema.signalDecisions.eventId, eventId), eq(schema.signalDecisions.orderBlockId, blockId)));
const lastEvent = async () => (await direct.db.select().from(schema.signalEvents).orderBy(desc(schema.signalEvents.receivedAt)).limit(1))[0]!;

/** A Bitunix price for the Bitunix instrument (exchange-keyed cache → BITUNIX_PUBLIC quote → market.tick). */
async function bitunixPrice(mark: string, at = clock.now) {
  cache.putBook('BITUNIX', 'BTCUSDT', { bid: D(mark).minus('0.1').toFixed(), ask: D(mark).plus('0.1').toFixed(), last: mark, exchangeTimeMs: at.getTime(), receivedAt: at });
  cache.putMark('BITUNIX', 'BTCUSDT', { mark, index: mark, exchangeTimeMs: at.getTime(), receivedAt: at });
  const w = new BitunixQuoteWriter(direct.db, cache, { minIntervalMs: 0 });
  await w.refresh();
  expect(await w.onUpdate('BTCUSDT', at)).toBe('WRITTEN');
  for (const x of Object.values(exch)) x.fillPrice.BTCUSDT = mark;
}

/** A price move on Bitunix: +10 s, quote, then the worker runs the exit rules and any closes. */
async function bitunixTick(mark: string) {
  clock.now = plus(clock.now, 10);
  setTestClock(() => clock.now);
  await bitunixPrice(mark);
  return drain(clock.now);
}

/** The next bar's alert through the shared webhook; prices on both exchanges unless told otherwise. */
async function alert(action: 'BULLISH_FLIP' | 'BEARISH_FLIP', o: { reference?: string; price?: string; bitunixFresh?: boolean } = {}) {
  bar = new Date(bar.getTime() + M15);
  clock.now = plus(new Date(bar.getTime() + M15), 3);
  setTestClock(() => clock.now);
  const price = o.price ?? '64000';
  await mexcTick(price, { at: clock.now });
  if (o.bitunixFresh !== false) await bitunixPrice(price);
  const status = await deliver(action, bar, o.reference ?? `${price}.0`);
  await drain(clock.now);
  return { status, event: await lastEvent() };
}

/** Bitunix-side closing trade (not TrendPilot's: no tp- client ID) for a position. */
function exchangeTrade(x: MockBitunixExchange, positionId: string, qty: string, price: string, at = clock.now.getTime()) {
  x.trades.push({ tradeId: String(990_000_000_000 + x.trades.length), orderId: String(980_000_000_000 + x.trades.length), positionId, symbol: 'BTCUSDT', side: 'SELL', qty, price, fee: '0.01', realizedPNL: '0.42', reduceOnly: true, clientId: null, ctime: at });
}

async function connectBitunix(who: 'a' | 'b', ownerId: string) {
  const x = exOf(ownerId);
  x.usdt.available = '5000';
  x.setSettings('BTCUSDT', { longLeverage: 10, shortLeverage: 10 });
  expect((await call(conn.PUT, { method: 'PUT', cookie: cookies[who], body: { exchange: 'BITUNIX', accountRef: `bx-${who}`, apiKey: `bitunix-key-${who}-1111`, secretKey: `bitunix-secret-${who}` } })).body.connection).toMatchObject({ status: 'VERIFIED', positionMode: 'HEDGE' });
  const ap = await call(approve.POST, { method: 'POST', path: '/x', cookie: cookies.admin, params: { id: (await bxConn(ownerId)).id }, body: LIMITS });
  expect(ap.status, JSON.stringify(ap.body)).toBe(200);
  expect((await call(activate.POST, { method: 'POST', path: '/v1/me/live/activate?exchange=BITUNIX', cookie: cookies[who] })).status).toBe(200);
  expect((await syncBitunixConnection(direct.db, (await bxConn(ownerId)).id, x)).ok).toBe(true);
}

async function liveBlock(who: 'a' | 'b', versionId: string, o: Record<string, unknown> = {}) {
  const created = await call(blocks.POST, { method: 'POST', path: '/x', cookie: cookies[who], body: blockBody({ instrumentId: bx, strategyVersionId: versionId, mode: 'LIVE', orderCostUsdt: '100', leverage: 10, weekdays: ALL_DAYS, ...o }) });
  expect(created.status).toBe(201);
  const rs = await call(resume.POST, { method: 'POST', path: '/x', cookie: cookies[who], params: { id: created.body.id }, ifMatch: created.body.revision });
  expect(rs.status, JSON.stringify(rs.body)).toBe(200);
  return created.body.id as string;
}

const TP = { mode: 'FIXED', levels: [{ id: 'tp1', movePct: '1', closePct: '100' }] };
const TRAIL = { enabled: true, activationPct: '2', distancePct: '0.5', closePct: '50', basis: 'MARK' };

beforeAll(async () => {
  await openFromAlert({ a: null, b: null }); // seeded users, cookies, clock; one alert on bar 09:15
  idA = await userId(USERS.investorA.email);
  idB = await userId(USERS.investorB.email);
  installLiveTestSeam({ requesterFor: () => new MockMexc(), bitunixRequesterFor: (c) => exOf(c.ownerId), transportEnabled: true, confirm: { attempts: 2, delayMs: 0 } });
  installBitunixTestSeam({ requesterFor: (c) => exOf(c.ownerId) });
  const added = await call(bitunixInstrument.POST, { method: 'POST', path: '/x', cookie: cookies.admin, body: { symbol: 'BTCUSDT' } });
  bx = added.body.instrument.id;
  await direct.db.update(schema.instruments).set({ status: 'PUBLISHED', isFixture: false }).where(eq(schema.instruments.id, bx));
  expect((await call(contracts.POST, { method: 'POST', path: '/x', cookie: cookies.admin, params: { id: bx }, body: { allowed: true } })).status).toBe(200);
  for (const c of ['OPEN_WITH_ATTACHED_STOP', 'REDUCE_ONLY_CLOSE', 'STOP_RESIZE_AFTER_PARTIAL_CLOSE', 'CANCEL_STOP', 'BITUNIX_OPEN_WITH_ATTACHED_STOP', 'BITUNIX_HEDGE_CLOSE_BY_POSITION'])
    expect((await call(capabilities.POST, { method: 'POST', path: '/x', cookie: cookies.admin, body: { capability: c, state: 'PILOT_ACCEPTED', evidence: 'test: mocked exchange' } })).status).toBe(200);
  expect((await call(platform.POST, { method: 'POST', path: '/x', cookie: cookies.admin, body: { enabled: true, note: 'test' } })).status).toBe(200);
  // Versions in the routed lineage: A reverses on the opposite flip; B uses the EMA 200 filter.
  const reverse = await publishVersion({ instrumentIds: [BTC, bx], oppositePolicy: 'CLOSE_AND_REVERSE' });
  const ema = await publishVersion({ instrumentIds: [BTC, bx], emaFilter: 'EMA200' });
  await connectBitunix('a', idA);
  await connectBitunix('b', idB);
  blockA = await liveBlock('a', reverse, { takeProfitLong: TP, takeProfitShort: TP, trailing: TRAIL });
  blockB = await liveBlock('b', ema);
  // B also trades the MEXC contract on Paper through the existing route.
  const paper = await call(blocks.POST, { method: 'POST', path: '/x', cookie: cookies.b, body: blockBody({ instrumentId: BTC, mode: 'PAPER', orderCostUsdt: '50', leverage: 5, weekdays: ALL_DAYS }) });
  expect(paper.status).toBe(201);
  await call(resume.POST, { method: 'POST', path: '/x', cookie: cookies.b, params: { id: paper.body.id }, ifMatch: paper.body.revision });
}, 120_000);

afterAll(async () => {
  installLiveTestSeam(null);
  installBitunixTestSeam(null);
  setTestClock(null);
  await teardown();
});

describe('routing', () => {
  it('without an explicit Bitunix target the alert reaches only the MEXC route’s blocks', async () => {
    const { status, event } = await alert('BULLISH_FLIP');
    expect(status).toBe(202);
    expect(event.targetInstrumentIds).toEqual([]);
    expect(await decisions(event.id, blockA)).toHaveLength(0);
    expect(await decisions(event.id, blockB)).toHaveLength(0);
    expect((await posOf(idB, 'PAPER')).filter((p) => p.status === 'OPEN')).toHaveLength(1); // MEXC route unchanged
    expect(exOf(idA).posts).toHaveLength(0);
    // The investor sees that no route delivers to the Bitunix contract yet.
    const items = (await call(instrumentsApi.GET, { cookie: cookies.a })).body.items as { id: string; exchange: string; exchangeSymbol: string; signalSources: string[] }[];
    expect(items.find((i) => i.id === bx)).toMatchObject({ exchange: 'BITUNIX', exchangeSymbol: 'BTCUSDT', signalSources: [] });
    expect(items.find((i) => i.id === BTC)!.signalSources.length).toBeGreaterThan(0);
  });

  it('an administrator links the Bitunix contract to the BTC routes; only the same contract on Bitunix is accepted', async () => {
    const routes = (await listSignalRoutes(direct.db)).filter((r) => r.instrument.id === BTC);
    expect(routes.length).toBeGreaterThan(0);
    // Wrong exchange / wrong contract are refused.
    expect((await call(routeTarget.PUT, { method: 'PUT', cookie: cookies.admin, params: { id: routes[0]!.id }, body: { instrumentId: BTC } })).status).toBe(400);
    for (const r of routes) {
      const res = await call(routeTarget.PUT, { method: 'PUT', cookie: cookies.admin, params: { id: r.id }, body: { instrumentId: bx } });
      expect(res.status).toBe(200);
      expect(res.body.target).toMatchObject({ exchange: 'BITUNIX', instrumentId: bx, exchangeSymbol: 'BTCUSDT', enabled: true });
    }
    expect((await listSignalRoutes(direct.db)).find((r) => r.id === routes[0]!.id)!.targets).toHaveLength(1);
    const items = (await call(instrumentsApi.GET, { cookie: cookies.a })).body.items as { id: string; signalSources: string[] }[];
    expect(items.find((i) => i.id === bx)!.signalSources).toEqual(expect.arrayContaining(['MEXC:BTCUSDT.P 15m']));
  });

  it('one alert dispatches to the MEXC Paper block and the Bitunix Live blocks, each exactly once', async () => {
    const { event } = await alert('BULLISH_FLIP');
    expect(event.targetInstrumentIds).toEqual([bx]);
    const dA = await decisions(event.id, blockA);
    expect(dA.map((d) => [d.step, d.status]).sort()).toEqual([
      ['ENTRY_SCREEN_V1', 'READY_FOR_EVALUATION'],
      ['ENTRY_V1', 'ENTRY_APPROVED']
    ]);
    const x = exOf(idA);
    expect(x.posts).toHaveLength(1);
    expect(x.posts[0]).toMatchObject({ symbol: 'BTCUSDT', side: 'BUY', tradeSide: 'OPEN', orderType: 'MARKET', qty: '0.0156', slStopType: 'MARK_PRICE', slOrderType: 'MARKET' });
    expect(await openPos(idA)).toMatchObject({ side: 'LONG', contracts: '0.015600000000', protectionStatus: 'PROTECTED', instrumentId: bx });
    // EMA on, Bitunix candles missing: B's entry is skipped with the reason (MEXC candles never stand in).
    const dB = (await decisions(event.id, blockB)).find((d) => d.step === 'ENTRY_V1');
    expect(dB).toMatchObject({ status: 'SKIPPED', reason: 'EMA_UNAVAILABLE' });
    expect(exOf(idB).posts).toHaveLength(0);
  });

  it('a redelivered alert is a duplicate: nothing is dispatched or sent twice', async () => {
    const before = (await direct.db.select().from(schema.signalDecisions)).length;
    const posts = exOf(idA).posts.length;
    const ev = await lastEvent();
    const raw = await deliver('BULLISH_FLIP', bar, '64000.0');
    expect(raw).toBe(200);
    await drain(clock.now);
    expect((await direct.db.select().from(schema.signalDecisions)).length).toBe(before);
    expect(exOf(idA).posts).toHaveLength(posts);
    expect((await lastEvent()).id).toBe(ev.id);
  });
});

describe('exits on Bitunix (same strategy rules as MEXC)', () => {
  it('Long: target close, then trailing take profit, each through BUY+CLOSE on the long positionId', async () => {
    const x = exOf(idA);
    const p = (await openPos(idA))!;
    // Trailing closes 100 % of its pool (the share Take Profit does not reserve).
    expect(p.trailingClosePct && D(p.trailingClosePct).toFixed()).toBe('100');
    await bitunixTick('64700'); // arms tp1 (64640.1)
    await bitunixTick('64600'); // pullback through it: closes the target share
    let closes = x.posts.filter((b) => b.tradeSide === 'CLOSE');
    expect(closes).toEqual([expect.objectContaining({ side: 'BUY', tradeSide: 'CLOSE', positionId: p.exchangePositionRef, qty: '0.0078', orderType: 'MARKET' })]);
    const mid = (await posOf(idA)).find((q) => q.id === p.id)!;
    expect(mid).toMatchObject({ status: 'OPEN', contracts: '0.007800000000', protectionStatus: 'PROTECTED' }); // whole-leg stop follows the leg
    await bitunixTick('65400'); // activates trailing (≥ 65280.1)
    await bitunixTick('65050'); // 0.5 % below the best level: trailing closes the rest
    closes = x.posts.filter((b) => b.tradeSide === 'CLOSE');
    expect(closes.at(-1)).toMatchObject({ side: 'BUY', tradeSide: 'CLOSE', positionId: p.exchangePositionRef, qty: '0.0078' });
    expect((await posOf(idA)).find((q) => q.id === p.id)).toMatchObject({ status: 'CLOSED' });
    expect((await exitsOf(p.id)).map((e) => e.reason)).toEqual(['TAKE_PROFIT', 'TRAILING_TAKE_PROFIT']);
  });

  it('price gap and stale Bitunix prices are skipped with the exchange named in the reason', async () => {
    const gap = await alert('BULLISH_FLIP', { reference: '65000.0' });
    const g = (await decisions(gap.event.id, blockA)).find((d) => d.step === 'ENTRY_V1');
    expect(g).toMatchObject({ status: 'SKIPPED', reason: 'PRICE_DEVIATION' });
    expect(g!.detail).toMatchObject({ exchange: 'BITUNIX', executionSymbol: 'BTCUSDT', priceSource: 'BITUNIX_PUBLIC', reasonText: expect.stringMatching(/^The Bitunix price for BTCUSDT/) });
    const stale = await alert('BULLISH_FLIP', { bitunixFresh: false });
    const s = (await decisions(stale.event.id, blockA)).find((d) => d.step === 'ENTRY_V1');
    expect(s).toMatchObject({ status: 'SKIPPED', reason: 'FEED_STALE' });
    expect(s!.detail).toMatchObject({ exchange: 'BITUNIX', feed: 'STALE', reasonText: expect.stringMatching(/latest Bitunix price .* too old/) });
    expect(exOf(idA).posts.filter((b) => b.tradeSide === 'OPEN')).toHaveLength(1);
  });

  it('Short: target close, then trailing take profit, through SELL+CLOSE on the short positionId', async () => {
    const x = exOf(idA);
    await alert('BEARISH_FLIP');
    const p = (await openPos(idA))!;
    expect(p).toMatchObject({ side: 'SHORT', contracts: '0.015600000000' });
    expect(x.posts.at(-1)).toMatchObject({ side: 'SELL', tradeSide: 'OPEN' });
    await bitunixTick('63300'); // arms tp1 (63359.9)
    await bitunixTick('63400'); // pullback through it
    await bitunixTick('62700'); // activates trailing (≤ 62719.9)
    await bitunixTick('63050'); // 0.5 % above the best level
    const closes = x.posts.filter((b) => b.tradeSide === 'CLOSE' && b.positionId === p.exchangePositionRef);
    expect(closes.map((b) => [b.side, b.qty])).toEqual([
      ['SELL', '0.0078'],
      ['SELL', '0.0078']
    ]);
    expect((await exitsOf(p.id)).map((e) => e.reason)).toEqual(['TAKE_PROFIT', 'TRAILING_TAKE_PROFIT']);
    expect((await posOf(idA)).find((q) => q.id === p.id)).toMatchObject({ status: 'CLOSED' });
  });
});

describe('close-and-reverse on Bitunix', () => {
  it('a partly filled close keeps the reversal withheld; nothing opens on the other leg', async () => {
    const x = exOf(idA);
    await alert('BULLISH_FLIP');
    const long = (await openPos(idA))!;
    expect(long.side).toBe('LONG');
    x.next = { fillFraction: '0.5' };
    const { event } = await alert('BEARISH_FLIP');
    const entry = (await decisions(event.id, blockA)).find((d) => d.step === 'ENTRY_V1');
    expect(entry).toMatchObject({ status: 'SKIPPED', reason: 'REVERSAL_CLOSE_INCOMPLETE' });
    expect(x.posts.filter((b) => b.side === 'SELL' && b.tradeSide === 'OPEN')).toHaveLength(1); // only the earlier short
    expect((await posOf(idA)).find((q) => q.id === long.id)).toMatchObject({ status: 'OPEN', contracts: '0.007800000000' });
    // Close the rest by hand for the next scenario.
    await direct.db.transaction(async (tx) => requestExit(tx, { position: (await tx.select().from(schema.positions).where(eq(schema.positions.id, long.id)))[0]!, reason: 'MANUAL_CLOSE', now: clock.now }));
    await drain(clock.now);
    expect((await posOf(idA)).find((q) => q.id === long.id)).toMatchObject({ status: 'CLOSED' });
  });

  it('the reversal opens the Short only after Bitunix confirmed the Long leg flat', async () => {
    const x = exOf(idA);
    await alert('BULLISH_FLIP');
    const long = (await openPos(idA))!;
    const sent = x.posts.length;
    const { event } = await alert('BEARISH_FLIP');
    const after = x.posts.slice(sent);
    expect(after.map((b) => `${b.side}+${b.tradeSide}`)).toEqual(['BUY+CLOSE', 'SELL+OPEN']); // close first, then the new leg
    expect(after[0]).toMatchObject({ positionId: long.exchangePositionRef });
    expect((await posOf(idA)).find((q) => q.id === long.id)).toMatchObject({ status: 'CLOSED' });
    expect(await openPos(idA)).toMatchObject({ side: 'SHORT' });
    expect((await decisions(event.id, blockA)).find((d) => d.step === 'ENTRY_V1')).toMatchObject({ status: 'ENTRY_APPROVED' });
  });
});

describe('closes made on Bitunix', () => {
  it('a manual partial close on Bitunix is booked once; protection is whole-leg; another leg is untouched', async () => {
    const x = exOf(idA);
    const short = (await openPos(idA))!;
    // A Long leg opened on Bitunix outside TrendPilot: it is not TrendPilot's and stays untouched.
    x.positions.set('700000077777', { positionId: '700000077777', symbol: 'BTCUSDT', side: 'LONG', qty: '0.2', avgOpenPrice: '64000', mtime: Date.now() });
    const leg = x.positions.get(short.exchangePositionRef!)!;
    leg.qty = '0.01';
    leg.mtime = clock.now.getTime() + 1_000;
    exchangeTrade(x, leg.positionId, '0.0056', '63900');
    const s1 = await syncBitunixConnection(direct.db, (await bxConn(idA)).id, x);
    expect(s1.ok).toBe(true);
    expect(s1.links?.find((l) => l.positionId === short.id)).toMatchObject({ result: 'PARTIAL', booked: [{ contracts: '0.0056', reason: 'EXTERNAL_CLOSE' }], protection: { kind: 'WHOLE_LEG', status: 'PROTECTED' } });
    expect((await posOf(idA)).find((q) => q.id === short.id)).toMatchObject({ status: 'OPEN', contracts: '0.010000000000' });
    const s2 = await syncBitunixConnection(direct.db, (await bxConn(idA)).id, x);
    expect(s2.links?.find((l) => l.positionId === short.id)).toMatchObject({ result: 'IN_SYNC', booked: [] });
    expect(await exitsOf(short.id)).toHaveLength(1);
    expect(x.positions.get('700000077777')).toMatchObject({ qty: '0.2' });
    expect((await posOf(idA)).filter((p) => p.exchangePositionRef === '700000077777')).toHaveLength(0);
  });

  it('a TP/SL trigger alone closes nothing; the stop’s execution on Bitunix closes the position exactly once', async () => {
    const x = exOf(idA);
    const short = (await openPos(idA))!;
    const trigger = { channel: 'tpsl', event: 'CLOSE', status: 'FILLED', orderId: '555000', positionId: short.exchangePositionRef, symbol: 'BTCUSDT', side: 'BUY', slPrice: '64960', slQty: null, tpPrice: null, tpQty: null, ctimeMs: clock.now.getTime(), tsMs: clock.now.getTime(), receivedAt: clock.now, seq: 1 } as BitunixPrivateEvent;
    await applyBitunixEvent(direct.db, await bxConn(idA), trigger);
    await syncBitunixConnection(direct.db, (await bxConn(idA)).id, x);
    expect((await posOf(idA)).find((q) => q.id === short.id)).toMatchObject({ status: 'OPEN' }); // trigger only: child not filled
    // The stop's child order fills on Bitunix and the leg is gone (history confirms the close).
    exchangeTrade(x, short.exchangePositionRef!, '0.01', '64960', clock.now.getTime() + 2_000);
    x.closeOnExchange(short.exchangePositionRef!, { closePrice: '64960', mtime: clock.now.getTime() + 2_000, fee: '0.4', funding: '0' });
    const r = await syncBitunixConnection(direct.db, (await bxConn(idA)).id, x);
    expect(r.links?.find((l) => l.positionId === short.id)).toMatchObject({ result: 'FULL', booked: [{ contracts: '0.01', reason: 'STOP_LOSS' }] });
    expect((await posOf(idA)).find((q) => q.id === short.id)).toMatchObject({ status: 'CLOSED' });
    await syncBitunixConnection(direct.db, (await bxConn(idA)).id, x);
    expect((await exitsOf(short.id)).map((e) => e.reason)).toEqual(['EXTERNAL_CLOSE', 'STOP_LOSS']);
  });
});

describe('EMA 200 on Bitunix candles', () => {
  it('backfills closed Bitunix candles into their own history; with it, B’s EMA block evaluates the filter', async () => {
    // A fake Bitunix kline endpoint: closed 15m bars, newest first, `time` as an ms string (as live).
    const fakeFetch = (async (u: URL | string) => {
      const url = new URL(String(u));
      const end = Number(url.searchParams.get('endTime'));
      const limit = Number(url.searchParams.get('limit'));
      expect(url.searchParams.get('interval')).toMatch(/^(5m|15m)$/);
      const ms = url.searchParams.get('interval') === '5m' ? 300_000 : 900_000;
      const data = [];
      for (let t = end - ms, i = 0; i < limit; t -= ms, i++) {
        const close = D(64000).minus(D(i).times(5)).toFixed();
        data.push({ open: close, high: close, low: close, close, time: String(t), quoteVol: '1', baseVol: '1' });
      }
      return new Response(JSON.stringify({ code: 0, data, msg: 'Success' }));
    }) as typeof fetch;
    // Next alert bar first, so the backfill includes the signal bar.
    bar = new Date(bar.getTime() + M15);
    clock.now = plus(new Date(bar.getTime() + M15), 5);
    setTestClock(() => clock.now);
    const mexcCandlesBefore = (await direct.db.select().from(schema.marketCandles).where(eq(schema.marketCandles.instrumentId, BTC))).length;
    const feed = new MarketFeed(direct.db, { source: new BitunixKlineSource({ fetch: fakeFetch, now: () => clock.now.getTime() }), exchange: 'BITUNIX', now: () => clock.now, intervals: ['15'] });
    const r = await feed.candleCycle();
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ symbol: 'BTCUSDT', interval: '15' });
    expect(r[0]!.error).toBeUndefined();
    expect(r[0]!.written).toBeGreaterThanOrEqual(260);
    const bxCandles = await direct.db.select().from(schema.marketCandles).where(eq(schema.marketCandles.instrumentId, bx));
    expect(bxCandles.length).toBeGreaterThanOrEqual(260);
    expect(new Set(bxCandles.map((c) => c.source))).toEqual(new Set(['BITUNIX_PUBLIC']));
    expect(bxCandles.every((c) => c.closed && c.openTime.getTime() + M15 <= clock.now.getTime())).toBe(true);
    expect((await direct.db.select().from(schema.marketCandles).where(eq(schema.marketCandles.instrumentId, BTC))).length).toBe(mexcCandlesBefore);
    // The alert for that bar: B's EMA block now passes the EMA check (price above a rising EMA).
    await mexcTick('64000', { at: clock.now });
    await bitunixPrice('64000');
    expect(await deliver('BULLISH_FLIP', bar, '64000.0')).toBe(202);
    await drain(clock.now);
    const ev = await lastEvent();
    const dB = (await decisions(ev.id, blockB)).find((d) => d.step === 'ENTRY_V1');
    expect(dB).toMatchObject({ status: 'ENTRY_APPROVED' });
    expect((dB!.detail as { checks?: { ema?: unknown } }).checks).toBeTruthy();
    expect(exOf(idB).posts.at(-1)).toMatchObject({ side: 'BUY', tradeSide: 'OPEN', symbol: 'BTCUSDT' });
  });
});
