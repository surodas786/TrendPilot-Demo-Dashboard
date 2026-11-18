// Lighter Step 1 (venue and market registration), through the normal APIs: catalog validation →
// admin publication → strategy mapping → investor pair selection, plus the negative cases (unknown,
// spot, inactive, wrong environment, catalog unavailable, unpublished, wrong strategy, Paper, Live
// activation, connections, Live allowlist, signal routes, foreign prices). Uses the captured
// mainnet catalog fixture (PAIR_VALIDATION_SOURCE is not "mexc" in tests); nothing calls Lighter.
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { addLighterInstrument, latestQuote, lighterFixtureCatalog, LighterPublicError, LIGHTER_MAINNET, routeStrategyIssues, schema } from '@trendpilot/db';
import * as blocks from '@/app/v1/me/order-blocks/route';
import * as blockById from '@/app/v1/me/order-blocks/[id]/route';
import * as resume from '@/app/v1/me/order-blocks/[id]/resume/route';
import * as modeChange from '@/app/v1/me/order-blocks/[id]/mode-change/route';
import * as preview from '@/app/v1/me/order-blocks/preview/route';
import * as lighterInstrument from '@/app/v1/admin/instruments/lighter/route';
import * as bitunixInstrument from '@/app/v1/admin/instruments/bitunix/route';
import * as instrumentPatch from '@/app/v1/admin/instruments/[id]/route';
import * as instrumentsApi from '@/app/v1/instruments/route';
import * as conn from '@/app/v1/me/exchange-connection/route';
import * as contracts from '@/app/v1/admin/live/contracts/[id]/route';
import { setTestClock } from '@/server/clock';
import { BTC, VERSION, blockBody, call, direct, teardown, userId, USERS } from '../helpers';
import { ALL_DAYS, cookies, openFromAlert, publishVersion } from '../paperReplay';

let xau: string;
let lighterVersion: string;
let mexcBlock: string;
const envBackup = { ...process.env };

const instRow = async (id: string) => (await direct.db.select().from(schema.instruments).where(eq(schema.instruments.id, id)))[0]!;
const lighterRows = () => direct.db.select().from(schema.instruments).where(eq(schema.instruments.exchange, 'LIGHTER'));
const importLighter = (market: unknown) => call(lighterInstrument.POST, { method: 'POST', path: '/x', cookie: cookies.admin, body: { market } });

beforeAll(async () => {
  await openFromAlert({ a: null, b: null });
  // A MEXC Paper block that existed before Lighter: it must keep loading and editing normally.
  const created = await call(blocks.POST, { method: 'POST', path: '/x', cookie: cookies.a, body: blockBody({ instrumentId: BTC, mode: 'PAPER', weekdays: ALL_DAYS }) });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  mexcBlock = created.body.id;
}, 120_000);

afterEach(() => {
  process.env = { ...envBackup };
});

afterAll(async () => {
  setTestClock(null);
  await teardown();
});

