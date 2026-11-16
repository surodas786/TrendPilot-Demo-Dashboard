// Bitunix public contract discovery: trading_pairs parsing from fixtures captured from the live
// API, eligibility (open, API-enabled, USDT, launched), unsupported symbols, the TradingView source
// symbol vs the Bitunix execution symbol, and the public path allowlist.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { bitunixSymbolFor, parseExchangeId } from '@trendpilot/domain';
import { BitunixPublicClient, BitunixPublicError, discoverBitunixContracts, parseBitunixTradingPairs, validateBitunixSymbol, type BitunixContract } from '../src/market/bitunixPublic';

const fx = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/bitunix-public/${name}`, import.meta.url), 'utf8')) as unknown;
const NOW = Date.parse('2026-11-16T12:00:00Z');
const pairs = parseBitunixTradingPairs(fx('trading-pairs-BTCUSDT-XAUUSDT.json'));
const edge = parseBitunixTradingPairs(fx('trading-pairs-edge-cases.json'));

describe('Bitunix trading pairs', () => {
  it('keeps precision, minimum opening quantity, maximum market order and leverage limits (BTCUSDT, XAUUSDT)', () => {
    const btc = pairs.find((c) => c.exchangeSymbol === 'BTCUSDT')!;
    expect(btc).toMatchObject({ base: 'BTC', quote: 'USDT', symbolStatus: 'OPEN', isApiSupported: true, basePrecision: 4, qtyStep: '0.0001', quotePrecision: 1, priceTick: '0.1', minTradeVolume: '0.0001', maxMarketOrderVolume: '120', maxLimitOrderVolume: '1200', minLeverage: 1, maxLeverage: 200, defaultLeverage: 10, defaultMarginMode: '2', launchTime: 1719403200000, delistTime: null });
    const xau = pairs.find((c) => c.exchangeSymbol === 'XAUUSDT')!;
    expect(xau).toMatchObject({ base: 'XAU', basePrecision: 3, qtyStep: '0.001', quotePrecision: 2, priceTick: '0.01', minTradeVolume: '0.002', maxMarketOrderVolume: '200', maxLeverage: 200, priceProtectScope: '0.05' });
  });

  it('accepts the documented example shape (numeric defaultMarginMode, no launch/delist time)', () => {
    const doc = { code: 0, data: [{ symbol: 'BTCUSDT', base: 'BTC', quote: 'USDT', minTradeVolume: '0.0001', minBuyPriceOffset: '-0.95', maxSellPriceOffset: '100', maxLimitOrderVolume: '100000', maxMarketOrderVolume: '50000', basePrecision: 4, quotePrecision: 1, minLeverage: 1, maxLeverage: 125, defaultLeverage: 20, defaultMarginMode: 1, priceProtectScope: '0.02', symbolStatus: 'OPEN', isApiSupported: true, maxFundingRate: '0.3', minFundingRate: '-0.3' }], msg: 'Success' };
    const [c] = parseBitunixTradingPairs(doc);
    expect(c).toMatchObject({ defaultMarginMode: '1', launchTime: null, delistTime: null, maxLeverage: 125 });
  });

  it('an API error code is kind API; a malformed body or row is PARSE', () => {
    expect(() => parseBitunixTradingPairs(fx('trading-pairs-unknown-symbol.json'))).toThrow(expect.objectContaining({ kind: 'API', code: 20015 }));
    expect(() => parseBitunixTradingPairs({ code: 0, data: {} })).toThrow(/not a list/);
    expect(() => parseBitunixTradingPairs({ code: 0, data: [{ symbol: 'BTCUSDT', basePrecision: 'x', quotePrecision: 1, minTradeVolume: '1' }] })).toThrow(/basePrecision/);
    expect(() => parseBitunixTradingPairs({ code: 0, data: [{ symbol: 'BTCUSDT', basePrecision: 1, quotePrecision: 1 }] })).toThrow(/minTradeVolume is missing/);
  });
});

describe('Bitunix symbol validation', () => {
  it('BTCUSDT and XAUUSDT are open and API-enabled', () => {
    for (const s of ['BTCUSDT', 'XAUUSDT']) expect(validateBitunixSymbol(s, pairs, NOW)).toMatchObject({ ok: true, contract: { exchangeSymbol: s } });
  });

  it('refuses unknown, not-API-enabled, not-yet-launched (PREVIEW) and non-USDT contracts', () => {
    expect(validateBitunixSymbol('NOPEUSDT', edge, NOW)).toMatchObject({ ok: false, reason: 'UNKNOWN_SYMBOL' });
    expect(validateBitunixSymbol('EWJUSDT', edge, NOW)).toMatchObject({ ok: false, reason: 'NOT_ELIGIBLE', message: expect.stringMatching(/does not allow API trading/) });
    const preview = validateBitunixSymbol('FDUSDUSDT', edge, NOW);
    expect(preview).toMatchObject({ ok: false, reason: 'NOT_ELIGIBLE' });
    expect((preview as { message: string }).message).toMatch(/status PREVIEW.*launches 2029/);
    expect(validateBitunixSymbol('BTCUSD', edge, NOW)).toMatchObject({ ok: false, reason: 'INVALID_INPUT' }); // not a USDT perpetual symbol at all
    const usd: BitunixContract = { ...edge.find((c) => c.exchangeSymbol === 'BTCUSD')!, exchangeSymbol: 'BTCXUSDT' };
    expect(validateBitunixSymbol('BTCXUSDT', [usd], NOW)).toMatchObject({ ok: false, message: expect.stringMatching(/not USDT-quoted/) });
    expect(validateBitunixSymbol('', edge, NOW)).toMatchObject({ ok: false, reason: 'INVALID_INPUT' });
  });

  it('a scheduled delisting is a warning before it happens and a refusal after', () => {
    const tsla = edge.find((c) => c.exchangeSymbol === 'TSLAUSDT')!;
    expect(validateBitunixSymbol('TSLAUSDT', edge, NOW)).toMatchObject({ ok: true, warnings: [expect.stringMatching(/delisting/)] });
    expect(validateBitunixSymbol('TSLAUSDT', edge, tsla.delistTime! + 1)).toMatchObject({ ok: false, message: expect.stringMatching(/delisted/) });
  });

  it('the TradingView source symbol stays separate from the execution symbol', () => {
    expect(bitunixSymbolFor('BITUNIX:BTCUSDT.P')).toBe('BTCUSDT');
    expect(bitunixSymbolFor('XAUUSDT.P')).toBe('XAUUSDT');
    expect(bitunixSymbolFor('btc_usdt')).toBe('BTCUSDT');
    expect(bitunixSymbolFor('BTCUSD')).toBeNull();
    const r = validateBitunixSymbol('BITUNIX:XAUUSDT.P', pairs, NOW);
    expect(r).toMatchObject({ ok: true, contract: { exchangeSymbol: 'XAUUSDT' } });
    expect(parseExchangeId(undefined)).toBe('MEXC');
    expect(parseExchangeId('bitunix')).toBe('BITUNIX');
    expect(parseExchangeId('binance')).toBeNull();
  });
});

describe('Bitunix public client', () => {
  it('requests trading_pairs for BTCUSDT and XAUUSDT with no credentials, and refuses private paths', async () => {
    const seen: { url: string; headers: unknown }[] = [];
    const client = new BitunixPublicClient({
      baseUrl: 'https://fapi.example.test',
      fetch: (async (u: URL | string, init: RequestInit) => {
        seen.push({ url: String(u), headers: init.headers });
        return new Response(JSON.stringify(fx('trading-pairs-BTCUSDT-XAUUSDT.json')), { status: 200 });
      }) as typeof fetch
    });
    const d = await discoverBitunixContracts(client, ['BTCUSDT', 'XAUUSDT'], () => new Date(NOW));
    expect(seen[0]!.url).toBe('https://fapi.example.test/api/v1/futures/market/trading_pairs?symbols=BTCUSDT%2CXAUUSDT');
    expect(seen[0]!.headers).toEqual({ accept: 'application/json' });
    expect(Object.values(d.results).every((r) => r.ok)).toBe(true);
    await expect(client.get('/api/v1/futures/account')).rejects.toMatchObject({ kind: 'NOT_PUBLIC' });
    expect(seen).toHaveLength(1);
  });

  it('when one requested symbol is unknown (20015) it falls back to the full list and reports that symbol', async () => {
    const urls: string[] = [];
    const client = new BitunixPublicClient({
      fetch: (async (u: URL | string) => {
        urls.push(String(u));
        const body = String(u).includes('NOPEUSDT') ? fx('trading-pairs-unknown-symbol.json') : fx('trading-pairs-edge-cases.json');
        return new Response(JSON.stringify(body), { status: 200 });
      }) as typeof fetch
    });
    const d = await discoverBitunixContracts(client, ['BTCUSDT', 'NOPEUSDT'], () => new Date(NOW));
    expect(urls).toHaveLength(2);
    expect(d.results.BTCUSDT).toMatchObject({ ok: true });
    expect(d.results.NOPEUSDT).toMatchObject({ ok: false, reason: 'UNKNOWN_SYMBOL' });
  });

  it('HTTP failures are distinct from API codes', async () => {
    const client = new BitunixPublicClient({ fetch: (async () => new Response('busy', { status: 503 })) as unknown as typeof fetch });
    await expect(client.tradingPairs(['BTCUSDT'])).rejects.toMatchObject({ kind: 'HTTP', code: 503 });
    expect(new BitunixPublicError('x', 'API', 20015).kind).toBe('API');
  });
});
