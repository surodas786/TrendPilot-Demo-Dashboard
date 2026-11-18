// Lighter plan Step 3: TradingView → explicit Lighter route target → Lighter PAPER, end to end
// through the shared webhook and the worker (no direct entry calls). FIXTURE route: the source
// fields MEXC:XAUUSDT.P / 15m are a labelled test fixture (no real or redacted XAU alert exists in
// the repository), routed to a MEXC XAU contract with Lighter XAU (catalog market 92) as an
// explicit target. Prices: Lighter public quotes (LIGHTER_PUBLIC, documented WS field shape) and
// Lighter candles; nothing calls Lighter, and no Live transport may be touched (the Live seam throws).
import { and, desc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addLighterInstrument, assessEntry, ExchangePriceCache, installLiveTestSeam, LighterQuoteWriter, lighterSignerLoads, listMyOutcomes, lockPaperAccount, recordMarketTick, schema } from '@trendpilot/db';
import { buildTradingViewPayload, Decimal, fixtureCandles, PAPER_USDT_USDC_PARITY } from '@trendpilot/domain';
import * as blocks from '@/app/v1/me/order-blocks/route';
import * as blockById from '@/app/v1/me/order-blocks/[id]/route';
import * as resume from '@/app/v1/me/order-blocks/[id]/resume/route';
import * as preview from '@/app/v1/me/order-blocks/preview/route';
import * as routesApi from '@/app/v1/admin/signal-routes/route';
import * as lighterTarget from '@/app/v1/admin/signal-routes/[id]/lighter-target/route';
import * as instrumentPatch from '@/app/v1/admin/instruments/[id]/route';
import * as holdingsApi from '@/app/v1/me/holdings/route';
import * as dashboardApi from '@/app/v1/me/dashboard/route';
import * as closePos from '@/app/v1/me/positions/[id]/close/route';
import * as webhook from '@/app/v1/webhooks/tradingview/[ingressToken]/route';
import { setTestClock } from '@/server/clock';
import { BTC, VERSION, blockBody, call, direct, teardown, userId, USERS } from '../helpers';
import { ALL_DAYS, clock, cookies, drain, M15, openFromAlert, plus, publishVersion } from '../paperReplay';

const D = (v: Decimal.Value) => new Decimal(v);
let mexcXau: string;
let lighterXau: string;
let lighterBtc: string;
let pkgId: string;
let version: string;
let idA: string;
let idB: string;
const blockOf: Record<string, string> = {};
const routeIds: Record<string, string> = {};
let bar = new Date('2026-11-08T09:15:00Z');
const cache = new ExchangePriceCache();
let writer: LighterQuoteWriter;

/** A Lighter price (ticker + market_stats → FRESH joined quote → LIGHTER_PUBLIC quote and market.tick). */
async function lighterPrice(mid: string, at = clock.now) {
  const m = D(mid);
  writer.onStats({ marketId: '92', mark: m.toFixed(), index: m.toFixed(), last: m.toFixed(), exchangeTimeMs: at.getTime(), receivedAt: at, snapshot: false });
  writer.onTicker({ marketId: '92', bid: m.minus('0.05').toFixed(), ask: m.plus('0.05').toFixed(), exchangeTimeMs: at.getTime(), nonce: at.getTime(), receivedAt: at, snapshot: false });
  expect(await writer.onUpdate('92', at)).toBe('WRITTEN');
}
/** A MEXC price for the MEXC XAU contract (its own MEXC_PUBLIC quote). */
const mexcPrice = (mid: string, at = clock.now) => recordMarketTick(direct.db, { instrumentId: mexcXau, asOf: at, bid: D(mid).minus('0.01').toFixed(), ask: D(mid).plus('0.01').toFixed(), mark: mid, last: mid, source: 'MEXC_PUBLIC', channel: 'WS' });

