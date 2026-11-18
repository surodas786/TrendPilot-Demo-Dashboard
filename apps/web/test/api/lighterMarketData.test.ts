// Lighter Step 2 through the database and the normal APIs: Lighter public prices (fake stream frames
// in the documented shape) → exchange-keyed cache → LIGHTER_PUBLIC quotes on the Lighter instrument
// (the same recordMarketTick + NOTIFY path the live UI listens to) → quote API, Trade Settings
// preview and Holdings; the same underlying on MEXC, Bitunix and Lighter never mixing; staleness;
// Lighter REST candles (closed only, aligned, backfilled) on the Lighter instrument and the Holdings
// chart. The Holdings chart uses an ISOLATED FIXTURE position row cloned in the test database (no
// Lighter account or trade exists; nothing is executed). Nothing here calls Lighter.
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addLighterInstrument, ExchangePriceCache, getMyHoldingChart, latestQuote, LIGHTER_MAINNET, LighterKlineSource, LighterQuoteWriter, listFeedHealth, listLatestQuotes, MarketFeed, schema } from '@trendpilot/db';
import * as quotesApi from '@/app/v1/market/quotes/route';
import * as preview from '@/app/v1/me/order-blocks/preview/route';
import * as chartApi from '@/app/v1/me/holdings/[id]/chart/route';
import * as instrumentPatch from '@/app/v1/admin/instruments/[id]/route';
import * as bitunixInstrument from '@/app/v1/admin/instruments/bitunix/route';
import { setTestClock } from '@/server/clock';
import { BTC, blockBody, call, direct, teardown, userId, USERS } from '../helpers';
import { ALL_DAYS, clock, cookies, openFromAlert, publishVersion } from '../paperReplay';

let xau: string;
let bxXau: string;
let version: string;
const instRow = async (id: string) => (await direct.db.select().from(schema.instruments).where(eq(schema.instruments.id, id)))[0]!;
const publish = async (id: string) => call(instrumentPatch.PATCH, { method: 'PATCH', path: '/x', cookie: cookies.admin, params: { id }, body: { status: 'PUBLISHED' }, ifMatch: (await instRow(id)).revision });

/** A Lighter ticker + market_stats pair (documented fields) received at `at`. */
function lighterFrames(w: LighterQuoteWriter, at: Date, o: { bid: string; ask: string; mark: string; last: string; index?: string }) {
  w.onStats({ marketId: '92', mark: o.mark, index: o.index ?? o.mark, last: o.last, exchangeTimeMs: at.getTime(), receivedAt: at, snapshot: false });
  w.onTicker({ marketId: '92', bid: o.bid, ask: o.ask, exchangeTimeMs: at.getTime(), nonce: at.getTime(), receivedAt: at, snapshot: false });
}

beforeAll(async () => {
  await openFromAlert({ b: null }); // Investor A holds a MEXC paper BTCUSDT position (cloned below as a fixture)
  const admin = await userId(USERS.admin.email);
  xau = (await addLighterInstrument(direct.db, admin, 'XAU')).instrument.id;
  expect((await instRow(xau)).exchangeMarketId).toBe(92);
  expect((await publish(xau)).status).toBe(200);
  bxXau = (await call(bitunixInstrument.POST, { method: 'POST', path: '/x', cookie: cookies.admin, body: { symbol: 'XAUUSDT' } })).body.instrument.id;
  expect((await publish(bxXau)).status).toBe(200);
  version = await publishVersion({ instrumentIds: [BTC, xau, bxXau] });
}, 120_000);

afterAll(async () => {
  setTestClock(null);
  await teardown();
});

