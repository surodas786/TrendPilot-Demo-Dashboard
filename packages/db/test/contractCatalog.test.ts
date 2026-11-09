// UI-05 pair validation against MEXC "Get Contract Info" (recorded public response, no network) and
// the fixture catalogue used by tests and local demo mode.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { normalizePairInput } from '@trendpilot/domain';
import { contractProblems, pairContractSource, resolvePairContract, type ContractInfoSource } from '../src/market/contractCatalog';
import { MexcPublicClient, MexcPublicError, parseContractInfo, type MexcContractInfo } from '../src/market/mexcPublic';

const here = path.dirname(fileURLToPath(import.meta.url));
const XAU = JSON.parse(fs.readFileSync(path.join(here, 'fixtures/mexc-public/contract-info-XAU_USDT.json'), 'utf8'));
const xauInfo = (patch: Partial<MexcContractInfo> = {}): MexcContractInfo => ({ ...parseContractInfo(XAU, 'XAU_USDT'), ...patch });

class Stub implements ContractInfoSource {
  asked: string[] = [];
  constructor(private readonly answer: (sym: string) => MexcContractInfo | Error) {}
  async contractInfo(sym: string) {
    this.asked.push(sym);
    const a = this.answer(sym);
    if (a instanceof Error) throw a;
    return a;
  }
}
const now = () => new Date('2026-11-09T10:00:00Z');

describe('pair input', () => {
  it('accepts XAUUSDT and XAU_USDT (any case) and resolves both to platform XAUUSDT / MEXC XAU_USDT', () => {
    for (const s of ['XAUUSDT', 'XAU_USDT', ' xau_usdt ', 'xauusdt']) expect(normalizePairInput(s)).toEqual({ symbol: 'XAUUSDT', exchangeSymbol: 'XAU_USDT', base: 'XAU' });
    expect(normalizePairInput('1000PEPE_USDT')).toEqual({ symbol: '1000PEPEUSDT', exchangeSymbol: '1000PEPE_USDT', base: '1000PEPE' });
    for (const s of ['XAU', 'XAUUSD', 'XAU_USDC', 'XAU__USDT', 'X_USDT', 'XAU/USDT']) expect(normalizePairInput(s)).toBeNull();
  });
});

describe('MEXC Get Contract Info', () => {
  it('parses the recorded XAU_USDT response: perpetual, USDT-settled, enabled, exchange specs and leverage limits', () => {
    expect(parseContractInfo(XAU, 'XAU_USDT')).toMatchObject({
      exchangeSymbol: 'XAU_USDT',
      baseCoin: 'XAU',
      quoteCoin: 'USDT',
      settleCoin: 'USDT',
      futureType: 1,
      state: 0,
      contractSize: '0.001',
      priceUnit: '0.01',
      volUnit: '1',
      minVol: '1',
      maxVol: '1000000',
      minLeverage: 1,
      maxLeverage: 1000,
      takerFeeRate: '0.0002',
      apiAllowed: true
    });
    expect(contractProblems(parseContractInfo(XAU, 'XAU_USDT'))).toEqual([]);
  });

  it('calls only the public /contract/detail/country path with the MEXC symbol', async () => {
    const urls: string[] = [];
    const client = new MexcPublicClient({
      fetch: (async (u: URL) => {
        urls.push(u.toString());
        return new Response(JSON.stringify(XAU), { status: 200 });
      }) as unknown as typeof fetch
    });
    expect((await client.contractInfo('XAU_USDT')).exchangeSymbol).toBe('XAU_USDT');
    expect(urls).toEqual(['https://contract.mexc.com/api/v1/contract/detail/country?symbol=XAU_USDT']);
  });

  it('maps an unknown contract to API code 1001', async () => {
    const client = new MexcPublicClient({ fetch: (async () => new Response('{"success":false,"code":1001,"message":"Contract does not exist"}', { status: 200 })) as unknown as typeof fetch });
    await expect(client.contractInfo('NOPE_USDT')).rejects.toMatchObject({ kind: 'API', code: 1001 });
  });
});

