// Lighter Step 2: public WebSocket (ticker + market_stats per market ID), the exchange-keyed cache
// join, staleness, reconnect with resubscription and fresh snapshots, and REST candles (alignment,
// closed bars only, paging, mainnet only). Frames below were captured from the live mainnet stream
// for market 92 (XAU) on 2026-11-17; a fake socket and fake fetch stand in for the network.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LighterKlineSource, parseLighterCandles } from '../src/market/lighterKlines';
import { LIGHTER_MAINNET } from '../src/market/lighterPublic';
import { LighterPriceStream, lighterMarketKey, type LighterStats, type LighterTicker } from '../src/market/lighterWs';
import { ExchangePriceCache } from '../src/market/priceCache';
import type { WsLike } from '../src/market/publicStream';

// Captured frames (trimmed to the fields TrendPilot reads, values unchanged).
const TICKER_SNAPSHOT = { channel: 'ticker:92', last_updated_at: 1794920147452161, nonce: 27947872569, ticker: { s: 'XAU', a: { price: '3862.05', size: '0.0032' }, b: { price: '3862.04', size: '0.0032' }, last_updated_at: 1794920147452161 }, timestamp: 1794920147509, type: 'subscribed/ticker' };
const TICKER_UPDATE = { channel: 'ticker:92', last_updated_at: 1794920152493578, nonce: 27947878661, ticker: { s: 'XAU', a: { price: '3862.05', size: '0.8872' }, b: { price: '3862.04', size: '0.0032' }, last_updated_at: 1794920152493578 }, timestamp: 1794920152495, type: 'update/ticker' };
const STATS_SNAPSHOT = { channel: 'market_stats:92', market_stats: { symbol: 'XAU', market_id: 92, index_price: '3859.36', mark_price: '3862.13', mid_price: '3862.05', best_ask_price: '3862.05', best_bid_price: '3862.04', last_trade_price: '3861.97' }, timestamp: 1794920147514, type: 'subscribed/market_stats' };
const INVALID_CHANNEL = { error: { code: 30005, message: 'Invalid Channel:  (marketId)' } };

class FakeWs implements WsLike {
  static all: FakeWs[] = [];
  readyState = 0;
  binaryType = 'blob';
  sent: Record<string, unknown>[] = [];
  onopen: WsLike['onopen'] = null;
  onmessage: WsLike['onmessage'] = null;
  onclose: WsLike['onclose'] = null;
  onerror: WsLike['onerror'] = null;
  constructor(readonly url: string) {
    FakeWs.all.push(this);
  }
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.readyState = 3;
  }
  open() {
    this.readyState = 1;
    this.onopen?.({});
  }
  recv(msg: unknown) {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
  drop() {
    this.readyState = 3;
    this.onclose?.({ code: 1006, reason: '' });
  }
  subscribed = () => this.sent.filter((m) => m.type === 'subscribe').map((m) => m.channel);
}

let tickers: LighterTicker[];
let stats: LighterStats[];
let logs: string[];
const make = () => new LighterPriceStream({ url: 'wss://mainnet.zklighter.elliot.ai/stream', factory: (u) => new FakeWs(u), onTicker: (t) => tickers.push(t), onStats: (s) => stats.push(s), log: (m) => logs.push(m), rand: () => 0.5 });

beforeEach(() => {
  vi.useFakeTimers({ now: new Date(1794920148000) });
  FakeWs.all = [];
  tickers = [];
  stats = [];
  logs = [];
});
afterEach(() => vi.useRealTimers());