describe('Lighter public prices → stored quote → quote API', () => {
  it('the writer covers published Lighter instruments by market ID and stores only a FRESH joined quote', async () => {
    const cache = new ExchangePriceCache();
    const w = new LighterQuoteWriter(direct.db, cache, { minIntervalMs: 0 });
    expect(await w.refresh()).toEqual(['92']);
    const at = clock.now;
    // A ticker before any market_stats is held back: no `last`, nothing synthesized.
    w.onTicker({ marketId: '92', bid: '3862.04', ask: '3862.05', exchangeTimeMs: at.getTime(), nonce: 1, receivedAt: at, snapshot: true });
    expect(await w.onUpdate('92', at)).toBe('SKIPPED');
    lighterFrames(w, at, { bid: '3862.04', ask: '3862.05', mark: '3862.13', last: '3861.97', index: '3859.36' });
    expect(w.quote('92', at)).toMatchObject({ state: 'FRESH', index: '3859.36' });
    expect(await w.onUpdate('92', at)).toBe('WRITTEN');
    const q = await latestQuote(direct.db, xau, at);
    expect(q).toMatchObject({ source: 'LIGHTER_PUBLIC', bid: expect.stringMatching(/^3862\.04/), ask: expect.stringMatching(/^3862\.05/), mark: expect.stringMatching(/^3862\.13/) });
    // The NOTIFY payload the live UI receives carries the same row (recordMarketTick); the API shows it.
    const items = (await call(quotesApi.GET, { cookie: cookies.a })).body.items as Record<string, any>[];
    expect(items.find((i) => i.instrumentId === xau)).toMatchObject({ exchange: 'LIGHTER', marketId: 92, quoteCurrency: 'USDC', exchangeSymbol: 'XAU', quote: { source: 'LIGHTER_PUBLIC', channel: 'WS', sourceLabel: 'Lighter public market data · WebSocket', bid: '3862.04', ask: '3862.05', mark: '3862.13', last: '3861.97' } });
  });

  it('a stale or crossed Lighter quote is not stored; the last stored one stays visible with its age', async () => {
    const cache = new ExchangePriceCache();
    const w = new LighterQuoteWriter(direct.db, cache, { minIntervalMs: 0 });
    await w.refresh();
    const old = new Date(clock.now.getTime() + 1_000);
    lighterFrames(w, old, { bid: '3870', ask: '3870.1', mark: '3870', last: '3870' });
    const later = new Date(old.getTime() + 20_000);
    expect(w.quote('92', later).state).toBe('STALE');
    expect(await w.onUpdate('92', later)).toBe('SKIPPED');
    lighterFrames(w, later, { bid: '3871', ask: '3870', mark: '3870.5', last: '3870.5' });
    expect(w.quote('92', later).state).toBe('INVALID');
    expect(await w.onUpdate('92', later)).toBe('SKIPPED');
    const shown = (await listLatestQuotes(direct.db, later, { publishedOnly: true })).find((i) => i.instrumentId === xau)!;
    expect(shown.quote).toMatchObject({ source: 'LIGHTER_PUBLIC', bid: '3862.04' });
    expect(later.getTime() - Date.parse(shown.quote!.asOf)).toBeGreaterThan(15_000); // the UI marks it stale by age
  });
});

describe('the same underlying on MEXC, Bitunix and Lighter never mixes', () => {
  it('each XAU row shows only its own exchange price; with no Lighter price, Lighter shows none', async () => {
    const at = new Date(clock.now.getTime() + 60_000);
    await direct.db.delete(schema.marketQuotes).where(eq(schema.marketQuotes.instrumentId, xau));
    await direct.db.insert(schema.marketQuotes).values([
      { instrumentId: bxXau, asOf: at, bid: '3800', ask: '3800.1', mark: '3800', last: '3800', source: 'BITUNIX_PUBLIC', channel: 'WS' },
      // Wrong-exchange rows written onto the Lighter instrument by mistake: never shown or used.
      { instrumentId: xau, asOf: at, bid: '3700', ask: '3700.1', mark: '3700', last: '3700', source: 'MEXC_PUBLIC', channel: 'WS' },
      { instrumentId: xau, asOf: new Date(at.getTime() - 1000), bid: '3800', ask: '3800.1', mark: '3800', last: '3800', source: 'BITUNIX_PUBLIC', channel: 'WS' }
    ]);
    const items = await listLatestQuotes(direct.db, at, { publishedOnly: true });
    expect(items.find((i) => i.instrumentId === xau)).toMatchObject({ exchange: 'LIGHTER', quote: null });
    expect(items.find((i) => i.instrumentId === bxXau)).toMatchObject({ exchange: 'BITUNIX', quoteCurrency: 'USDT', quote: { source: 'BITUNIX_PUBLIC', mark: '3800' } });
    expect(await latestQuote(direct.db, xau, at)).toBeNull();
    // The Trade Settings preview of the Lighter pair says so instead of using any other price.
    const pv = await call(preview.POST, { method: 'POST', path: '/x', cookie: cookies.a, body: { ...blockBody({ instrumentId: xau, strategyVersionId: version, leverage: 10, weekdays: ALL_DAYS }), mode: 'LIVE' } });
    expect(pv.status).toBe(422);
    expect(pv.body.message).toMatch(/No fresh Lighter price is available for XAU.*Nothing from another exchange/);
    await direct.db.delete(schema.marketQuotes).where(and(eq(schema.marketQuotes.instrumentId, xau)));
  });

  it('with a fresh Lighter price the preview shows that price only (no order estimates for Lighter yet)', async () => {
    const at = new Date();
    setTestClock(() => at);
    const w = new LighterQuoteWriter(direct.db, new ExchangePriceCache(), { minIntervalMs: 0 });
    await w.refresh();
    lighterFrames(w, at, { bid: '3862.04', ask: '3862.05', mark: '3862.13', last: '3861.97' });
    expect(await w.onUpdate('92', at)).toBe('WRITTEN');
    const pv = await call(preview.POST, { method: 'POST', path: '/x', cookie: cookies.a, body: { ...blockBody({ instrumentId: xau, strategyVersionId: version, leverage: 10, weekdays: ALL_DAYS }), mode: 'LIVE' } });
    expect(pv.status, JSON.stringify(pv.body)).toBe(200);
    expect(pv.body).toMatchObject({ quote: { source: 'LIGHTER_PUBLIC' }, sides: [], instrument: { exchange: 'LIGHTER', quoteCurrency: 'USDC', exchangeSymbol: 'XAU' } });
    expect([Number(pv.body.quote.bid), Number(pv.body.quote.ask)]).toEqual([3862.04, 3862.05]);
    expect(pv.body.notes.join(' ')).toMatch(/Lighter public price only/);
    setTestClock(() => clock.now);
  });
});

