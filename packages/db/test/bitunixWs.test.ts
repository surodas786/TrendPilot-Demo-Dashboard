// Bitunix public WebSocket: frames captured from the live server, ticker (book) and price (mark)
// updates handled separately, unknown symbols, ping/pong clock samples, batched subscription,
// reconnect with backoff and resubscription, silence detection, and the exchange-keyed price cache
// that keeps Bitunix and MEXC quotes apart. A fake socket stands in for the network.
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BitunixPriceStream, isEmptyPush, parseBitunixPrice, parseBitunixTickers, type BitunixBookTicker, type BitunixMarkPrice } from '../src/market/bitunixWs';
import type { WsLike } from '../src/market/publicStream';
import { ExchangePriceCache } from '../src/market/priceCache';

const F = JSON.parse(readFileSync(new URL('./fixtures/bitunix-public/ws-frames.json', import.meta.url), 'utf8')) as Record<string, Record<string, unknown>>;

class FakeWs implements WsLike {
  static all: FakeWs[] = [];
  readyState = 0;
  binaryType = 'blob';
  sent: Record<string, unknown>[] = [];
  closed: { code?: number; reason?: string } | null = null;
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
  close(code?: number, reason?: string) {
    this.closed = { code, reason };
    this.readyState = 3;
  }
  open() {
    this.readyState = 1;
    this.onopen?.({});
  }
  recv(msg: unknown) {
    this.onmessage?.({ data: typeof msg === 'string' ? msg : JSON.stringify(msg) });
  }
  drop(code = 1006) {
    this.readyState = 3;
    this.onclose?.({ code, reason: '' });
  }
  subscribes = () => this.sent.filter((m) => m.op === 'subscribe').map((m) => (m.args as { symbol: string; ch: string }[]).map((a) => `${a.symbol}/${a.ch}`));
}

const tickers = (s: string, bid: number, ts: number) => ({ ch: 'tickers', ts, data: [{ s, la: String(bid + 0.05), bd: String(bid), ak: String(bid + 0.1), o: '1', h: '1', l: '1', b: '1', q: '1', r: '0', bv: '1', av: '1' }] });
const price = (symbol: string, mark: number, ts: number) => ({ ch: 'price', symbol, ts, data: { mp: String(mark), ip: String(mark), fr: '0.0001', ft: '2026-11-16T08:00:00Z', nft: '2026-11-16T16:00:00Z' } });

let books: BitunixBookTicker[];
let marks: BitunixMarkPrice[];
let unsupported: string[];
let offsets: number[];
let logs: string[];
const make = () =>
  new BitunixPriceStream({ factory: (u) => new FakeWs(u), onTicker: (t) => books.push(t), onPrice: (p) => marks.push(p), onUnsupported: (s) => unsupported.push(s), onClockSample: (ms) => offsets.push(ms), log: (m) => logs.push(m), rand: () => 0.5 });

beforeEach(() => {
  vi.useFakeTimers({ now: new Date('2026-11-16T10:00:00Z') });
  FakeWs.all = [];
  books = [];
  marks = [];
  unsupported = [];
  offsets = [];
  logs = [];
});
afterEach(() => vi.useRealTimers());

