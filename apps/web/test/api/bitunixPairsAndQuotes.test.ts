// Bitunix wiring audit (2026-11-17): the admin import → publish → strategy mapping → investor pair
// list path, Paper refusing Bitunix contracts (Paper simulates MEXC only), and MEXC / Bitunix prices
// for the same coin staying separate in the quote API, previews and the execution quote lookup.
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { latestQuote, listLatestQuotes, schema } from '@trendpilot/db';
import * as blocks from '@/app/v1/me/order-blocks/route';
import * as preview from '@/app/v1/me/order-blocks/preview/route';
import * as modeChange from '@/app/v1/me/order-blocks/[id]/mode-change/route';
import * as bitunixInstrument from '@/app/v1/admin/instruments/bitunix/route';
import * as instrumentPatch from '@/app/v1/admin/instruments/[id]/route';
import * as instrumentsApi from '@/app/v1/instruments/route';
import * as quotesApi from '@/app/v1/market/quotes/route';
import { setTestClock } from '@/server/clock';
import { BTC, blockBody, call, direct, teardown } from '../helpers';
import { ALL_DAYS, clock, cookies, openFromAlert, publishVersion, tick as mexcTick } from '../paperReplay';

let bx: string;
let xau: string;
let version: string;

beforeAll(async () => {
  await openFromAlert({ a: null, b: null });
}, 120_000);

afterAll(async () => {
  setTestClock(null);
  await teardown();
});

describe('admin import → publish → strategy → investor pair list', () => {
  it('imports BTCUSDT and XAUUSDT from Bitunix contract metadata as separate, Disabled instruments', async () => {
    for (const symbol of ['BTCUSDT', 'XAUUSDT']) {
      const r = await call(bitunixInstrument.POST, { method: 'POST', path: '/x', cookie: cookies.admin, body: { symbol } });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(r.body.instrument).toMatchObject({ exchange: 'BITUNIX', symbol, exchangeSymbol: symbol, status: 'DISABLED', liveAllowed: false });
      expect(Number(r.body.instrument.contractMultiplier)).toBe(1);
      if (symbol === 'BTCUSDT') bx = r.body.instrument.id;
      else xau = r.body.instrument.id;
    }
    // Bitunix trading rules (captured trading_pairs): base-coin steps and the price tick.
    const [b] = await direct.db.select().from(schema.instruments).where(eq(schema.instruments.id, bx));
    const nums = (r: typeof b) => ({ qtyStep: Number(r!.qtyStep), minQty: Number(r!.minQty), maxQty: Number(r!.maxQty), priceTick: Number(r!.priceTick) });
    expect(nums(b)).toEqual({ qtyStep: 0.0001, minQty: 0.0001, maxQty: 120, priceTick: 0.1 });
    const [x] = await direct.db.select().from(schema.instruments).where(eq(schema.instruments.id, xau));
    expect(nums(x)).toEqual({ qtyStep: 0.001, minQty: 0.002, maxQty: 200, priceTick: 0.01 });
    // The MEXC BTCUSDT instrument is untouched and remains a different row.
    expect(bx).not.toBe(BTC);
  });

  it('an unsupported Bitunix symbol is refused with the exchange reason', async () => {
    const r = await call(bitunixInstrument.POST, { method: 'POST', path: '/x', cookie: cookies.admin, body: { symbol: 'NOPEUSDT' } });
    expect(r.status).toBeGreaterThanOrEqual(400);
  });

  it('published Bitunix pairs reach the investor catalogue with exchange and execution symbol', async () => {
    for (const id of [bx, xau]) {
      const inst = (await direct.db.select().from(schema.instruments).where(eq(schema.instruments.id, id)))[0]!;
      const r = await call(instrumentPatch.PATCH, { method: 'PATCH', path: '/x', cookie: cookies.admin, params: { id }, body: { status: 'PUBLISHED' }, ifMatch: inst.revision });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
    }
    version = await publishVersion({ instrumentIds: [BTC, bx, xau] });
    const items = (await call(instrumentsApi.GET, { cookie: cookies.a })).body.items as { id: string; exchange: string; exchangeSymbol: string }[];
    expect(items.find((i) => i.id === bx)).toMatchObject({ exchange: 'BITUNIX', exchangeSymbol: 'BTCUSDT' });
    expect(items.find((i) => i.id === xau)).toMatchObject({ exchange: 'BITUNIX', exchangeSymbol: 'XAUUSDT' });
    expect(items.find((i) => i.id === BTC)).toMatchObject({ exchange: 'MEXC' });
  });
});