describe('Lighter candles → Holdings chart', () => {
  const FIVE = 300_000;
  const FIFTEEN = 900_000;
  /** Fake Lighter mainnet REST: candles for market 92 up to and INCLUDING the forming bar. */
  const fakeLighter = (nowMs: () => number, missing = new Set<number>()) =>
    (async (u: string | URL | Request) => {
      const url = new URL(String(u));
      if (url.pathname === '/') return new Response(JSON.stringify({ status: 200, network_id: 1 }));
      if (url.pathname === '/info') return new Response(JSON.stringify({ contract_address: LIGHTER_MAINNET.contractAddress }));
      expect(url.searchParams.get('market_id')).toBe('92');
      const step = url.searchParams.get('resolution') === '15m' ? FIFTEEN : FIVE;
      const s = Number(url.searchParams.get('start_timestamp'));
      const e = Number(url.searchParams.get('end_timestamp'));
      const forming = Math.floor(nowMs() / step) * step;
      const c = [];
      for (let t = Math.ceil(s / step) * step; t <= Math.min(e + step, forming); t += step) if (!missing.has(t)) c.push({ t, o: 3860, h: t === forming ? 4000 : 3863, l: 3858, c: t === forming ? 3999 : 3861.5, v: 1, V: 3861, i: t });
      return new Response(JSON.stringify({ code: 200, r: step === FIVE ? '5m' : '15m', c }));
    }) as typeof fetch;

  it('stores closed, aligned 5m and 15m candles as LIGHTER_PUBLIC on the Lighter instrument; the forming bar never', async () => {
    const nowMs = clock.now.getTime() + 120_000;
    const feed = new MarketFeed(direct.db, { exchange: 'LIGHTER', source: new LighterKlineSource({ fetch: fakeLighter(() => nowMs), now: () => nowMs }), now: () => new Date(nowMs), backfillBars: 60 });
    const r = await feed.candleCycle();
    expect(r.filter((x) => x.error), JSON.stringify(r)).toEqual([]);
    const rows = await direct.db.select().from(schema.marketCandles).where(eq(schema.marketCandles.instrumentId, xau));
    expect(rows.length).toBeGreaterThan(60);
    expect(new Set(rows.map((x) => x.source))).toEqual(new Set(['LIGHTER_PUBLIC']));
    for (const x of rows) {
      const step = x.interval === '5' ? FIVE : FIFTEEN;
      expect(x.openTime.getTime() % step).toBe(0);
      expect(x.openTime.getTime() + step).toBeLessThanOrEqual(nowMs); // closed bars only
      expect(x.closed).toBe(true);
      expect(Number(x.close)).not.toBe(3999); // the forming bar's price
    }
    // MEXC and Bitunix instruments were not touched by the Lighter candle feed.
    const others = await direct.db.select().from(schema.marketCandles).where(eq(schema.marketCandles.source, 'LIGHTER_PUBLIC'));
    expect(new Set(others.map((x) => x.instrumentId))).toEqual(new Set([xau]));
  });

  it('backfills a missing bar on a later cycle', async () => {
    const nowMs = clock.now.getTime() + 120_000;
    const iv = (await direct.db.select().from(schema.marketCandles).where(and(eq(schema.marketCandles.instrumentId, xau), eq(schema.marketCandles.interval, '5')))).map((x) => x.openTime.getTime()).sort((a, b) => a - b);
    const hole = iv[Math.floor(iv.length / 2)]!;
    await direct.db.delete(schema.marketCandles).where(and(eq(schema.marketCandles.instrumentId, xau), eq(schema.marketCandles.interval, '5'), eq(schema.marketCandles.openTime, new Date(hole))));
    const later = nowMs + FIVE;
    const feed = new MarketFeed(direct.db, { exchange: 'LIGHTER', source: new LighterKlineSource({ fetch: fakeLighter(() => later), now: () => later }), now: () => new Date(later), backfillBars: 60 });
    await feed.candleCycle();
    const back = await direct.db.select().from(schema.marketCandles).where(and(eq(schema.marketCandles.instrumentId, xau), eq(schema.marketCandles.interval, '5'), eq(schema.marketCandles.openTime, new Date(hole))));
    expect(back).toHaveLength(1);
  });

  it('the Holdings chart of a Lighter position (isolated fixture) uses Lighter candles only, with its entry and stop lines', async () => {
    const owner = await userId(USERS.investorA.email);
    const [mexcPos] = await direct.db.select().from(schema.positions).where(eq(schema.positions.ownerId, owner));
    expect(mexcPos).toBeTruthy();
    // FIXTURE: A's test position row re-pointed at the Lighter instrument, in the test DB only.
    const [fixture] = await direct.db.update(schema.positions).set({ instrumentId: xau, avgEntryPrice: '3861', stopPrice: '3800' }).where(eq(schema.positions.id, mexcPos!.id)).returning();
    // A MEXC candle written onto the Lighter instrument by mistake is never drawn.
    const anyLighter = (await direct.db.select().from(schema.marketCandles).where(and(eq(schema.marketCandles.instrumentId, xau), eq(schema.marketCandles.interval, '15'))))[0]!;
    await direct.db.update(schema.marketCandles).set({ source: 'MEXC_PUBLIC', close: '1' }).where(and(eq(schema.marketCandles.instrumentId, xau), eq(schema.marketCandles.interval, anyLighter.interval), eq(schema.marketCandles.openTime, anyLighter.openTime)));
    const chart = await getMyHoldingChart(direct.db, owner, fixture!.id, { now: new Date(clock.now.getTime() + 120_000) });
    expect(chart).toMatchObject({ exchange: 'LIGHTER', exchangeSymbol: 'XAU', source: 'LIGHTER_PUBLIC' });
    expect(chart!.candles.length).toBeGreaterThan(0);
    expect(chart!.candles.some((c) => c.close === '1')).toBe(false);
    expect(chart!.lines.map((l) => [l.kind, l.price])).toEqual(expect.arrayContaining([['ENTRY', '3861'], ['STOP', '3800']]));
    // Same through the owner-scoped API; another investor gets 404.
    expect((await call(chartApi.GET, { cookie: cookies.a, params: { id: fixture!.id } })).body).toMatchObject({ exchange: 'LIGHTER', source: 'LIGHTER_PUBLIC' });
    expect((await call(chartApi.GET, { cookie: cookies.b, params: { id: fixture!.id } })).status).toBe(404);
  });

  it('stale-price diagnostics judge the Lighter feed from its own stored quotes (fresh → HEALTHY, old → STALE)', async () => {
    await direct.db.delete(schema.marketQuotes).where(eq(schema.marketQuotes.instrumentId, xau));
    const at = new Date(clock.now.getTime() + 600_000);
    await direct.db.insert(schema.marketQuotes).values({ instrumentId: xau, asOf: at, bid: '3862', ask: '3862.1', mark: '3862', last: '3862', source: 'LIGHTER_PUBLIC', channel: 'WS' });
    const row = async (now: Date) => (await listFeedHealth(direct.db, now)).find((x) => x.instrumentId === xau)!;
    expect((await row(new Date(at.getTime() + 2_000))).feed).toMatchObject({ source: 'LIGHTER_PUBLIC', state: 'HEALTHY', reporting: true });
    expect((await row(new Date(at.getTime() + 30_000))).feed).toMatchObject({ state: 'STALE', reporting: false });
    // A wrong-source row never makes the Lighter feed look healthy.
    await direct.db.insert(schema.marketQuotes).values({ instrumentId: xau, asOf: new Date(at.getTime() + 29_000), bid: '1', ask: '1.1', mark: '1', last: '1', source: 'MEXC_PUBLIC', channel: 'WS' });
    expect((await row(new Date(at.getTime() + 30_000))).feed).toMatchObject({ state: 'STARTING', reporting: false });
  });
});