/** FIXTURE alert: TradingView MEXC:XAUUSDT.P 15m (exact strings unverified against a real alert). */
async function deliverXau(action: 'BULLISH_FLIP' | 'BEARISH_FLIP' | 'CLOSE_LONG' | 'CLOSE_SHORT', barOpen: Date, referencePrice: string) {
  const token = process.env.DEV_INGRESS_TOKEN!;
  const raw = JSON.stringify(buildTradingViewPayload({ action, exchange: 'MEXC', symbol: 'XAUUSDT.P', interval: '15', barOpen, firedAt: plus(new Date(barOpen.getTime() + M15), 1), referencePrice }));
  const res = await webhook.POST(new Request(`http://localhost/v1/webhooks/tradingview/${token}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: raw }), { params: Promise.resolve({ ingressToken: token }) });
  return { status: res.status, raw };
}

/** Next bar's alert with fresh prices on both venues (unless told otherwise), then the worker runs. */
async function alert(action: 'BULLISH_FLIP' | 'BEARISH_FLIP' | 'CLOSE_LONG' | 'CLOSE_SHORT', o: { lighter?: string | null; mexc?: string; ref?: string } = {}) {
  bar = new Date(bar.getTime() + M15);
  clock.now = plus(new Date(bar.getTime() + M15), 3);
  setTestClock(() => clock.now);
  if (o.lighter !== null) await lighterPrice(o.lighter ?? '3860');
  await mexcPrice(o.mexc ?? '3860');
  const r = await deliverXau(action, bar, o.ref ?? '3860.0');
  await drain(clock.now);
  const [event] = await direct.db.select().from(schema.signalEvents).orderBy(desc(schema.signalEvents.receivedAt)).limit(1);
  return { ...r, event: event! };
}

/** A Lighter price move: +10 s, quote, worker (exit rules, closes). */
async function lighterTick(mid: string) {
  clock.now = plus(clock.now, 10);
  setTestClock(() => clock.now);
  await lighterPrice(mid);
  await drain(clock.now);
}

const posOf = (ownerId: string, instrumentId: string) => direct.db.select().from(schema.positions).where(and(eq(schema.positions.ownerId, ownerId), eq(schema.positions.instrumentId, instrumentId))).orderBy(desc(schema.positions.openedAt));
const openPos = async (ownerId: string, instrumentId: string) => (await posOf(ownerId, instrumentId)).find((p) => p.status === 'OPEN');
const entryDecision = async (eventId: string, blockId: string) => (await direct.db.select().from(schema.signalDecisions).where(and(eq(schema.signalDecisions.eventId, eventId), eq(schema.signalDecisions.orderBlockId, blockId), eq(schema.signalDecisions.step, 'ENTRY_V1'))))[0];
const account = async (ownerId: string, exchange: 'MEXC' | 'LIGHTER') => (await direct.db.select().from(schema.paperAccounts).where(and(eq(schema.paperAccounts.ownerId, ownerId), eq(schema.paperAccounts.mode, 'PAPER'), eq(schema.paperAccounts.exchange, exchange))))[0];
const setTarget = (routeId: string, instrumentId: string | null, enabled = true) => call(lighterTarget.PUT, { method: 'PUT', path: '/x', cookie: cookies.admin, params: { id: routeId }, body: { instrumentId, enabled } });

async function makeBlock(who: 'a' | 'b', instrumentId: string, o: Record<string, unknown> = {}) {
  const c = await call(blocks.POST, { method: 'POST', path: '/x', cookie: cookies[who], body: blockBody({ instrumentId, strategyVersionId: version, mode: 'PAPER', weekdays: ALL_DAYS, ...o }) });
  expect(c.status, JSON.stringify(c.body)).toBe(201);
  const r = await call(resume.POST, { method: 'POST', path: '/x', cookie: cookies[who], params: { id: c.body.id }, ifMatch: c.body.revision });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return c.body.id as string;
}

beforeAll(async () => {
  await openFromAlert({ a: null, b: null });
  idA = await userId(USERS.investorA.email);
  idB = await userId(USERS.investorB.email);
  // No Live transport may be reached by anything in this file.
  installLiveTestSeam({
    requesterFor: () => {
      throw new Error('Live transport reached from a Lighter Paper flow');
    },
    bitunixRequesterFor: () => {
      throw new Error('Live transport reached from a Lighter Paper flow');
    },
    transportEnabled: true
  });
  // MEXC XAU contract (fixture row) for the source chart's own route.
  const [mx] = await direct.db
    .insert(schema.instruments)
    .values({ exchange: 'MEXC', symbol: 'XAUUSDT', exchangeSymbol: 'XAU_USDT', base: 'XAU', quote: 'USDT', status: 'PUBLISHED', contractMultiplier: '0.001', qtyStep: '1', minQty: '1', maxQty: '100000', priceTick: '0.01', takerFeeRate: '0.0004', leverageChoices: [1, 2, 5, 10, 20], suggestedStopPct: '1.5', suggestedTakeProfitPct: '3', suggestedTrailingPct: '1' })
    .returning({ id: schema.instruments.id });
  mexcXau = mx!.id;
  const admin = await userId(USERS.admin.email);
  lighterXau = (await addLighterInstrument(direct.db, admin, 'XAU')).instrument.id;
  lighterBtc = (await addLighterInstrument(direct.db, admin, 'BTC')).instrument.id;
  for (const id of [lighterXau, lighterBtc]) {
    const inst = (await direct.db.select().from(schema.instruments).where(eq(schema.instruments.id, id)))[0]!;
    expect((await call(instrumentPatch.PATCH, { method: 'PATCH', path: '/x', cookie: cookies.admin, params: { id }, body: { status: 'PUBLISHED' }, ifMatch: inst.revision })).status).toBe(200);
  }
  version = await publishVersion({ instrumentIds: [BTC, mexcXau, lighterXau] });
  pkgId = (await direct.db.select().from(schema.strategyVersions).where(eq(schema.strategyVersions.id, VERSION)))[0]!.packageId;
  for (const action of ['BULLISH_FLIP', 'BEARISH_FLIP', 'CLOSE_LONG', 'CLOSE_SHORT'] as const) {
    const r = await call(routesApi.POST, { method: 'POST', path: '/x', cookie: cookies.admin, body: { name: `XAU 15m ${action} (fixture)`, sourceExchange: 'MEXC', sourceSymbol: 'XAUUSDT.P', interval: '15', action, kind: 'ACTIONABLE', instrumentId: mexcXau, packageId: pkgId, maxSignalAgeSeconds: 120, clockToleranceSeconds: 5 } });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    routeIds[action] = r.body.id;
  }
  writer = new LighterQuoteWriter(direct.db, cache, { minIntervalMs: 0 });
  expect(await writer.refresh()).toEqual(['1', '92']);
  // A: Lighter Paper (separate Long / Short TP) and the MEXC XAU contract on Paper (USDT account).
  blockOf.aLighter = await makeBlock('a', lighterXau, { orderCostUsdt: '100', leverage: 10, takeProfitLong: { mode: 'FIXED', levels: [{ id: 'tp1', movePct: '2', closePct: '100' }] }, takeProfitShort: { mode: 'FIXED', levels: [{ id: 'tp1', movePct: '4', closePct: '100' }] } });
  blockOf.aMexc = await makeBlock('a', mexcXau, { orderCostUsdt: '100', leverage: 10 });
  // B: Lighter Paper with fixed TP 1 % and Trailing Take Profit managing 50 % (target close), stop 3 % LAST.
  blockOf.bLighter = await makeBlock('b', lighterXau, {
    orderCostUsdt: '50',
    leverage: 5,
    stop: { type: 'PERCENT', value: '3', basis: 'LAST' },
    takeProfit: { mode: 'FIXED', levels: [{ id: 'tp1', movePct: '1', closePct: '100' }] },
    trailing: { enabled: true, activationPct: '2', distancePct: '0.5', closePct: '50', basis: 'MARK' }
  });
}, 180_000);

afterAll(async () => {
  installLiveTestSeam(null);
  setTestClock(null);
  await teardown();
});

describe('explicit route to a Lighter target', () => {
  it('only a published Lighter market approved by the route strategy can be the target; nothing is inferred', async () => {
    expect((await setTarget(routeIds.BULLISH_FLIP!, BTC)).status).toBe(400); // a MEXC contract
    expect((await setTarget(routeIds.BULLISH_FLIP!, lighterBtc)).status).toBe(409); // not approved by the strategy
    for (const action of Object.keys(routeIds)) {
      const r = await setTarget(routeIds[action]!, lighterXau);
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(r.body.target).toMatchObject({ exchange: 'LIGHTER', instrumentId: lighterXau, enabled: true });
    }
  });
});

describe('one alert, two investors, two destinations', () => {
  let eventId: string;
  it('opens Lighter Paper positions on Lighter prices in an isolated USDC account, and the MEXC block on MEXC prices', async () => {
    const { status, event } = await alert('BULLISH_FLIP', { lighter: '3860', mexc: '3859.5' });
    expect(status).toBe(202);
    eventId = event.id;
    expect(event.targetInstrumentIds).toEqual([lighterXau]);
    const a = (await openPos(idA, lighterXau))!;
    const b = (await openPos(idB, lighterXau))!;
    expect(a).toMatchObject({ mode: 'PAPER', side: 'LONG', status: 'OPEN' });
    expect(b).toMatchObject({ mode: 'PAPER', side: 'LONG', status: 'OPEN' });
    // Filled at Lighter's own ask (3860.05), never at the MEXC price (3859.51).
    expect(D(a.avgEntryPrice).toFixed()).toBe('3860.05');
    // Sizing: 100 USDC × 10 / 3860.05 floored to Lighter's 0.0001 step.
    expect(D(a.contracts).toFixed()).toBe(D(1000).div('3860.05').toDecimalPlaces(4, Decimal.ROUND_DOWN).toFixed());
    // Separate accounts: Lighter Paper (USDC) and MEXC Paper (USDT).
    const la = (await account(idA, 'LIGHTER'))!;
    const ma = (await account(idA, 'MEXC'))!;
    expect(la).toMatchObject({ currency: 'USDC' });
    expect(ma).toMatchObject({ currency: 'USDT' });
    expect(a.paperAccountId).toBe(la.id);
    const mexcPos = (await openPos(idA, mexcXau))!;
    expect(mexcPos.paperAccountId).toBe(ma.id);
    expect(D(mexcPos.avgEntryPrice).toFixed()).toBe('3859.51');
    expect(D(la.positionMargin).gt(0)).toBe(true);
    expect((await account(idB, 'LIGHTER'))!.id).not.toBe(la.id);
  });

  it('records both prices apart: TradingView reference (USDT) and the Lighter price used (USDC), with the approved Paper parity', async () => {
    const d = (await entryDecision(eventId, blockOf.aLighter!))!;
    const checks = (d.detail as { checks: Record<string, any> }).checks;
    expect(checks.quote).toMatchObject({ source: 'LIGHTER_PUBLIC', currency: 'USDC', bid: expect.stringMatching(/^3859\.95/), ask: expect.stringMatching(/^3860\.05/) });
    expect(checks.reference).toEqual({ price: expect.stringMatching(/^3860/), currency: 'USDT' });
    expect(checks.comparison).toMatchObject({ policy: PAPER_USDT_USDC_PARITY });
    const mexcD = (await entryDecision(eventId, blockOf.aMexc!))!;
    expect((mexcD.detail as { checks: Record<string, any> }).checks.comparison).toEqual({ policy: 'SAME_CURRENCY' });
    const outcome = (await listMyOutcomes(direct.db, idA, 20)).find((o) => o.signal.eventId === eventId && o.orderBlockId === blockOf.aLighter)!;
    expect(outcome.entry!.prices).toMatchObject({
      reference: { source: 'MEXC:XAUUSDT.P', currency: 'USDT', type: expect.stringMatching(/TradingView/) },
      venue: { exchange: 'LIGHTER', symbol: 'XAU', currency: 'USDC', bid: '3859.95', ask: '3860.05', source: 'LIGHTER_PUBLIC' },
      comparison: { policy: PAPER_USDT_USDC_PARITY },
      fill: { price: '3860.05', simulated: true }
    });
  });

  it('a duplicate delivery and a worker retry open nothing more', async () => {
    const before = (await direct.db.select().from(schema.positions)).length;
    const raw = JSON.stringify(buildTradingViewPayload({ action: 'BULLISH_FLIP', exchange: 'MEXC', symbol: 'XAUUSDT.P', interval: '15', barOpen: bar, firedAt: plus(new Date(bar.getTime() + M15), 1), referencePrice: '3860.0' }));
    const token = process.env.DEV_INGRESS_TOKEN!;
    const res = await webhook.POST(new Request(`http://localhost/v1/webhooks/tradingview/${token}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: raw }), { params: Promise.resolve({ ingressToken: token }) });
    expect(res.status).toBe(200); // duplicate
    await drain(clock.now);
    await drain(clock.now);
    expect((await direct.db.select().from(schema.positions)).length).toBe(before);
  });

  it('Holdings and Dashboard report the Lighter Paper account apart from MEXC Paper (USDC vs USDT)', async () => {
    const h = await call(holdingsApi.GET, { path: '/x?mode=PAPER&exchange=LIGHTER', cookie: cookies.a });
    expect(h.status).toBe(200);
    expect((h.body.positions as { instrumentId: string; price: { source: string } | null }[]).map((p) => p.instrumentId)).toEqual([lighterXau]);
    expect(h.body.positions[0].price).toMatchObject({ source: 'LIGHTER_PUBLIC' });
    expect(h.body.accounts.lighterPaper).toBeTruthy();
    const mexcView = await call(holdingsApi.GET, { path: '/x?mode=PAPER&exchange=MEXC', cookie: cookies.a });
    expect((mexcView.body.positions as { instrumentId: string }[]).map((p) => p.instrumentId)).toEqual([mexcXau]);
    const dash = await call(dashboardApi.GET, { path: '/x?mode=PAPER&exchange=LIGHTER', cookie: cookies.a });
    expect(dash.status, JSON.stringify(dash.body)).toBe(200);
    expect(dash.body).toMatchObject({ exchange: 'LIGHTER', positions: { open: 1 } });
    expect((await call(dashboardApi.GET, { path: '/x?mode=LIVE&exchange=LIGHTER', cookie: cookies.a })).status).toBe(422);
  });
});