describe('Paper is MEXC only', () => {
  it('a Paper block on a Bitunix pair is refused with the reason on the pair field', async () => {
    const r = await call(blocks.POST, { method: 'POST', path: '/x', cookie: cookies.a, body: blockBody({ instrumentId: bx, strategyVersionId: version, mode: 'PAPER', orderCostUsdt: '50', leverage: 5, weekdays: ALL_DAYS }) });
    expect(r.status).toBe(400);
    expect(r.body.issues).toContainEqual(expect.objectContaining({ path: 'instrumentId' }));
    expect(JSON.stringify(r.body)).toMatch(/Paper trading simulates MEXC and Lighter contracts only/);
    expect(await direct.db.select().from(schema.orderBlocks).where(eq(schema.orderBlocks.instrumentId, bx))).toHaveLength(0);
  });

  it('a Live block on a Bitunix pair cannot be moved to Paper', async () => {
    // Live creation needs a verified Bitunix connection; copy a saved block as an existing record would be.
    const created = await call(blocks.POST, { method: 'POST', path: '/x', cookie: cookies.a, body: blockBody({ instrumentId: BTC, strategyVersionId: version, mode: 'PAPER', orderCostUsdt: '50', leverage: 5, weekdays: ALL_DAYS }) });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const [base] = await direct.db.select().from(schema.orderBlocks).where(eq(schema.orderBlocks.id, created.body.id));
    const { id: _id, createdAt: _c, updatedAt: _u, ...rest } = base!;
    const [legacy] = await direct.db.insert(schema.orderBlocks).values({ ...rest, instrumentId: bx, mode: 'LIVE', status: 'PAUSED' }).returning();
    const s = await call(modeChange.GET, { path: '/x?to=PAPER', cookie: cookies.a, params: { id: legacy!.id } });
    expect(s.status, JSON.stringify(s.body)).toBe(200);
    expect(s.body).toMatchObject({ allowed: false, blocker: { code: 'PAPER_UNSUPPORTED' } });
  });
});

describe('MEXC and Bitunix prices stay separate', () => {
  it('the quote API names the exchange; a Bitunix pair without a Bitunix price shows none (never the MEXC one)', async () => {
    await mexcTick('64000', { at: clock.now });
    // A MEXC public-feed quote on the MEXC instrument only (the replay helper writes fixture rows).
    await direct.db.insert(schema.marketQuotes).values({ instrumentId: BTC, asOf: new Date(clock.now.getTime() + 1), bid: '64000', ask: '64001', mark: '64000.5', last: '64000.5', source: 'MEXC_PUBLIC', channel: 'WS' });
    const items = (await call(quotesApi.GET, { cookie: cookies.a })).body.items as { instrumentId: string; exchange: string; quote: { source: string } | null }[];
    expect(items.find((i) => i.instrumentId === BTC)).toMatchObject({ exchange: 'MEXC', quote: { source: 'MEXC_PUBLIC' } });
    expect(items.find((i) => i.instrumentId === bx)).toMatchObject({ exchange: 'BITUNIX', quote: null });
  });

  it('a MEXC price stored on the Bitunix instrument by mistake is ignored for display and execution', async () => {
    await direct.db.insert(schema.marketQuotes).values({ instrumentId: bx, asOf: clock.now, bid: '64000', ask: '64001', mark: '64000.5', last: '64000.5', source: 'MEXC_PUBLIC', channel: 'WS' });
    expect(await latestQuote(direct.db, bx, clock.now)).toBeNull();
    const shown = (await listLatestQuotes(direct.db, clock.now, { publishedOnly: true })).find((i) => i.instrumentId === bx);
    expect(shown).toMatchObject({ exchange: 'BITUNIX', quote: null });
    // The MEXC instrument still reads its own MEXC price.
    expect(await latestQuote(direct.db, BTC, clock.now)).toMatchObject({ source: 'MEXC_PUBLIC' });
    await direct.db.delete(schema.marketQuotes).where(and(eq(schema.marketQuotes.instrumentId, bx), eq(schema.marketQuotes.source, 'MEXC_PUBLIC')));
  });

  it('the order preview of a real Bitunix pair never falls back to fixture or MEXC prices', async () => {
    await direct.db.update(schema.instruments).set({ isFixture: false }).where(eq(schema.instruments.id, bx));
    const r = await call(preview.POST, { method: 'POST', path: '/x', cookie: cookies.a, body: { ...blockBody({ instrumentId: bx, strategyVersionId: version, orderCostUsdt: '50', leverage: 5, weekdays: ALL_DAYS }), mode: 'LIVE' } });
    expect(r.status).toBe(422);
    expect(r.body.message ?? JSON.stringify(r.body)).toMatch(/No fresh public Bitunix price/);
  });
});
