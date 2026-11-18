// Lighter Step 1: the public catalog client and market eligibility, against a catalog subset captured
// from the live Ethereum-mainnet API (2026-11-17). Read-only: no account, signing or orders.
import { describe, expect, it } from 'vitest';
import {
  assertLighterMainnet,
  findLighterMarket,
  LIGHTER_FIXTURE_ORDER_BOOK_DETAILS,
  LIGHTER_MAINNET,
  LighterPublicClient,
  LighterPublicError,
  lighterIneligibility,
  lighterInstrumentSpec,
  lighterMaxLeverage,
  parseLighterOrderBookDetails
} from '../src/index';
import { accountExchangeFor } from '../src/paper/accounts';

const markets = parseLighterOrderBookDetails(LIGHTER_FIXTURE_ORDER_BOOK_DETAILS);
const byId = (id: number) => markets.find((m) => m.marketId === id)!;

describe('catalog parsing', () => {
  it('keeps perps and spot apart, with native symbols and market IDs', () => {
    expect(byId(92)).toMatchObject({ symbol: 'XAU', marketType: 'perp', status: 'active', quoteAssetId: 0, sizeDecimals: 4, priceDecimals: 2, minBaseAmount: '0.0015', minQuoteAmount: '10', minInitialMarginFraction: 400, deployer: 'lighter' });
    expect(byId(2056)).toMatchObject({ symbol: 'XAUT/USDC', marketType: 'spot', quoteAssetId: 3 });
  });

  it('refuses malformed catalog bodies instead of guessing', () => {
    expect(() => parseLighterOrderBookDetails({ code: 500 })).toThrow(LighterPublicError);
    expect(() => parseLighterOrderBookDetails({ code: 200 })).toThrow(/order_book_details missing/);
    expect(() => parseLighterOrderBookDetails({ code: 200, order_book_details: [{ symbol: 'X', market_id: 'nine' }] })).toThrow(/market_id/);
  });
});

describe('eligibility: active, Lighter-deployed USDC perpetuals only', () => {
  it('XAU (market 92) is eligible; 25x from the 4% minimum initial margin; base-unit rules', () => {
    expect(lighterIneligibility(byId(92))).toEqual([]);
    expect(lighterMaxLeverage(byId(92))).toBe(25);
    expect(lighterInstrumentSpec(byId(92), 25)).toMatchObject({ exchangeSymbol: 'XAU', exchangeMarketId: 92, base: 'XAU', quote: 'USDC', contractMultiplier: '1', qtyStep: '0.0001', minQty: '0.0015', minNotional: '10', priceTick: '0.01', takerFeeRate: '0' });
  });

  it('refuses spot, inactive and externally deployed markets with the reason', () => {
    expect(lighterIneligibility(byId(2056)).map((r) => r.reason)).toEqual(expect.arrayContaining(['NOT_PERP', 'NOT_USDC']));
    expect(lighterIneligibility(byId(222)).map((r) => r.reason)).toEqual(['INACTIVE']);
    expect(lighterIneligibility(byId(8286)).map((r) => r.reason)).toEqual(expect.arrayContaining(['INACTIVE', 'EXTERNAL_DEPLOYER']));
  });

  it('refuses another quote asset, dated or binary markets, frozen markets and non-zero fees of unknown unit', () => {
    const xau = byId(92);
    expect(lighterIneligibility({ ...xau, quoteAssetId: 3 }).map((r) => r.reason)).toEqual(['NOT_USDC']);
    expect(lighterIneligibility({ ...xau, endTimestamp: 1_800_000_000_000 }).map((r) => r.reason)).toEqual(['DATED_OR_BINARY']);
    expect(lighterIneligibility({ ...xau, outcome: 1 }).map((r) => r.reason)).toEqual(['DATED_OR_BINARY']);
    expect(lighterIneligibility({ ...xau, isFrozen: true }).map((r) => r.reason)).toEqual(['FROZEN']);
    expect(lighterIneligibility({ ...xau, takerFee: '0.02' }).map((r) => r.reason)).toEqual(['FEE_UNIT_UNVERIFIED']);
    expect(lighterIneligibility({ ...xau, minInitialMarginFraction: null }).map((r) => r.reason)).toEqual(['MARGIN_UNKNOWN']);
  });
});