describe('exits on Lighter prices (Paper simulator)', () => {
  it('fixed TP per side (arm, then close on the pullback through it) and Trailing Take Profit, all at Lighter prices', async () => {
    const entryA = D((await openPos(idA, lighterXau))!.avgEntryPrice);
    const b0 = (await openPos(idB, lighterXau))!;
    // +2.5 %: arms A's long target (2 %) and B's target (1 %); activates B's trailing (2 %).
    await lighterTick(entryA.times('1.025').toFixed(2));
    expect(await openPos(idA, lighterXau)).toBeTruthy();
    // Pullback to +1.85 %: A's target is crossed back → A closes (target close); B's trailing
    // (0.5 % below its best level) closes the trailing share; B's 1 % target is not crossed yet.
    const t2 = entryA.times('1.0185').toFixed(2);
    await lighterTick(t2);
    expect(await openPos(idA, lighterXau)).toBeUndefined();
    const aClosed = (await posOf(idA, lighterXau))[0]!;
    const exitsA = await direct.db.select().from(schema.positionExits).where(eq(schema.positionExits.positionId, aClosed.id));
    expect(exitsA.map((x) => x.reason)).toEqual(['TAKE_PROFIT']);
    expect(D(exitsA[0]!.price).toFixed()).toBe(D(t2).minus('0.05').toFixed()); // Lighter bid at that tick
    const bMid = (await posOf(idB, lighterXau)).find((p) => p.id === b0.id)!;
    expect(bMid.status).toBe('OPEN');
    expect(D(bMid.contracts).lt(b0.contracts)).toBe(true);
    // Further pullback through B's 1 % target: the target share closes; B is flat.
    await lighterTick(entryA.times('1.008').toFixed(2));
    expect(await openPos(idB, lighterXau)).toBeUndefined();
    const exitsB = await direct.db.select().from(schema.positionExits).where(eq(schema.positionExits.positionId, b0.id));
    expect(exitsB.map((x) => x.reason).sort()).toEqual(['TAKE_PROFIT', 'TRAILING_TAKE_PROFIT']);
    // MEXC XAU (A) is untouched by Lighter prices.
    expect(await openPos(idA, mexcXau)).toBeTruthy();
  });

  it('the opening stop triggers on the saved Lighter basis (B: LAST 3 %)', async () => {
    await alert('BULLISH_FLIP', { lighter: '3860' });
    const b = (await openPos(idB, lighterXau))!;
    expect(b).toBeTruthy();
    await lighterTick(D(b.avgEntryPrice).times('0.968').toFixed(2));
    expect(await openPos(idB, lighterXau)).toBeUndefined();
    const ex = await direct.db.select().from(schema.positionExits).where(eq(schema.positionExits.positionId, b.id));
    expect(ex.map((x) => x.reason)).toEqual(['STOP_LOSS']);
  });

  it('manual close (Paper) and close on signal', async () => {
    await alert('BULLISH_FLIP', { lighter: '3860' });
    const a = (await openPos(idA, lighterXau))!;
    expect(a).toBeTruthy();
    expect(await openPos(idB, lighterXau)).toBeTruthy();
    const r = await call(closePos.POST, { method: 'POST', path: '/x', cookie: cookies.a, params: { id: a.id }, headers: { 'idempotency-key': 'lighter-manual-1' } });
    expect(r.status, JSON.stringify(r.body)).toBeLessThan(300);
    await drain(clock.now);
    expect(await openPos(idA, lighterXau)).toBeUndefined();
    expect((await direct.db.select().from(schema.positionExits).where(eq(schema.positionExits.positionId, a.id))).map((x) => x.reason)).toEqual(['MANUAL_CLOSE']);
    await alert('CLOSE_LONG', { lighter: '3861' });
    expect(await openPos(idB, lighterXau)).toBeUndefined();
  });

  it('removing the Lighter target stops new entries but never strands exits of positions this stream opened', async () => {
    await alert('BULLISH_FLIP', { lighter: '3860' });
    expect(await openPos(idA, lighterXau)).toBeTruthy();
    for (const action of Object.keys(routeIds)) expect((await setTarget(routeIds[action]!, null)).status).toBe(200);
    await alert('CLOSE_LONG', { lighter: '3862' });
    expect(await openPos(idA, lighterXau)).toBeUndefined();
    expect(await openPos(idB, lighterXau)).toBeUndefined();
    const { event } = await alert('BULLISH_FLIP', { lighter: '3860' });
    expect(event.targetInstrumentIds).toEqual([]);
    expect(await openPos(idA, lighterXau)).toBeUndefined();
    for (const action of Object.keys(routeIds)) expect((await setTarget(routeIds[action]!, lighterXau)).status).toBe(200);
  });

  it('close and reverse: the opposite Lighter entry opens only after the long is confirmed flat', async () => {
    const reverse = await publishVersion({ instrumentIds: [BTC, mexcXau, lighterXau], oppositePolicy: 'CLOSE_AND_REVERSE' });
    const blk = (await call(blockById.GET, { cookie: cookies.a, params: { id: blockOf.aLighter! } })).body;
    expect((await call(blockById.PATCH, { method: 'PATCH', path: '/x', cookie: cookies.a, params: { id: blockOf.aLighter! }, body: { strategyVersionId: reverse }, ifMatch: blk.revision })).status).toBe(200);
    await alert('BULLISH_FLIP', { lighter: '3860' });
    const long = (await openPos(idA, lighterXau))!;
    expect(long.side).toBe('LONG');
    await alert('BEARISH_FLIP', { lighter: '3858' });
    const after = await posOf(idA, lighterXau);
    expect(after.find((p) => p.id === long.id)!.status).toBe('CLOSED');
    const short = after.find((p) => p.status === 'OPEN')!;
    expect(short.side).toBe('SHORT');
    expect(short.openedAt.getTime()).toBeGreaterThanOrEqual(after.find((p) => p.id === long.id)!.closedAt!.getTime());
    // Short entry at Lighter's bid; the short TP (4 %) is the short side's own.
    expect(D(short.avgEntryPrice).toFixed()).toBe('3857.95');
    await alert('CLOSE_SHORT', { lighter: '3858' });
    await alert('CLOSE_LONG', { lighter: '3858' }); // B kept its long (its block keeps positions on an opposite signal)
    expect(await openPos(idA, lighterXau)).toBeUndefined();
    expect(await openPos(idB, lighterXau)).toBeUndefined();
  });
});

