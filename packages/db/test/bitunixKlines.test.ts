// Bitunix closed candles for EMA 200: parsing of responses captured from the live API (newest
// first, `time` = open time as an ms string), and the backward pager (exclusive endTime, ≤ 200 per
// request) that the shared candle sync calls with an inclusive [from, to] range of open times.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BitunixKlineSource, parseBitunixKlines } from '../src/market/bitunixKlines';

const fx = (n: string) => JSON.parse(readFileSync(new URL(`./fixtures/bitunix-public/${n}`, import.meta.url), 'utf8')) as unknown;

describe('Bitunix kline parsing (live captures, 2026-11-16)', () => {
  it('sorts newest-first responses oldest first and reads the open time from the ms string', () => {
    const k = parseBitunixKlines(fx('kline-BTCUSDT-15m.json'), 'BTCUSDT', '15');
    expect(k.map((x) => x.openTime.toISOString())).toEqual(['2026-11-16T10:30:00.000Z', '2026-11-16T10:45:00.000Z', '2026-11-16T11:00:00.000Z', '2026-11-16T11:15:00.000Z', '2026-11-16T11:30:00.000Z']);
    expect(k.at(-1)).toMatchObject({ open: '64630.7', high: '64696.5', low: '64515', close: '64564.1' });
    // Captured at 11:56 UTC: the newest 15m bar is 11:30 (closed 11:45); the forming 11:45 bar is absent.
    const five = parseBitunixKlines(fx('kline-XAUUSDT-5m.json'), 'XAUUSDT', '5');
    expect(five.at(-1)!.openTime.toISOString()).toBe('2026-11-16T11:50:00.000Z');
  });

  it('endTime is exclusive: the capture with endTime 11:00 ends with the 10:45 bar', () => {
    const k = parseBitunixKlines(fx('kline-BTCUSDT-15m-endTime.json'), 'BTCUSDT', '15');
    expect(k.map((x) => x.openTime.toISOString())).toEqual(['2026-11-16T10:30:00.000Z', '2026-11-16T10:45:00.000Z']);
  });

  it('rejects API errors, misaligned times and malformed rows', () => {
    expect(() => parseBitunixKlines({ code: 20001, msg: 'Market not exists', data: null }, 'NOPEUSDT', '15')).toThrow(expect.objectContaining({ kind: 'API', code: 20001 }));
    expect(() => parseBitunixKlines({ code: 0, data: [{ time: '1794828600001', open: '1', high: '1', low: '1', close: '1' }] }, 'BTCUSDT', '15')).toThrow(/not a 15m open time/);
    expect(() => parseBitunixKlines({ code: 0, data: [{ time: '17948286', open: '1', high: '1', low: '1', close: '1' }] }, 'BTCUSDT', '15')).toThrow(/bad time/);
    expect(() => parseBitunixKlines({ code: 0, data: [{ time: '1794828600000', open: 'x', high: '1', low: '1', close: '1' }] }, 'BTCUSDT', '15')).toThrow(/open/);
  });
});

describe('Bitunix backward pager', () => {
  it('pages back 200 at a time with an exclusive endTime and returns exactly [from, to] oldest first', async () => {
    const ms = 900_000;
    const asked: { endTime: number; limit: number; interval: string }[] = [];
    const fakeFetch: typeof globalThis.fetch = (async (u: URL | string) => {
      const url = new URL(String(u));
      const endTime = Number(url.searchParams.get('endTime'));
      const limit = Number(url.searchParams.get('limit'));
      asked.push({ endTime, limit, interval: url.searchParams.get('interval')! });
      const data = Array.from({ length: limit }, (_, i) => ({ time: String(endTime - (i + 1) * ms), open: '1', high: '1', low: '1', close: String(i) }));
      return new Response(JSON.stringify({ code: 0, data, msg: 'Success' }));
    }) as typeof globalThis.fetch;
    const src = new BitunixKlineSource({ fetch: fakeFetch, baseUrl: 'https://fapi.example.test' });
    const to = new Date('2026-11-16T11:30:00Z');
    const from = new Date(to.getTime() - 299 * ms);
    const bars = await src.klines('BTCUSDT', '15', from, to);
    expect(bars).toHaveLength(300);
    expect(bars[0]!.openTime).toEqual(from);
    expect(bars.at(-1)!.openTime).toEqual(to);
    expect(asked).toEqual([
      { endTime: to.getTime() + ms, limit: 200, interval: '15m' },
      { endTime: to.getTime() + ms - 200 * ms, limit: 100, interval: '15m' }
    ]);
    expect(src.requestCounts.kline).toBe(2);
  });
});