describe('lookup by exact native symbol or market ID (nothing derived)', () => {
  it('finds XAU by symbol and by market ID', () => {
    expect(findLighterMarket(markets, 'XAU')).toMatchObject({ ok: true, market: { marketId: 92 }, settlementCurrency: 'USDC', maxLeverage: 25 });
    expect(findLighterMarket(markets, ' 92 ')).toMatchObject({ ok: true, market: { symbol: 'XAU' } });
  });

  it('never rewrites a ticker into a Lighter symbol or market ID', () => {
    for (const q of ['XAUUSDT', 'XAU_USDC', 'XAU/USDC', 'XAUUSDT.P']) expect(findLighterMarket(markets, q)).toMatchObject({ ok: false, reason: 'UNKNOWN_MARKET' });
    expect(findLighterMarket(markets, 'MEXC:XAUUSDT.P')).toMatchObject({ ok: false, reason: 'INVALID_INPUT' });
    expect(findLighterMarket(markets, '9999')).toMatchObject({ ok: false, reason: 'UNKNOWN_MARKET' });
  });

  it('spot XAUT/USDC and inactive markets are found but not eligible; bad input is refused', () => {
    expect(findLighterMarket(markets, 'XAUT/USDC')).toMatchObject({ ok: false, reason: 'NOT_ELIGIBLE' });
    expect(findLighterMarket(markets, '2056')).toMatchObject({ ok: false, reason: 'NOT_ELIGIBLE' });
    expect(findLighterMarket(markets, '222')).toMatchObject({ ok: false, reason: 'NOT_ELIGIBLE' });
    expect(findLighterMarket(markets, '')).toMatchObject({ ok: false, reason: 'INVALID_INPUT' });
    expect(findLighterMarket(markets, 'XAU; DROP')).toMatchObject({ ok: false, reason: 'INVALID_INPUT' });
  });

  it('a symbol listed twice is ambiguous: the market ID is required', () => {
    const twice = [...markets, { ...byId(92), marketId: 4242 }];
    expect(findLighterMarket(twice, 'XAU')).toMatchObject({ ok: false, reason: 'AMBIGUOUS' });
    expect(findLighterMarket(twice, '92')).toMatchObject({ ok: true });
  });
});

describe('environment and transport', () => {
  it('accepts only the Ethereum-based mainnet identity', () => {
    expect(() => assertLighterMainnet({ networkId: 1, contractAddress: LIGHTER_MAINNET.contractAddress.toLowerCase() })).not.toThrow();
    expect(() => assertLighterMainnet({ networkId: 11155111, contractAddress: LIGHTER_MAINNET.contractAddress })).toThrow(/not the Ethereum-based mainnet/);
    expect(() => assertLighterMainnet({ networkId: 1, contractAddress: '0x0000000000000000000000000000000000000001' })).toThrow(/not the Ethereum-based mainnet/);
  });

  it('the client sends public GETs only and reports network and HTTP failures as errors', async () => {
    const seen: string[] = [];
    const ok = new LighterPublicClient({ baseUrl: 'https://example.test', fetch: (async (u: string | URL | Request, init?: RequestInit) => (seen.push(`${init?.method} ${String(u)}`), new Response(JSON.stringify(LIGHTER_FIXTURE_ORDER_BOOK_DETAILS)))) as typeof fetch });
    expect((await ok.markets()).length).toBe(markets.length);
    expect(seen).toEqual(['GET https://example.test/api/v1/orderBookDetails']);
    await expect(ok.get('/api/v1/account')).rejects.toMatchObject({ kind: 'NOT_PUBLIC' });
    await expect(ok.get('/api/v1/sendTx')).rejects.toMatchObject({ kind: 'NOT_PUBLIC' });
    const down = new LighterPublicClient({ baseUrl: 'https://example.test', fetch: (async () => { throw new Error('connect ECONNREFUSED'); }) as typeof fetch });
    await expect(down.markets()).rejects.toMatchObject({ kind: 'NETWORK' });
    const http = new LighterPublicClient({ baseUrl: 'https://example.test', fetch: (async () => new Response('busy', { status: 503 })) as typeof fetch });
    await expect(http.environment()).rejects.toMatchObject({ kind: 'HTTP', status: 503 });
  });
});

describe('an exchange registered for selection only never maps onto a MEXC account', () => {
  it('accountExchangeFor refuses Lighter Live and maps Lighter Paper to its own Lighter account (Step 3); MEXC and Bitunix are unchanged', () => {
    expect(() => accountExchangeFor('LIVE', 'LIGHTER')).toThrow(/Lighter Live trading is not available yet/);
    expect(accountExchangeFor('PAPER', 'LIGHTER')).toBe('LIGHTER');
    expect(accountExchangeFor('LIVE', 'BITUNIX')).toBe('BITUNIX');
    expect(accountExchangeFor('LIVE', 'MEXC')).toBe('MEXC');
    expect(accountExchangeFor('PAPER', 'BITUNIX')).toBe('MEXC');
  });
});