describe('public WebSocket', () => {
  it('subscribes ticker and market_stats per market ID, never by symbol, and pings with {type:"ping"}', () => {
    const s = make();
    s.setSymbols(['92', 'XAU', 'XAUUSDT']);
    s.start();
    FakeWs.all[0]!.open();
    expect(FakeWs.all[0]!.url).toBe('wss://mainnet.zklighter.elliot.ai/stream');
    expect(FakeWs.all[0]!.subscribed()).toEqual(['ticker/92', 'market_stats/92']);
    expect(FakeWs.all[0]!.sent).toContainEqual({ type: 'ping' });
    s.stop();
  });

  it('keeps bid/ask (ticker, µs sequencer time → ms) apart from mark/index/last (market_stats, frame time)', () => {
    const s = make();
    s.setSymbols(['92']);
    s.start();
    const ws = FakeWs.all[0]!;
    ws.open();
    ws.recv({ type: 'connected' });
    ws.recv(TICKER_SNAPSHOT);
    ws.recv(STATS_SNAPSHOT);
    ws.recv(TICKER_UPDATE);
    expect(tickers.map((t) => [t.bid, t.ask, t.exchangeTimeMs, t.snapshot])).toEqual([
      ['3862.04', '3862.05', 1794920147452, true],
      ['3862.04', '3862.05', 1794920152493, false]
    ]);
    expect(stats).toEqual([expect.objectContaining({ marketId: '92', mark: '3862.13', index: '3859.36', last: '3861.97', exchangeTimeMs: 1794920147514, snapshot: true })]);
    s.stop();
  });

  it('skips frames with missing fields, other markets and older nonces; logs channel errors', () => {
    const s = make();
    s.setSymbols(['92']);
    s.start();
    const ws = FakeWs.all[0]!;
    ws.open();
    ws.recv(TICKER_UPDATE);
    ws.recv({ ...TICKER_SNAPSHOT, type: 'update/ticker' }); // older nonce on the same socket
    ws.recv({ ...TICKER_UPDATE, nonce: TICKER_UPDATE.nonce + 1, ticker: { ...TICKER_UPDATE.ticker, b: {} } }); // bid missing
    ws.recv({ ...TICKER_UPDATE, channel: 'ticker:1' }); // not subscribed
    ws.recv({ ...STATS_SNAPSHOT, market_stats: { ...STATS_SNAPSHOT.market_stats, mark_price: undefined } });
    ws.recv(INVALID_CHANNEL);
    expect(tickers).toHaveLength(1);
    expect(stats).toHaveLength(0);
    expect(s.skippedFrames).toBe(3);
    expect(s.errorsReceived).toBe(1);
    expect(logs.join('\n')).toMatch(/lighter error 30005/);
    s.stop();
  });

  it('reconnects with backoff, resubscribes and takes the new snapshot (nonce sequence restarts)', () => {
    const s = make();
    s.setSymbols(['92']);
    s.start();
    FakeWs.all[0]!.open();
    FakeWs.all[0]!.recv(TICKER_UPDATE);
    FakeWs.all[0]!.drop();
    expect(s.status()).toMatchObject({ state: 'CLOSED' });
    while (FakeWs.all.length < 2) vi.advanceTimersByTime(250);
    const ws2 = FakeWs.all[1]!;
    ws2.open();
    expect(ws2.subscribed()).toEqual(['ticker/92', 'market_stats/92']);
    ws2.recv(TICKER_SNAPSHOT); // lower nonce than before the drop: accepted as the new socket's snapshot
    expect(tickers.map((t) => t.snapshot)).toEqual([false, true]);
    expect(s.status()).toMatchObject({ state: 'OPEN', reconnects: 1, confirmed: ['92'] });
    s.stop();
  });

  it('unsubscribes a market that is no longer covered', () => {
    const s = make();
    s.setSymbols(['92', '1']);
    s.start();
    const ws = FakeWs.all[0]!;
    ws.open();
    s.setSymbols(['92']);
    expect(ws.sent.filter((m) => m.type === 'unsubscribe').map((m) => m.channel)).toEqual(['ticker/1', 'market_stats/1']);
    s.stop();
  });
});

describe('exchange-keyed cache join and staleness', () => {
  it('is keyed by exchange, environment and market ID, separate from MEXC and Bitunix XAU', () => {
    const cache = new ExchangePriceCache();
    const k = lighterMarketKey(92);
    expect(k).toBe('MAINNET/92');
    const at = new Date(1794920148000);
    cache.putBook('LIGHTER', k, { bid: '3862.04', ask: '3862.05', last: '3861.97', exchangeTimeMs: 1794920147452, receivedAt: at });
    cache.putMark('LIGHTER', k, { mark: '3862.13', index: '3859.36', exchangeTimeMs: 1794920147514, receivedAt: at });
    cache.putBook('BITUNIX', 'XAUUSDT', { bid: '3800', ask: '3801', last: '3800', exchangeTimeMs: 1, receivedAt: at });
    cache.putBook('MEXC', 'XAU_USDT', { bid: '3700', ask: '3701', last: '3700', exchangeTimeMs: 1, receivedAt: at });
    expect(cache.keys()).toEqual(['BITUNIX:XAUUSDT', 'LIGHTER:MAINNET/92', 'MEXC:XAU_USDT']);
    expect(cache.quote('LIGHTER', k, at)).toMatchObject({ state: 'FRESH', bid: '3862.04', ask: '3862.05', last: '3861.97', mark: '3862.13', index: '3859.36' });
  });

  it('turns STALE after the existing freshness limit and stays visible; a crossed book is INVALID', () => {
    const cache = new ExchangePriceCache();
    const k = lighterMarketKey(92);
    const at = new Date(1794920148000);
    cache.putBook('LIGHTER', k, { bid: '3862.04', ask: '3862.05', last: '3861.97', exchangeTimeMs: 1, receivedAt: at });
    cache.putMark('LIGHTER', k, { mark: '3862.13', index: null, exchangeTimeMs: 1, receivedAt: at });
    const later = new Date(at.getTime() + 20_000);
    expect(cache.quote('LIGHTER', k, later)).toMatchObject({ state: 'STALE', bid: '3862.04', mark: '3862.13' });
    cache.putBook('LIGHTER', k, { bid: '3863', ask: '3862', last: '3861.97', exchangeTimeMs: 2, receivedAt: later });
    cache.putMark('LIGHTER', k, { mark: '3862.5', index: null, exchangeTimeMs: 2, receivedAt: later });
    expect(cache.quote('LIGHTER', k, later).state).toBe('INVALID');
    // An older exchange time never replaces a newer one.
    expect(cache.putBook('LIGHTER', k, { bid: '1', ask: '2', last: '1', exchangeTimeMs: 1, receivedAt: later })).toBe(false);
  });
});