describe('catalog validation → admin publication', () => {
  it('registers XAU from the catalog: market ID 92, USDC perpetual, base-unit rules, Disabled and not Live-allowed', async () => {
    const r = await importLighter('XAU');
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ source: 'FIXTURE', market: { marketId: 92, symbol: 'XAU', marketType: 'perp', status: 'active', settlementCurrency: 'USDC', environment: 'MAINNET', maxLeverage: 25 } });
    expect(r.body.instrument).toMatchObject({ exchange: 'LIGHTER', symbol: 'XAU', exchangeSymbol: 'XAU', marketId: 92, base: 'XAU', quote: 'USDC', status: 'DISABLED', liveAllowed: false, isFixture: true });
    xau = r.body.instrument.id;
    const row = await instRow(xau);
    expect({ step: Number(row.qtyStep), min: Number(row.minQty), notional: Number(row.minNotional), tick: Number(row.priceTick), fee: Number(row.takerFeeRate), mult: Number(row.contractMultiplier) }).toEqual({ step: 0.0001, min: 0.0015, notional: 10, tick: 0.01, fee: 0, mult: 1 });
    expect(row.leverageChoices).toContain(25);
    expect(Math.max(...row.leverageChoices)).toBe(25);
  });

  it('the market ID finds the same row; a refresh keeps status, suggestions and the market ID', async () => {
    const before = await instRow(xau);
    const r = await importLighter(92);
    expect(r.status).toBe(200);
    expect(r.body.instrument.id).toBe(xau);
    const after = await instRow(xau);
    expect(after).toMatchObject({ status: 'DISABLED', exchangeMarketId: 92, suggestedStopPct: before.suggestedStopPct, revision: before.revision + 1 });
    expect(await lighterRows()).toHaveLength(1);
  });

  it('refuses tickers, spot, inactive and external markets, and bad input; nothing is added', async () => {
    for (const [market, status] of [
      ['XAUUSDT', 404],
      ['XAU/USDC', 404],
      ['XAUT/USDC', 409],
      ['2056', 409],
      ['222', 409],
      ['8286', 409],
      ['', 400],
      [{ id: 92 }, 400]
    ] as const) {
      const r = await importLighter(market);
      expect(r.status, `${JSON.stringify(market)} → ${JSON.stringify(r.body)}`).toBe(status);
    }
    expect((await importLighter('XAUT/USDC')).body.message).toMatch(/spot/);
    expect(await lighterRows()).toHaveLength(1);
  });

  it('catalog unavailable or the wrong environment is an error: no row, no fallback to fixtures or another exchange', async () => {
    // Live catalog mode pointed at a closed local port: a network failure, answered 503.
    process.env.PAIR_VALIDATION_SOURCE = 'mexc';
    process.env.LIGHTER_PUBLIC_BASE_URL = 'http://127.0.0.1:9';
    const down = await importLighter('BTC');
    expect(down.status, JSON.stringify(down.body)).toBe(503);
    expect(down.body.message).toMatch(/Lighter market catalog could not be read/);
    process.env = { ...envBackup };
    const admin = await userId(USERS.admin.email);
    const fixture = lighterFixtureCatalog();
    await expect(addLighterInstrument(direct.db, admin, 'BTC', { catalog: { environment: async () => ({ networkId: 11155111, contractAddress: LIGHTER_MAINNET.contractAddress }), markets: fixture.markets } })).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/not the Ethereum-based mainnet/) });
    await expect(addLighterInstrument(direct.db, admin, 'BTC', { catalog: { environment: fixture.environment, markets: async () => { throw new LighterPublicError('GET /api/v1/orderBookDetails: HTTP 502', 'HTTP', 502); } } })).rejects.toMatchObject({ status: 503 });
    expect((await lighterRows()).map((r) => r.symbol)).toEqual(['XAU']);
  });

  it('a symbol that now points at another market ID is refused, not re-pointed', async () => {
    const admin = await userId(USERS.admin.email);
    const fixture = lighterFixtureCatalog();
    const moved = async () => (await fixture.markets()).map((m) => (m.symbol === 'XAU' ? { ...m, marketId: 4242 } : m));
    await expect(addLighterInstrument(direct.db, admin, 'XAU', { catalog: { environment: fixture.environment, markets: moved } })).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/registered as market 92/) });
    expect((await instRow(xau)).exchangeMarketId).toBe(92);
  });

  it('the database refuses a Lighter instrument without a market ID', async () => {
    const r = direct.db.insert(schema.instruments).values({ exchange: 'LIGHTER', symbol: 'NOID', base: 'NOID', quote: 'USDC', contractMultiplier: '1', qtyStep: '0.01', minQty: '0.01', leverageChoices: [1], suggestedStopPct: '1', suggestedTakeProfitPct: '2', suggestedTrailingPct: '1' });
    await expect(r).rejects.toThrow();
  });

  it('investors do not see the pair until it is published; then it carries exchange, market ID and USDC', async () => {
    const before = (await call(instrumentsApi.GET, { cookie: cookies.a })).body.items as { id: string }[];
    expect(before.some((i) => i.id === xau)).toBe(false);
    const r = await call(instrumentPatch.PATCH, { method: 'PATCH', path: '/x', cookie: cookies.admin, params: { id: xau }, body: { status: 'PUBLISHED' }, ifMatch: (await instRow(xau)).revision });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    lighterVersion = await publishVersion({ instrumentIds: [BTC, xau] });
    const items = (await call(instrumentsApi.GET, { cookie: cookies.a })).body.items as Record<string, unknown>[];
    expect(items.find((i) => i.id === xau)).toMatchObject({ exchange: 'LIGHTER', symbol: 'XAU', exchangeSymbol: 'XAU', marketId: 92, base: 'XAU', quote: 'USDC', status: 'PUBLISHED', contract: { minNotional: '10' } });
    expect(items.find((i) => i.id === BTC)).toMatchObject({ exchange: 'MEXC', marketId: null, quote: 'USDT' });
  });
});