describe('resolvePairContract', () => {
  it('XAUUSDT and XAU_USDT both resolve to the exchange-returned XAU_USDT with MEXC specs', async () => {
    for (const input of ['XAUUSDT', 'XAU_USDT']) {
      const stub = new Stub(() => xauInfo());
      const r = await resolvePairContract(input, { source: 'MEXC_PUBLIC', client: stub, now });
      expect(stub.asked).toEqual(['XAU_USDT']);
      expect(r).toMatchObject({
        ok: true,
        contract: { symbol: 'XAUUSDT', exchangeSymbol: 'XAU_USDT', base: 'XAU', quote: 'USDT', contractMultiplier: '0.001', priceTick: '0.01', qtyStep: '1', minQty: '1', maxQty: '1000000', takerFeeRate: '0.0002', minLeverage: 1, maxLeverage: 1000, source: 'MEXC_PUBLIC', warnings: [] }
      });
    }
  });

  it('distinguishes an unknown symbol from a timeout, an HTTP failure and a rate limit', async () => {
    const run = (e: Error) => resolvePairContract('XAUUSDT', { source: 'MEXC_PUBLIC', client: new Stub(() => e), now });
    expect(await run(new MexcPublicError('Contract does not exist (code 1001)', 'API', 1001))).toMatchObject({ ok: false, reason: 'UNKNOWN_SYMBOL', message: 'XAU_USDT is not a MEXC Futures contract.' });
    expect(await run(new MexcPublicError('Requests are too frequent (code 510)', 'API', 510))).toMatchObject({ ok: false, reason: 'RATE_LIMITED' });
    expect(await run(new MexcPublicError('GET: HTTP 429', 'HTTP', 429))).toMatchObject({ ok: false, reason: 'RATE_LIMITED' });
    expect(await run(new MexcPublicError('GET /api/v1/contract/detail/country: The operation was aborted due to timeout', 'NETWORK'))).toMatchObject({ ok: false, reason: 'EXCHANGE_UNAVAILABLE', message: expect.stringMatching(/not a problem with the ticker/) });
    expect(await run(new MexcPublicError('GET: HTTP 503', 'HTTP', 503))).toMatchObject({ ok: false, reason: 'EXCHANGE_UNAVAILABLE' });
    expect(await run(new MexcPublicError('contract info: unexpected response', 'PARSE'))).toMatchObject({ ok: false, reason: 'EXCHANGE_UNAVAILABLE' });
  });

  it('rejects contracts that are not an enabled, USDT-settled perpetual', async () => {
    const run = (p: Partial<MexcContractInfo>) => resolvePairContract('XAUUSDT', { source: 'MEXC_PUBLIC', client: new Stub(() => xauInfo(p)), now });
    expect(await run({ futureType: 2 })).toMatchObject({ ok: false, reason: 'NOT_ELIGIBLE', message: expect.stringMatching(/not a perpetual/) });
    expect(await run({ settleCoin: 'XAU' })).toMatchObject({ ok: false, reason: 'NOT_ELIGIBLE', message: expect.stringMatching(/not USDT-settled/) });
    expect(await run({ state: 1 })).toMatchObject({ ok: false, reason: 'NOT_ELIGIBLE', message: expect.stringMatching(/not enabled/) });
  });

  it('accepts with warnings when API trading is off or the contract opens later', async () => {
    const r = await resolvePairContract('XAU_USDT', { source: 'MEXC_PUBLIC', client: new Stub(() => xauInfo({ apiAllowed: false, openingTime: Date.parse('2026-12-01T00:00:00Z') })), now });
    expect(r.ok && r.contract.warnings).toEqual([expect.stringMatching(/API trading/), expect.stringMatching(/Trading opens 2026-12-01/)]);
  });

  it('fixture mode (tests, local demo) never calls MEXC and labels the result', async () => {
    expect(await resolvePairContract('SOL_USDT', { source: 'FIXTURE', now })).toMatchObject({ ok: true, contract: { symbol: 'SOLUSDT', exchangeSymbol: 'SOL_USDT', source: 'FIXTURE' } });
    expect(await resolvePairContract('XAUUSDT', { source: 'FIXTURE', now })).toMatchObject({ ok: false, reason: 'UNKNOWN_SYMBOL', message: expect.stringMatching(/fixtures/) });
  });

  it('source: MEXC in production, fixtures otherwise, explicit override wins', () => {
    expect(pairContractSource({ NODE_ENV: 'production' })).toBe('MEXC_PUBLIC');
    expect(pairContractSource({ NODE_ENV: 'test' })).toBe('FIXTURE');
    expect(pairContractSource({ NODE_ENV: 'development' })).toBe('FIXTURE');
    expect(pairContractSource({ NODE_ENV: 'production', PAIR_VALIDATION_SOURCE: 'fixture' })).toBe('FIXTURE');
    expect(pairContractSource({ NODE_ENV: 'development', PAIR_VALIDATION_SOURCE: 'mexc' })).toBe('MEXC_PUBLIC');
    expect(() => pairContractSource({ PAIR_VALIDATION_SOURCE: 'live' })).toThrow(/mexc|fixture/);
  });
});