describe('Bitunix WebSocket frames (captured from the live server)', () => {
  const at = new Date('2026-11-16T10:00:00Z');
  it('tickers → best bid / ask / last; price → mark / index; each on its own', () => {
    expect(parseBitunixTickers(F.tickersBTC!, at)).toEqual({ tickers: [{ exchangeSymbol: 'BTCUSDT', bid: '64271.8', ask: '64271.9', last: '64277.6', exchangeTimeMs: 1794820330588, receivedAt: at }], errors: [] });
    expect(parseBitunixPrice(F.priceXAU!, at)).toEqual({ exchangeSymbol: 'XAUUSDT', mark: '3868.16', index: '3868.12', fundingRate: '0.003608', nextFundingTime: '2026-11-16T12:00:00Z', exchangeTimeMs: 1794820330588, receivedAt: at });
  });

  it('rejects malformed rows without dropping the good ones', () => {
    const mixed = { ch: 'tickers', ts: 1794820330588, data: [{ s: 'BTCUSDT', la: '1', bd: '2', ak: '1' }, { s: 'XAUUSDT', la: '3868', bd: '3867.9', ak: '3868' }, { s: 'bad', la: '1', bd: '1', ak: '1' }, { s: 'ETHUSDT', la: '1', bd: 'x', ak: '1' }] };
    const r = parseBitunixTickers(mixed, at);
    expect(r.tickers.map((t) => t.exchangeSymbol)).toEqual(['XAUUSDT']);
    expect(r.errors).toEqual([expect.stringMatching(/crossed book/), expect.stringMatching(/bad symbol/), expect.stringMatching(/bd .*not a number/)]);
    expect(() => parseBitunixPrice({ ch: 'price', symbol: 'BTCUSDT', ts: 1794820330588, data: { mp: '0' } }, at)).toThrow(/mark price.*positive/);
    expect(() => parseBitunixPrice({ ch: 'price', symbol: 'BTCUSDT', ts: 1794820330, data: { mp: '1' } }, at)).toThrow(/millisecond/);
    expect(isEmptyPush(F.unknownSymbol!)).toBe(true);
    expect(isEmptyPush(F.priceBTC!)).toBe(false);
  });
});

describe('Bitunix public price stream', () => {
  it('connects to the public endpoint and subscribes tickers + price for every symbol in ONE message; no login', () => {
    const s = make();
    s.setSymbols(['BTCUSDT', 'XAUUSDT', 'BTC_USDT', 'not-a-symbol']);
    s.start();
    const ws = FakeWs.all[0]!;
    expect(ws.url).toBe('wss://fapi.bitunix.com/public/');
    ws.open();
    expect(ws.subscribes()).toEqual([['BTCUSDT/tickers', 'BTCUSDT/price', 'XAUUSDT/tickers', 'XAUUSDT/price']]);
    expect(ws.sent.find((m) => m.op === 'ping')).toEqual({ op: 'ping', ping: Math.floor(Date.now() / 1000) });
    expect(ws.sent.some((m) => m.op === 'login' || JSON.stringify(m).includes('apiKey'))).toBe(false);
    s.stop();
  });

  it('delivers ticker and price updates separately; a symbol is confirmed only after both', () => {
    const s = make();
    s.setSymbols(['BTCUSDT']);
    s.start();
    const ws = FakeWs.all[0]!;
    ws.open();
    ws.recv(F.connect);
    ws.recv(F.tickerBTC); // single-symbol `ticker` channel: no bid/ask, not used
    ws.recv(F.tickersBTC);
    expect(books).toHaveLength(1);
    expect(marks).toHaveLength(0);
    expect(s.status()).toMatchObject({ tickerConfirmed: ['BTCUSDT'], priceConfirmed: [], confirmed: [] });
    ws.recv(F.priceBTC);
    ws.recv(F.priceXAU); // not wanted: dropped
    expect(marks.map((m) => m.exchangeSymbol)).toEqual(['BTCUSDT']);
    expect(s.status()).toMatchObject({ confirmed: ['BTCUSDT'], tickersReceived: 1, pricesReceived: 1 });
    s.stop();
  });

  it('an empty push for a wanted symbol is reported as unsupported, once', () => {
    const s = make();
    s.setSymbols(['NOPEUSDT', 'BTCUSDT']);
    s.start();
    const ws = FakeWs.all[0]!;
    ws.open();
    ws.recv({ ...F.unknownSymbol, ch: 'tickers' });
    ws.recv({ ...F.unknownSymbol, ch: 'price' });
    expect(unsupported).toEqual(['NOPEUSDT']);
    expect(s.status().unsupported).toEqual(['NOPEUSDT']);
    expect(s.status().lastError).toMatch(/NOPEUSDT .*unknown or unsupported/);
    expect(books).toHaveLength(0);
    s.stop();
  });

  it('turns each pong (server ms in `ts`) into a clock sample and pings every 15 s', () => {
    const s = make();
    s.start();
    const ws = FakeWs.all[0]!;
    ws.open();
    vi.advanceTimersByTime(200);
    ws.recv({ op: 'ping', ts: Date.now() + 300, pong: 1, ping: 1 });
    expect(offsets).toEqual([400]);
    vi.advanceTimersByTime(15_000);
    expect(ws.sent.filter((m) => m.op === 'ping')).toHaveLength(2);
    s.stop();
  });

  it('a dropped socket reconnects with backoff and resubscribes; freshness is re-earned', () => {
    const s = make();
    s.setSymbols(['BTCUSDT', 'XAUUSDT']);
    s.start();
    FakeWs.all[0]!.open();
    FakeWs.all[0]!.recv(tickers('BTCUSDT', 1, Date.now()));
    FakeWs.all[0]!.recv(price('BTCUSDT', 1, Date.now()));
    expect(s.status().confirmed).toEqual(['BTCUSDT']);
    FakeWs.all[0]!.drop();
    expect(s.connected()).toBe(false);
    vi.advanceTimersByTime(1_000);
    expect(FakeWs.all).toHaveLength(2);
    FakeWs.all[1]!.open();
    expect(FakeWs.all[1]!.subscribes()).toEqual([['BTCUSDT/tickers', 'BTCUSDT/price', 'XAUUSDT/tickers', 'XAUUSDT/price']]);
    expect(s.status()).toMatchObject({ reconnects: 1, confirmed: [], tickerConfirmed: [], priceConfirmed: [] });
    s.stop();
    vi.advanceTimersByTime(60_000);
    expect(FakeWs.all).toHaveLength(2); // no reconnect after stop
  });

  it('a silent socket is replaced; setSymbols subscribes additions and unsubscribes removals', () => {
    const s = make();
    s.setSymbols(['BTCUSDT']);
    s.start();
    const ws = FakeWs.all[0]!;
    ws.open();
    s.setSymbols(['BTCUSDT', 'XAUUSDT']);
    s.setSymbols(['XAUUSDT']);
    expect(ws.sent.filter((m) => m.op !== 'ping').map((m) => `${m.op} ${(m.args as { symbol: string; ch: string }[]).map((a) => `${a.symbol}/${a.ch}`).join(' ')}`)).toEqual([
      'subscribe BTCUSDT/tickers BTCUSDT/price',
      'subscribe XAUUSDT/tickers XAUUSDT/price',
      'unsubscribe BTCUSDT/tickers BTCUSDT/price'
    ]);
    expect(s.subscribedSince('XAUUSDT')).not.toBeNull();
    expect(s.subscribedSince('BTCUSDT')).toBeNull();
    vi.advanceTimersByTime(45_000); // nothing received
    expect(ws.closed).not.toBeNull();
    expect(s.status().lastError).toMatch(/no message/);
    s.stop();
  });

  it('unreadable frames are logged and ignored', () => {
    const s = make();
    s.setSymbols(['BTCUSDT']);
    s.start();
    FakeWs.all[0]!.open();
    FakeWs.all[0]!.recv('not json');
    FakeWs.all[0]!.recv('[1,2]');
    FakeWs.all[0]!.recv({ ch: 'price', symbol: 'BTCUSDT', ts: Date.now(), data: { mp: 'x' } });
    expect(marks).toHaveLength(0);
    expect(s.connected()).toBe(true);
    expect(logs.filter((l) => /unreadable frame|not a number/.test(l))).toHaveLength(3);
    s.stop();
  });
});