describe('investor pair selection: server-side eligibility', () => {
  it('a Lighter pair can be saved as a Live entry (paused) with the strategy version that approves it', async () => {
    const r = await call(blocks.POST, { method: 'POST', path: '/x', cookie: cookies.a, body: blockBody({ instrumentId: xau, strategyVersionId: lighterVersion, mode: 'LIVE', leverage: 10, weekdays: ALL_DAYS }) });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body).toMatchObject({ instrumentId: xau, exchange: 'LIGHTER', mode: 'LIVE', status: 'PAUSED' });
    // Edit (the normal PATCH path) keeps the pair.
    const e = await call(blockById.PATCH, { method: 'PATCH', path: '/x', cookie: cookies.a, params: { id: r.body.id }, body: { orderCostUsdt: '150' }, ifMatch: r.body.revision });
    expect(e.status, JSON.stringify(e.body)).toBe(200);
    expect(e.body).toMatchObject({ instrumentId: xau, orderCostUsdt: '150' });
  });

  it('as a Live entry it can never be activated; moving it to Paper is allowed (Step 3); no other price is previewed', async () => {
    const [b] = await direct.db.select().from(schema.orderBlocks).where(eq(schema.orderBlocks.instrumentId, xau));
    const rs = await call(resume.POST, { method: 'POST', path: '/x', cookie: cookies.a, params: { id: b!.id }, ifMatch: b!.revision });
    expect(rs.status).toBe(422);
    expect(rs.body.message).toMatch(/Lighter Live trading is not available yet/);
    const mc = await call(modeChange.GET, { path: '/x?to=PAPER', cookie: cookies.a, params: { id: b!.id } });
    expect(mc.body).toMatchObject({ allowed: true });
    const pv = await call(preview.POST, { method: 'POST', path: '/x', cookie: cookies.a, body: { ...blockBody({ instrumentId: xau, strategyVersionId: lighterVersion, leverage: 10, weekdays: ALL_DAYS }), mode: 'LIVE' } });
    expect(pv.status).toBe(422);
    expect(pv.body.message).toMatch(/No fresh Lighter price is available for XAU/);
    // Step 4: a Lighter connection can be set up (connect and verify only); an invalid one is refused
    // with the Lighter input rules, never stored, and never treated as MEXC.
    expect((await call(conn.GET, { path: '/x?exchange=LIGHTER', cookie: cookies.a })).body).toMatchObject({ connection: null, account: null });
    const bad = await call(conn.PUT, { method: 'PUT', path: '/x', cookie: cookies.a, body: { exchange: 'LIGHTER', accountRef: 'lt-a', apiKey: 'k', secretKey: 's' } });
    expect(bad.status).toBe(400);
    expect(bad.body.message).toMatch(/account index/);
    expect(await direct.db.select().from(schema.exchangeConnections).where(eq(schema.exchangeConnections.exchange, 'LIGHTER'))).toHaveLength(0);
  });

  it('accepts a Paper entry (Step 3), refuses an unpublished pair, a strategy that does not approve it, and an unknown pair', async () => {
    const paper = await call(blocks.POST, { method: 'POST', path: '/x', cookie: cookies.b, body: blockBody({ instrumentId: xau, strategyVersionId: lighterVersion, mode: 'PAPER', leverage: 10, weekdays: ALL_DAYS }) });
    expect(paper.status, JSON.stringify(paper.body)).toBe(201);
    expect(paper.body).toMatchObject({ exchange: 'LIGHTER', mode: 'PAPER' });
    const wrongStrategy = await call(blocks.POST, { method: 'POST', path: '/x', cookie: cookies.b, body: blockBody({ instrumentId: xau, strategyVersionId: VERSION, mode: 'LIVE', leverage: 10, weekdays: ALL_DAYS }) });
    expect(wrongStrategy.status).toBe(400);
    expect(JSON.stringify(wrongStrategy.body)).toMatch(/not approved for the selected pair/);
    const badLeverage = await call(blocks.POST, { method: 'POST', path: '/x', cookie: cookies.b, body: blockBody({ instrumentId: xau, strategyVersionId: lighterVersion, mode: 'LIVE', leverage: 50, weekdays: ALL_DAYS }) });
    expect(badLeverage.status).toBe(400);
    const unknown = await call(blocks.POST, { method: 'POST', path: '/x', cookie: cookies.b, body: blockBody({ instrumentId: '00000000-0000-4000-8000-000000000999', strategyVersionId: lighterVersion, mode: 'LIVE', weekdays: ALL_DAYS }) });
    expect(unknown.status).toBe(400);
    // Disabled → not selectable and not listed.
    await call(instrumentPatch.PATCH, { method: 'PATCH', path: '/x', cookie: cookies.admin, params: { id: xau }, body: { status: 'DISABLED' }, ifMatch: (await instRow(xau)).revision });
    const unpublished = await call(blocks.POST, { method: 'POST', path: '/x', cookie: cookies.b, body: blockBody({ instrumentId: xau, strategyVersionId: lighterVersion, mode: 'LIVE', leverage: 10, weekdays: ALL_DAYS }) });
    expect(unpublished.status).toBe(400);
    expect(JSON.stringify(unpublished.body)).toMatch(/This pair is not available/);
    expect(((await call(instrumentsApi.GET, { cookie: cookies.b })).body.items as { id: string }[]).some((i) => i.id === xau)).toBe(false);
    await call(instrumentPatch.PATCH, { method: 'PATCH', path: '/x', cookie: cookies.admin, params: { id: xau }, body: { status: 'PUBLISHED' }, ifMatch: (await instRow(xau)).revision });
  });

  it('the Live allowlist and signal routes refuse a Lighter pair', async () => {
    const allow = await call(contracts.POST, { method: 'POST', path: '/x', cookie: cookies.admin, params: { id: xau }, body: { allowed: true } });
    expect(allow.status).toBe(409);
    expect((await instRow(xau)).liveAllowed).toBe(false);
    const [route] = await direct.db.select().from(schema.signalRoutes).limit(1);
    const issues = await routeStrategyIssues(direct.db, { kind: 'ACTIONABLE', packageId: route!.packageId, instrumentId: xau, interval: route!.interval as '5' | '15' });
    expect(issues.map((i) => i.message).join(' ')).toMatch(/Lighter Live trading is not available yet/);
  });

  it('a MEXC or Bitunix price stored on the Lighter instrument is never used for it', async () => {
    const at = new Date();
    for (const source of ['MEXC_PUBLIC', 'BITUNIX_PUBLIC']) {
      await direct.db.insert(schema.marketQuotes).values({ instrumentId: xau, asOf: new Date(at.getTime() - 1000), bid: '3850', ask: '3851', mark: '3850.5', last: '3850.5', source, channel: 'WS' });
      expect(await latestQuote(direct.db, xau, at)).toBeNull();
      await direct.db.delete(schema.marketQuotes).where(eq(schema.marketQuotes.instrumentId, xau));
    }
  });
});