describe('entry checks on Lighter data only', () => {
  it('a stale Lighter quote blocks the Lighter entries even with a fresh MEXC price (no substitution)', async () => {
    const { event } = await alert('BULLISH_FLIP', { lighter: null, mexc: '3860' });
    const d = (await entryDecision(event.id, blockOf.bLighter!))!;
    expect(d).toMatchObject({ status: 'SKIPPED', reason: 'FEED_STALE' });
    expect(await openPos(idB, lighterXau)).toBeUndefined();
    // A MEXC price written onto the Lighter instrument is ignored as well.
    await direct.db.insert(schema.marketQuotes).values({ instrumentId: lighterXau, asOf: clock.now, bid: '3860', ask: '3860.1', mark: '3860', last: '3860', source: 'MEXC_PUBLIC', channel: 'WS' });
    const { event: e2 } = await alert('BULLISH_FLIP', { lighter: null });
    expect((await entryDecision(e2.id, blockOf.bLighter!))!).toMatchObject({ status: 'SKIPPED', reason: 'FEED_STALE' });
    await alert('CLOSE_LONG', { lighter: '3860' });
  });

  it('EMA 200 uses consecutive closed Lighter candles only; a missing or foreign candle blocks the filtered entry', async () => {
    const ema = await publishVersion({ instrumentIds: [BTC, mexcXau, lighterXau], emaFilter: 'EMA200' });
    const blk = (await call(blockById.GET, { cookie: cookies.b, params: { id: blockOf.bLighter! } })).body;
    expect((await call(blockById.PATCH, { method: 'PATCH', path: '/x', cookie: cookies.b, params: { id: blockOf.bLighter! }, body: { strategyVersionId: ema }, ifMatch: blk.revision })).status).toBe(200);
    // No Lighter candles: EMA unavailable.
    const { event } = await alert('BULLISH_FLIP', { lighter: '3860' });
    expect((await entryDecision(event.id, blockOf.bLighter!))!).toMatchObject({ status: 'SKIPPED', reason: 'EMA_UNAVAILABLE' });
    await alert('CLOSE_LONG', { lighter: '3860' });
    // 260 closed, rising Lighter candles through the next signal bar: the long passes.
    const nextBar = new Date(bar.getTime() + M15);
    const cs = fixtureCandles({ endBarOpen: nextBar, intervalMs: M15, count: 260, endClose: '3860', trend: 'UP', step: '0.5', tick: '0.01' });
    await direct.db.insert(schema.marketCandles).values(cs.map((c) => ({ instrumentId: lighterXau, interval: '15', openTime: c.openTime, open: c.open, high: c.high, low: c.low, close: c.close, closed: true, source: 'LIGHTER_PUBLIC' })));
    const ok = await alert('BULLISH_FLIP', { lighter: '3860' });
    expect((await entryDecision(ok.event.id, blockOf.bLighter!))!).toMatchObject({ status: 'ENTRY_APPROVED' });
    await alert('CLOSE_LONG', { lighter: '3860' });
    // The signal bar's candle replaced by a MEXC candle: treated as missing → blocked.
    const nb = new Date(bar.getTime() + M15);
    const cs2 = fixtureCandles({ endBarOpen: nb, intervalMs: M15, count: 4, endClose: '3861', trend: 'UP', step: '0.5', tick: '0.01' });
    await direct.db.insert(schema.marketCandles).values(cs2.map((c) => ({ instrumentId: lighterXau, interval: '15', openTime: c.openTime, open: c.open, high: c.high, low: c.low, close: c.close, closed: true, source: c.openTime.getTime() === nb.getTime() ? 'MEXC_PUBLIC' : 'LIGHTER_PUBLIC' }))).onConflictDoNothing();
    const blocked = await alert('BULLISH_FLIP', { lighter: '3861' });
    expect((await entryDecision(blocked.event.id, blockOf.bLighter!))!).toMatchObject({ status: 'SKIPPED', reason: 'EMA_UNAVAILABLE' });
  });

  it('sizing: Lighter order-value limits (min 10 USDC; max from the catalog), never the stored max_qty default', async () => {
    const pv = await call(preview.POST, { method: 'POST', path: '/x', cookie: cookies.a, body: { ...blockBody({ instrumentId: lighterXau, strategyVersionId: version, leverage: 1, orderCostUsdt: '5', weekdays: ALL_DAYS }), mode: 'PAPER' } });
    expect(pv.status, JSON.stringify(pv.body)).toBe(200);
    expect(JSON.stringify(pv.body.sides)).toMatch(/below the exchange minimum of 10 USDC/);
    expect(pv.body.notes.join(' ')).toMatch(/Lighter Standard account 0%/);
    await direct.db.update(schema.instruments).set({ maxNotional: '100' }).where(eq(schema.instruments.id, lighterXau));
    const big = await call(preview.POST, { method: 'POST', path: '/x', cookie: cookies.a, body: { ...blockBody({ instrumentId: lighterXau, strategyVersionId: version, leverage: 10, orderCostUsdt: '100', weekdays: ALL_DAYS }), mode: 'PAPER' } });
    expect(JSON.stringify(big.body.sides)).toMatch(/exceeds the exchange maximum of 100 USDC per order/);
    // A row without a verified maximum (registered before Step 3) cannot be sized at all.
    await direct.db.update(schema.instruments).set({ maxNotional: null }).where(eq(schema.instruments.id, lighterXau));
    expect((await call(preview.POST, { method: 'POST', path: '/x', cookie: cookies.a, body: { ...blockBody({ instrumentId: lighterXau, strategyVersionId: version, leverage: 10, weekdays: ALL_DAYS }), mode: 'PAPER' } })).status).toBe(422);
    await direct.db.update(schema.instruments).set({ maxNotional: '5000000' }).where(eq(schema.instruments.id, lighterXau));
  });
});

