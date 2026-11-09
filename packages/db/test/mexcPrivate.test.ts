// Step 11: MEXC private adapter units — signing, transport refusal in Paper/Demo/replay/CI,
// normalization, and that nothing outside the adapter can reach private endpoints.
import { createHmac } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
  buildSignedRequest,
  getParamString,
  LiveOrderTransportRefused,
  MexcHttpTransport,
  normalizeAssets,
  normalizeDeals,
  normalizeOrder,
  normalizePositions,
  normalizeStops,
  openLiveOrderTransport,
  redactHeaders,
  signMexc
} from '../src/live/mexcPrivate';
import { livePilotVerified, MEXC_CAPABILITIES } from '../src/live/capabilities';
import { mexcVenue } from '../src/live/mexcVenue';
import { resolveVenue, venueForMode } from '../src/venue/select';

// Dummy, non-functional test credentials (never real keys).
const CREDS = { apiKey: 'mx0-test-access-key', secretKey: 'test-secret-not-a-real-key' };
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

describe('signing (integration guide)', () => {
  it('HMAC-SHA256 over accessKey + Request-Time + parameter string', () => {
    const expected = createHmac('sha256', CREDS.secretKey).update(`${CREDS.apiKey}1794150000000symbol=BTC_USDT`).digest('hex');
    expect(signMexc(CREDS.secretKey, CREDS.apiKey, '1794150000000', 'symbol=BTC_USDT')).toBe(expected);
  });

  it('GET: business parameters sorted by name, nulls omitted; POST: the exact JSON body', () => {
    expect(getParamString({ symbol: 'BTC_USDT', page_size: 10, a: null, b: undefined, page_num: 1 })).toBe('page_num=1&page_size=10&symbol=BTC_USDT');
    const g = buildSignedRequest(CREDS, 'GET', '/api/v1/private/position/open_positions', { symbol: 'BTC_USDT' }, '1794150000000');
    expect(g.url).toBe('/api/v1/private/position/open_positions?symbol=BTC_USDT');
    expect(g.headers).toMatchObject({ ApiKey: CREDS.apiKey, 'Request-Time': '1794150000000', Signature: signMexc(CREDS.secretKey, CREDS.apiKey, '1794150000000', 'symbol=BTC_USDT') });
    const body = { symbol: 'BTC_USDT', vol: '10', side: 1 };
    const p = buildSignedRequest(CREDS, 'POST', '/api/v1/private/order/create', body, '1794150000001', 10);
    expect(p.body).toBe(JSON.stringify(body));
    expect(p.headers.Signature).toBe(signMexc(CREDS.secretKey, CREDS.apiKey, '1794150000001', JSON.stringify(body)));
    expect(p.headers).toMatchObject({ 'Content-Type': 'application/json', 'Recv-Window': '10' });
    expect(buildSignedRequest(CREDS, 'GET', '/api/v1/private/account/assets', null, '1').headers.Signature).toBe(signMexc(CREDS.secretKey, CREDS.apiKey, '1', ''));
  });

  it('never exposes the key, secret or signature in logs', () => {
    const h = buildSignedRequest(CREDS, 'GET', '/api/v1/private/account/assets', null, '1').headers;
    const red = JSON.stringify(redactHeaders(h));
    expect(red).not.toContain(CREDS.apiKey);
    expect(red).not.toContain(h.Signature!);
    expect(red).not.toContain(CREDS.secretKey);
  });
});