describe('existing MEXC and Bitunix selection is unchanged', () => {
  it('the MEXC block made before Lighter still loads and edits; MEXC instruments carry no market ID', async () => {
    const list = await call(blocks.GET, { cookie: cookies.a });
    expect(list.status).toBe(200);
    const mexc = (list.body.items as { id: string; exchange: string; revision: number }[]).find((b) => b.id === mexcBlock)!;
    expect(mexc).toMatchObject({ exchange: 'MEXC' });
    const e = await call(blockById.PATCH, { method: 'PATCH', path: '/x', cookie: cookies.a, params: { id: mexcBlock }, body: { orderCostUsdt: '120' }, ifMatch: mexc.revision });
    expect(e.status, JSON.stringify(e.body)).toBe(200);
    expect((await instRow(BTC)).exchangeMarketId).toBeNull();
  });

  it('Bitunix import, publication and Live-only selection still work next to Lighter', async () => {
    const r = await call(bitunixInstrument.POST, { method: 'POST', path: '/x', cookie: cookies.admin, body: { symbol: 'BTCUSDT' } });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const bx = r.body.instrument.id as string;
    expect((await instRow(bx)).exchangeMarketId).toBeNull();
    await call(instrumentPatch.PATCH, { method: 'PATCH', path: '/x', cookie: cookies.admin, params: { id: bx }, body: { status: 'PUBLISHED' }, ifMatch: (await instRow(bx)).revision });
    const v = await publishVersion({ instrumentIds: [BTC, xau, bx] });
    const paper = await call(blocks.POST, { method: 'POST', path: '/x', cookie: cookies.b, body: blockBody({ instrumentId: bx, strategyVersionId: v, mode: 'PAPER', weekdays: ALL_DAYS }) });
    expect(paper.status).toBe(400);
    expect(JSON.stringify(paper.body)).toMatch(/Bitunix pairs are Live only/);
    const live = await call(blocks.POST, { method: 'POST', path: '/x', cookie: cookies.b, body: blockBody({ instrumentId: bx, strategyVersionId: v, mode: 'LIVE', weekdays: ALL_DAYS }) });
    expect(live.status, JSON.stringify(live.body)).toBe(201);
    expect(live.body).toMatchObject({ exchange: 'BITUNIX' });
    const items = (await call(instrumentsApi.GET, { cookie: cookies.b })).body.items as { exchange: string }[];
    expect(new Set(items.map((i) => i.exchange))).toEqual(new Set(['MEXC', 'BITUNIX', 'LIGHTER']));
  });
});