describe('Lighter Live stays unreachable', () => {
  it('a Lighter Live block cannot be activated, Live evaluation refuses it, and no Live order exists', async () => {
    const c = await call(blocks.POST, { method: 'POST', path: '/x', cookie: cookies.b, body: blockBody({ instrumentId: lighterXau, strategyVersionId: version, mode: 'LIVE', weekdays: ALL_DAYS }) });
    expect(c.status).toBe(201);
    const r = await call(resume.POST, { method: 'POST', path: '/x', cookie: cookies.b, params: { id: c.body.id }, ifMatch: c.body.revision });
    expect(r.status).toBe(422);
    expect(r.body.message).toMatch(/Lighter Live trading is not enabled for this account.*LIGHTER_MAINNET_ORDERS is not enabled/);
    const [block] = await direct.db.select().from(schema.orderBlocks).where(eq(schema.orderBlocks.id, c.body.id));
    const [ver] = await direct.db.select().from(schema.strategyVersions).where(eq(schema.strategyVersions.id, version));
    const assessed = await direct.db.transaction(async (tx) => assessEntry(tx, { event: { interval: '15', barOpenAt: bar, referencePrice: '3860' }, block: block!, version: ver!, side: 'LONG', now: clock.now, account: await lockPaperAccount(tx, idB, 'PAPER', 'LIGHTER') }));
    expect(assessed.result).toMatchObject({ ok: false, reason: 'EXCHANGE_NOT_ENABLED' });
    expect(assessed.live).toBeNull();
    await expect(direct.db.transaction((tx) => lockPaperAccount(tx, idB, 'LIVE', 'LIGHTER'))).rejects.toThrow(/Lighter Live trading is not available/);
    expect(await direct.db.select().from(schema.orderIntents).where(eq(schema.orderIntents.mode, 'LIVE'))).toHaveLength(0);
    expect(await direct.db.select().from(schema.paperAccounts).where(and(eq(schema.paperAccounts.mode, 'LIVE'), eq(schema.paperAccounts.exchange, 'LIGHTER')))).toHaveLength(0);
  });

  it('Step 4A: every Lighter Paper flow in this file ran without ever loading the Lighter signer', () => {
    expect(lighterSignerLoads()).toBe(0);
  });
});
