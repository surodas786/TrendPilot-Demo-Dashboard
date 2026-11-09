// MKT-01 MEXC Futures public adapter: parsing of recorded responses and the HTTP client against a
// local stub server. No network: every response here was recorded from the public endpoints.
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { decimalString, isMexcFuturesSymbol, MexcPublicClient, MexcPublicError, parseContractDetail, parseFundingHistory, parseKlines, parseServerTime, parseTicker } from '../src/market/mexcPublic';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/mexc-public');
const rec = (f: string) => JSON.parse(readFileSync(path.join(dir, f), 'utf8'));

describe('recorded MEXC public responses', () => {
  it('ticker → bid/ask/mark/last as exact decimals with the exchange timestamp', () => {
    const body = rec('ticker-BTC_USDT.json');
    const t = parseTicker(body, 'BTC_USDT');
    expect(t).toMatchObject({ exchangeSymbol: 'BTC_USDT', bid: String(body.data.bid1), ask: String(body.data.ask1), mark: String(body.data.fairPrice), last: String(body.data.lastPrice), exchangeTimeMs: body.data.timestamp });
    expect(Number(t.ask)).toBeGreaterThanOrEqual(Number(t.bid));
  });

  it('ticker for the wrong symbol or an unknown contract is refused', () => {
    expect(() => parseTicker(rec('ticker-BTC_USDT.json'), 'ETH_USDT')).toThrow(/response is for BTC_USDT/);
    const e = (() => {
      try {
        parseTicker(rec('ticker-unknown.json'), 'NOPE_USDT');
      } catch (x) {
        return x as MexcPublicError;
      }
    })();
    expect(e).toBeInstanceOf(MexcPublicError);
    expect(e?.kind).toBe('API');
    expect(e?.code).toBe(1001);
  });

  it('klines → rows oldest first, open time from seconds; the forming bar is still in the raw data', () => {
    const body = rec('kline-BTC_USDT-Min15.json');
    const ks = parseKlines(body, 'BTC_USDT');
    expect(ks).toHaveLength(body.data.time.length);
    expect(ks[0]!.openTime.getTime()).toBe(body.data.time[0] * 1000);
    expect(ks.at(-1)!.close).toBe(String(body.data.close.at(-1)));
    // Recorded 104 s into the newest bar: the parser keeps it; the feed must drop it (feed tests).
    expect(ks.every((k, i) => i === 0 || k.openTime.getTime() - ks[i - 1]!.openTime.getTime() === 900_000)).toBe(true);
    expect(parseKlines(rec('kline-BTC_USDT-Min5.json'), 'BTC_USDT').length).toBeGreaterThan(0);
  });

  it('ping and contract detail', () => {
    expect(parseServerTime(rec('ping.json'))).toBeGreaterThan(1.7e12);
    const d = parseContractDetail(rec('detail-BTC_USDT.json'), 'BTC_USDT');
    expect(d).toMatchObject({ contractSize: '0.0001', priceUnit: '0.1', volUnit: '1', minVol: '1', state: 0 });
  });

  it('settled funding history → newest first, settlement on 8-hour UTC boundaries', () => {
    const body = rec('funding-history-BTC_USDT.json');
    const h = parseFundingHistory(body, 'BTC_USDT');
    expect(h).toHaveLength(body.data.resultList.length);
    expect(h[0]!.rate).toBe(String(body.data.resultList[0].fundingRate));
    expect(h.every((x) => x.settledAt.getTime() % (8 * 3_600_000) === 0)).toBe(true);
    expect(h[0]!.settledAt.getTime()).toBeGreaterThan(h[1]!.settledAt.getTime());
  });

  it('malformed bodies are parse errors, never partial data', () => {
    expect(() => parseKlines({ success: true, code: 0, data: { time: [1, 2], open: [1], high: [1, 2], low: [1, 2], close: [1, 2] } }, 'BTC_USDT')).toThrow(/column lengths/);
    expect(() => parseTicker({ success: true, code: 0, data: { symbol: 'BTC_USDT', bid1: 1, ask1: 2, fairPrice: 1, lastPrice: 1 } }, 'BTC_USDT')).toThrow(/timestamp/);
    expect(() => parseTicker({ success: true, code: 0, data: [] }, 'BTC_USDT')).toThrow(/one contract/);
    expect(decimalString(1e-7, 'x')).toBe('0.0000001');
    expect(() => decimalString(null, 'x')).toThrow(/missing/);
  });

  it('maps only MEXC Futures USDT symbols', () => {
    expect(isMexcFuturesSymbol('BTC_USDT')).toBe(true);
    expect(isMexcFuturesSymbol('BTCUSDT')).toBe(false);
    expect(isMexcFuturesSymbol('')).toBe(false);
  });
});