describe('exchange-keyed price cache', () => {
  const t0 = new Date('2026-11-16T10:00:00Z');
  const later = (ms: number) => new Date(t0.getTime() + ms);

  it('Bitunix and MEXC prices for the same contract never overwrite each other', () => {
    const c = new ExchangePriceCache();
    c.putBook('BITUNIX', 'BTCUSDT', { bid: '64271.8', ask: '64271.9', last: '64277.6', exchangeTimeMs: 1, receivedAt: t0 });
    c.putMark('BITUNIX', 'BTCUSDT', { mark: '64282.1', index: '64316.6', exchangeTimeMs: 1, receivedAt: t0 });
    // Same symbol string on MEXC (a deliberate collision test) and MEXC's own format.
    c.putBook('MEXC', 'BTCUSDT', { bid: '1', ask: '2', last: '1.5', exchangeTimeMs: 2, receivedAt: t0 });
    c.putMark('MEXC', 'BTCUSDT', { mark: '1.5', index: null, exchangeTimeMs: 2, receivedAt: t0 });
    c.putBook('MEXC', 'BTC_USDT', { bid: '64260', ask: '64260.1', last: '64260', exchangeTimeMs: 2, receivedAt: t0 });
    expect(c.quote('BITUNIX', 'BTCUSDT', t0)).toMatchObject({ state: 'FRESH', bid: '64271.8', mark: '64282.1' });
    expect(c.quote('MEXC', 'BTCUSDT', t0)).toMatchObject({ state: 'FRESH', bid: '1', mark: '1.5' });
    expect(c.quote('MEXC', 'BTC_USDT', t0)).toMatchObject({ state: 'INCOMPLETE', bid: '64260', mark: null });
    expect(c.keys()).toEqual(['BITUNIX:BTCUSDT', 'MEXC:BTCUSDT', 'MEXC:BTC_USDT']);
    c.forget('MEXC', 'BTCUSDT');
    expect(c.quote('BITUNIX', 'BTCUSDT', t0).state).toBe('FRESH');
  });

  it('needs both sides, each fresh; the older receipt time is the quote time', () => {
    const c = new ExchangePriceCache(15_000);
    expect(c.quote('BITUNIX', 'XAUUSDT', t0)).toMatchObject({ state: 'MISSING' });
    c.putMark('BITUNIX', 'XAUUSDT', { mark: '3868.16', index: '3868.12', exchangeTimeMs: 10, receivedAt: t0 });
    expect(c.quote('BITUNIX', 'XAUUSDT', t0)).toMatchObject({ state: 'INCOMPLETE', problem: 'no bid/ask yet' });
    c.putBook('BITUNIX', 'XAUUSDT', { bid: '3868.1', ask: '3868.2', last: '3868.16', exchangeTimeMs: 10, receivedAt: later(5_000) });
    expect(c.quote('BITUNIX', 'XAUUSDT', later(5_000))).toMatchObject({ state: 'FRESH', asOf: t0 });
    // The mark side stops updating: the quote goes stale even though bid/ask keep arriving.
    c.putBook('BITUNIX', 'XAUUSDT', { bid: '3868.1', ask: '3868.2', last: '3868.16', exchangeTimeMs: 20, receivedAt: later(16_000) });
    expect(c.quote('BITUNIX', 'XAUUSDT', later(16_000))).toMatchObject({ state: 'STALE', problem: 'mark 16 s old' });
  });

  it('an older exchange timestamp never replaces a newer one; a crossed book is INVALID', () => {
    const c = new ExchangePriceCache();
    expect(c.putMark('BITUNIX', 'BTCUSDT', { mark: '2', index: null, exchangeTimeMs: 20, receivedAt: t0 })).toBe(true);
    expect(c.putMark('BITUNIX', 'BTCUSDT', { mark: '1', index: null, exchangeTimeMs: 10, receivedAt: t0 })).toBe(false);
    c.putBook('BITUNIX', 'BTCUSDT', { bid: '3', ask: '2', last: '2', exchangeTimeMs: 20, receivedAt: t0 });
    expect(c.quote('BITUNIX', 'BTCUSDT', t0)).toMatchObject({ state: 'INVALID', mark: '2', problem: expect.stringMatching(/crossed/) });
  });

  it('stream → cache: a Bitunix stream fills only BITUNIX keys', () => {
    const c = new ExchangePriceCache();
    const s = new BitunixPriceStream({
      factory: (u) => new FakeWs(u),
      onTicker: (t) => c.putBook('BITUNIX', t.exchangeSymbol, t),
      onPrice: (p) => c.putMark('BITUNIX', p.exchangeSymbol, p),
      rand: () => 0.5
    });
    s.setSymbols(['BTCUSDT']);
    s.start();
    FakeWs.all[0]!.open();
    FakeWs.all[0]!.recv(tickers('BTCUSDT', 64000, Date.now()));
    FakeWs.all[0]!.recv(price('BTCUSDT', 64000.05, Date.now()));
    expect(c.keys()).toEqual(['BITUNIX:BTCUSDT']);
    expect(c.quote('BITUNIX', 'BTCUSDT', new Date())).toMatchObject({ state: 'FRESH', bid: '64000', ask: '64000.1', last: '64000.05', mark: '64000.05' });
    expect(c.quote('MEXC', 'BTCUSDT', new Date()).state).toBe('MISSING');
    s.stop();
  });
});