describe('REST candles', () => {
  const body = (rows: Record<string, unknown>[], r = '5m') => ({ code: 200, r, c: rows });
  const row = (t: number, c = 3861.97) => ({ t, o: 3861.72, h: 3862.11, l: 3861.71, c, v: 0.1486, V: 573.88, i: 40975343984 });

  it('parses aligned open times (ms) with numeric prices; refuses misaligned, zero or inconsistent rows', () => {
    expect(parseLighterCandles(body([row(1794920100000)]), '92', '5')).toEqual([{ openTime: new Date(1794920100000), open: '3861.72', high: '3862.11', low: '3861.71', close: '3861.97' }]);
    expect(() => parseLighterCandles(body([row(1794920100000 + 60_000)]), '92', '5')).toThrow(/not aligned to 5m/);
    expect(() => parseLighterCandles(body([{ ...row(1794920100000), c: undefined }]), '92', '5')).toThrow(/c missing/);
    expect(() => parseLighterCandles(body([{ ...row(1794920100000), h: 3800 }]), '92', '5')).toThrow(/high\/low inconsistent/);
    expect(() => parseLighterCandles(body([row(1794920100000)], '15m'), '92', '5')).toThrow(/resolution 15m returned/);
    expect(parseLighterCandles({ code: 200, r: '5m' }, '92', '5')).toEqual([]);
    expect(() => parseLighterCandles({ code: 400, message: 'bad' }, '92', '5')).toThrow(/bad/);
  });

  it('returns closed bars in [from, to] only (a forming bar after `to` is dropped), paging ≤ 500 per call, by market ID', async () => {
    const calls: URL[] = [];
    const five = 300_000;
    const to = 1794920100000 - five; // newest CLOSED open; 1794920100000 is still forming
    const from = to - 600 * five;
    const fetchImpl = (async (u: string | URL | Request) => {
      const url = new URL(String(u));
      if (url.pathname === '/') return new Response(JSON.stringify({ status: 200, network_id: 1 }));
      if (url.pathname === '/info') return new Response(JSON.stringify({ contract_address: LIGHTER_MAINNET.contractAddress }));
      calls.push(url);
      const s = Number(url.searchParams.get('start_timestamp'));
      const e = Number(url.searchParams.get('end_timestamp'));
      const rows = [];
      for (let t = s; t <= Math.min(e + five, 1794920100000); t += five) rows.push(row(t));
      return new Response(JSON.stringify(body(rows)));
    }) as typeof fetch;
    const src = new LighterKlineSource({ baseUrl: 'https://mainnet.zklighter.elliot.ai', fetch: fetchImpl });
    const bars = await src.klines('92', '5', new Date(from), new Date(to));
    expect(bars).toHaveLength(601);
    expect(bars[0]!.openTime.getTime()).toBe(from);
    expect(bars.at(-1)!.openTime.getTime()).toBe(to);
    expect(calls).toHaveLength(2);
    expect(calls.every((u) => u.searchParams.get('market_id') === '92' && u.searchParams.get('resolution') === '5m')).toBe(true);
    await expect(src.klines('XAU', '5', new Date(from), new Date(to))).rejects.toThrow(/not a Lighter market ID/);
  });

  it('refuses to read candles from an API that is not the Ethereum mainnet', async () => {
    const fetchImpl = (async (u: string | URL | Request) => {
      const url = new URL(String(u));
      if (url.pathname === '/') return new Response(JSON.stringify({ network_id: 466324 }));
      if (url.pathname === '/info') return new Response(JSON.stringify({ contract_address: '0x0000000000000000000000000000000000000001' }));
      return new Response(JSON.stringify(body([])));
    }) as typeof fetch;
    const src = new LighterKlineSource({ baseUrl: 'https://api.rh.lighter.xyz', fetch: fetchImpl });
    await expect(src.klines('92', '5', new Date(1794920100000 - 300_000), new Date(1794920100000 - 300_000))).rejects.toThrow(/not the Ethereum-based mainnet/);
  });
});