describe('Paper, Demo, replay and CI cannot reach the private order transport', () => {
  const envs: [string, Record<string, string | undefined>][] = [
    ['unset (development)', {}],
    ['LIVE_ORDER_TRANSPORT=disabled (Paper staging)', { LIVE_ORDER_TRANSPORT: 'disabled', NODE_ENV: 'production' }],
    ['Paper process with the flag enabled', { LIVE_ORDER_TRANSPORT: 'enabled', NODE_ENV: 'production', TRENDPILOT_MODE: 'PAPER' }],
    ['Demo process', { LIVE_ORDER_TRANSPORT: 'enabled', NODE_ENV: 'production', TRENDPILOT_MODE: 'DEMO' }],
    ['replay (fixed signal clock)', { LIVE_ORDER_TRANSPORT: 'enabled', TRENDPILOT_MODE: 'LIVE', SIGNAL_TEST_CLOCK: '2026-11-08T09:30:03Z' }],
    ['e2e server (ALLOW_SIGNAL_TEST_CLOCK)', { LIVE_ORDER_TRANSPORT: 'enabled', TRENDPILOT_MODE: 'LIVE', NODE_ENV: 'production', ALLOW_SIGNAL_TEST_CLOCK: 'true' }],
    ['CI', { LIVE_ORDER_TRANSPORT: 'enabled', TRENDPILOT_MODE: 'LIVE', NODE_ENV: 'production', CI: 'true' }],
    ['test runner', { LIVE_ORDER_TRANSPORT: 'enabled', TRENDPILOT_MODE: 'LIVE', NODE_ENV: 'test' }],
    ['a fully "live" production env — still refused by the build gate (Step 12)', { LIVE_ORDER_TRANSPORT: 'enabled', TRENDPILOT_MODE: 'LIVE', NODE_ENV: 'production' }]
  ];
  for (const [name, env] of envs) {
    it(`refuses: ${name}`, () => {
      expect(() => openLiveOrderTransport(env)).toThrow(LiveOrderTransportRefused);
      expect(() => new MexcHttpTransport({ mode: 'ORDERS', credentials: CREDS, env })).toThrow(LiveOrderTransportRefused);
      expect(() => venueForMode({} as never, 'LIVE', env)).toThrow(LiveOrderTransportRefused);
    });
  }

  it('the read-only transport refuses order paths and POSTs before anything is sent', async () => {
    const fetchSpy = vi.fn();
    const t = new MexcHttpTransport({ mode: 'READ_ONLY', credentials: CREDS, fetch: fetchSpy as unknown as typeof fetch });
    await expect(t.request('POST', '/api/v1/private/order/create', { symbol: 'BTC_USDT' })).rejects.toMatchObject({ kind: 'REFUSED' });
    await expect(t.request('POST', '/api/v1/private/stoporder/place', {})).rejects.toMatchObject({ kind: 'REFUSED' });
    await expect(t.request('POST', '/api/v1/private/order/cancel_with_external', [])).rejects.toMatchObject({ kind: 'REFUSED' });
    await expect(t.request('GET', '/api/v1/private/account/withdraw')).rejects.toMatchObject({ kind: 'REFUSED' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('the read-only transport signs allowlisted GETs and sends no secret', async () => {
    const seen: { url: string; headers: Record<string, string> }[] = [];
    const fake = (async (url: string, init: RequestInit) => {
      seen.push({ url, headers: init.headers as Record<string, string> });
      return new Response(JSON.stringify({ success: true, code: 0, data: 2 }), { status: 200 });
    }) as unknown as typeof fetch;
    const t = new MexcHttpTransport({ mode: 'READ_ONLY', credentials: CREDS, fetch: fake, now: () => 1794150000000 });
    expect(await t.request('GET', '/api/v1/private/position/position_mode')).toBe(2);
    expect(seen[0]!.url).toBe('https://api.mexc.com/api/v1/private/position/position_mode');
    expect(seen[0]!.headers.Signature).toBe(signMexc(CREDS.secretKey, CREDS.apiKey, '1794150000000', ''));
    expect(JSON.stringify(seen)).not.toContain(CREDS.secretKey);
  });

  it('PAPER always maps to the paper simulator; venue injection is refused in production', () => {
    expect(venueForMode({} as never, 'PAPER').kind).toBe('PAPER_SIMULATOR');
    const fakeVenue = { kind: 'MEXC_PRIVATE' } as never;
    expect(() => resolveVenue({} as never, 'PAPER', fakeVenue, { NODE_ENV: 'production' })).toThrow(LiveOrderTransportRefused);
  });

  it('only the adapter module names private endpoints; only the read-only check builds an HTTP transport', () => {
    const files: string[] = [];
    const walk = (d: string) => {
      for (const f of readdirSync(d)) {
        if (['node_modules', '.next', 'test', 'e2e', 'test-results', 'demo'].includes(f)) continue;
        const p = path.join(d, f);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(ts|tsx)$/.test(f)) files.push(p);
      }
    };
    for (const d of ['packages', 'apps', 'scripts']) walk(path.join(ROOT, d));
    const rel = (p: string) => path.relative(ROOT, p).replace(/\\/g, '/');
    // Literal paths ("/api/v1/private/…") and regex-escaped ones ("\/api\/v1\/private").
    const naming = files.filter((f) => /api\\?\/v1\\?\/private/.test(readFileSync(f, 'utf8'))).map(rel).sort();
    expect(naming.length).toBeGreaterThanOrEqual(3);
    // Private endpoints are named only inside the adapter directory and the read-only check.
    expect(naming.filter((f) => !f.startsWith('packages/db/src/live/') && f !== 'packages/db/src/cli/mexc-readonly-check.ts')).toEqual([]);
    expect(naming).toEqual(expect.arrayContaining(['packages/db/src/live/mexcPrivate.ts', 'packages/db/src/live/mexcVenue.ts']));
    const building = files.filter((f) => /new MexcHttpTransport\(/.test(readFileSync(f, 'utf8'))).map(rel);
    expect(building).toEqual(['packages/db/src/cli/mexc-readonly-check.ts']);
    expect(readFileSync(path.join(ROOT, 'packages/db/src/cli/mexc-readonly-check.ts'), 'utf8')).toMatch(/mode: 'READ_ONLY'/);
  });
});

describe('normalization (documented fields)', () => {
  it('assets, positions, orders, deals (de-duplicated) and stops', () => {
    expect(normalizeAssets([{ currency: 'USDT', equity: 120.5, availableBalance: 100, availableOpen: 99, positionMargin: 20, frozenBalance: 0.5, unrealized: -1.25, bonus: 0 }])[0]).toEqual({
      currency: 'USDT',
      equity: '120.5',
      available: '100',
      availableOpen: '99',
      positionMargin: '20',
      frozen: '0.5',
      unrealized: '-1.25',
      bonus: '0'
    });
    expect(normalizePositions([{ positionId: 77, symbol: 'BTC_USDT', positionType: 2, holdVol: 13, frozenVol: 0, holdAvgPrice: 75000.1, liquidatePrice: 0, leverage: 5, openType: 1, im: 19.5, realised: 0, holdFee: -0.01, state: 1 }])[0]).toMatchObject({
      positionId: '77',
      side: 'SHORT',
      contracts: '13',
      liquidationPrice: null,
      marginMode: 'ISOLATED',
      fundingFee: '-0.01',
      open: true
    });
    expect(normalizeOrder({ orderId: 5, externalOid: 'tp-x', symbol: 'BTC_USDT', side: 4, vol: 10, dealVol: 6, dealAvgPrice: 65000, state: 4, takerFee: 0.1, makerFee: 0 })).toMatchObject({ state: 'CANCELLED', dealVol: '6', side: 4 });
    expect(() => normalizeOrder({ orderId: 5, state: 9 })).toThrow(/unknown state/);
    const deals = normalizeDeals([
      { id: 1, orderId: 5, vol: 4, price: 65000, fee: 0.1, timestamp: 2 },
      { id: 1, orderId: 5, vol: 4, price: 65000, fee: 0.1, timestamp: 2 },
      { id: 2, orderId: 5, vol: 2, price: 65001, fee: 0.05, timestamp: 3 }
    ]);
    expect(deals.map((d) => d.dealId)).toEqual(['1', '2']);
    expect(normalizeStops([{ id: 9, orderId: 5, positionId: 77, symbol: 'BTC_USDT', positionType: 1, stopLossPrice: 64000, lossTrend: 2, vol: 10, state: 5, errorCode: 3009 }])[0]).toMatchObject({ stopId: '9', basis: 'MARK', state: 'FAILED', positionSide: 'LONG' });
  });
});

describe('capability gate', () => {
  it('nothing is live-pilot verified in this build, so no order capability is open', () => {
    for (const c of MEXC_CAPABILITIES) expect(c.livePilot).not.toBe('VERIFIED');
    expect(livePilotVerified('OPEN_WITH_ATTACHED_STOP')).toBe(false);
    expect(livePilotVerified('REDUCE_ONLY_CLOSE')).toBe(false);
    expect(MEXC_CAPABILITIES.find((c) => c.id === 'ACCOUNT_ELIGIBILITY')!.gaps.join(' ')).toMatch(/institutional/);
  });

  it('an unverified venue refuses to open or close without contacting MEXC', async () => {
    const requester = { request: vi.fn() };
    const v = mexcVenue({ requester, symbolFor: async () => 'BTC_USDT', positionMode: 'HEDGE' });
    const open = await v.placeOpeningOrderWithStop({ paperAccountId: 'a', clientOrderId: 'tp-1', instrumentId: 'i', side: 'LONG', contracts: '10', contract: { multiplier: '0.0001', qtyStep: '1', minQty: '1', takerFeeRate: '0.0004' }, quote: { bid: '1', ask: '2' }, stop: { price: '1', basis: 'MARK' }, now: new Date(), leverage: 5 } as never);
    expect(open).toMatchObject({ status: 'REJECTED', reason: 'CAPABILITY_UNVERIFIED:OPEN_WITH_ATTACHED_STOP' });
    const close = await v.placeReduceOnlyClose({ paperAccountId: 'a', clientOrderId: 'tp-2', instrumentId: 'i', positionSide: 'LONG', contracts: '10', contract: { multiplier: '0.0001', qtyStep: '1', takerFeeRate: '0.0004' }, quote: { bid: '1', ask: '2', mark: '1', last: '1' }, now: new Date() });
    expect(close).toMatchObject({ status: 'REJECTED', reason: 'CAPABILITY_UNVERIFIED:REDUCE_ONLY_CLOSE' });
    expect(requester.request).not.toHaveBeenCalled();
  });

  it('an opening request without a stop is refused before any call', async () => {
    const requester = { request: vi.fn() };
    const v = mexcVenue({ requester, symbolFor: async () => 'BTC_USDT', positionMode: 'HEDGE', capabilities: { OPEN_WITH_ATTACHED_STOP: 'VERIFIED' } });
    const r = await v.placeOpeningOrderWithStop({ clientOrderId: 'tp-3', instrumentId: 'i', side: 'LONG', contracts: '1', stop: null, leverage: 5 } as never);
    expect(r).toMatchObject({ status: 'REJECTED', reason: 'STOP_REQUIRED' });
    expect(requester.request).not.toHaveBeenCalled();
  });
});