describe('MexcPublicClient against a local stub server', () => {
  let server: Server;
  let base: string;
  const seen: IncomingMessage[] = [];
  let failNext = 0;

  beforeAll(async () => {
    server = createServer((req, res) => {
      seen.push(req);
      const url = new URL(req.url!, 'http://stub');
      if (failNext > 0) {
        failNext -= 1;
        res.writeHead(503).end('busy');
        return;
      }
      const send = (f: string) => res.writeHead(200, { 'content-type': 'application/json' }).end(readFileSync(path.join(dir, f)));
      if (url.pathname === '/api/v1/contract/ping') return send('ping.json');
      if (url.pathname === '/api/v1/contract/ticker') return send(url.searchParams.get('symbol') === 'BTC_USDT' ? 'ticker-BTC_USDT.json' : 'ticker-unknown.json');
      if (url.pathname === '/api/v1/contract/kline/BTC_USDT') return send(url.searchParams.get('interval') === 'Min5' ? 'kline-BTC_USDT-Min5.json' : 'kline-BTC_USDT-Min15.json');
      if (url.pathname === '/api/v1/contract/detail') return send('detail-BTC_USDT.json');
      res.writeHead(404).end();
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it('reads public endpoints with no credentials and the right query', async () => {
    const c = new MexcPublicClient({ baseUrl: base });
    seen.length = 0;
    expect((await c.ticker('BTC_USDT')).exchangeSymbol).toBe('BTC_USDT');
    const ks = await c.klines('BTC_USDT', '15', new Date('2026-11-08T08:00:00Z'), new Date('2026-11-08T09:15:00Z'));
    expect(ks.length).toBeGreaterThan(0);
    expect(await c.serverTimeMs()).toBeGreaterThan(0);
    const kline = new URL(seen[1]!.url!, 'http://stub');
    expect(kline.searchParams.get('interval')).toBe('Min15');
    expect(kline.searchParams.get('start')).toBe(String(Date.parse('2026-11-08T08:00:00Z') / 1000));
    expect(kline.searchParams.get('end')).toBe(String(Date.parse('2026-11-08T09:15:00Z') / 1000));
    for (const req of seen) {
      expect(req.method).toBe('GET');
      for (const h of ['authorization', 'apikey', 'request-time', 'signature', 'cookie']) expect(req.headers[h]).toBeUndefined();
    }
  });

  it('refuses any non-public path before sending', async () => {
    const c = new MexcPublicClient({ baseUrl: base });
    seen.length = 0;
    await expect(c.get('/api/v1/private/order/submit')).rejects.toMatchObject({ kind: 'NOT_PUBLIC' });
    await expect(c.get('/api/v1/private/account/assets')).rejects.toMatchObject({ kind: 'NOT_PUBLIC' });
    await expect(c.get('/api/v1/contract/kline/BTC_USDT/../../private/x')).rejects.toMatchObject({ kind: 'NOT_PUBLIC' });
    expect(seen).toHaveLength(0);
  });

  it('classifies HTTP, API and network failures', async () => {
    const c = new MexcPublicClient({ baseUrl: base });
    failNext = 1;
    await expect(c.ticker('BTC_USDT')).rejects.toMatchObject({ kind: 'HTTP', code: 503 });
    await expect(c.ticker('NOPE_USDT')).rejects.toMatchObject({ kind: 'API', code: 1001 });
    await expect(new MexcPublicClient({ baseUrl: 'http://127.0.0.1:1', timeoutMs: 1000 }).ticker('BTC_USDT')).rejects.toMatchObject({ kind: 'NETWORK' });
  });
});
