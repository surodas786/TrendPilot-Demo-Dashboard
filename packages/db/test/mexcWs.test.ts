// MEXC public WebSocket ticker stream: subscription, push.ticker parsing, heartbeat, reconnect with
// backoff and resubscription. A fake socket stands in for the network; timers are faked.
import { gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { frameText, MexcTickerStream, parseWsTicker, type StreamTicker, type WsLike } from '../src/market/mexcWs';

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
  // test drivers
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
  subs = () => this.sent.filter((m) => m.method === 'sub.ticker').map((m) => (m.param as { symbol: string }).symbol);
}

const push = (symbol: string, bid: number, ts: number) => ({
  channel: 'push.ticker',
  symbol,
  ts,
  data: { symbol, bid1: bid, ask1: bid + 0.1, fairPrice: bid + 0.05, lastPrice: bid, indexPrice: bid, timestamp: ts, fundingRate: 0.0001 }
});

let got: StreamTicker[];
let offsets: number[];
let logs: string[];
const make = (o: Partial<ConstructorParameters<typeof MexcTickerStream>[0]> = {}) =>
  new MexcTickerStream({ factory: (u) => new FakeWs(u), onTicker: (t) => got.push(t), onClockSample: (ms) => offsets.push(ms), log: (m) => logs.push(m), rand: () => 0.5, ...o });

beforeEach(() => {
  vi.useFakeTimers({ now: new Date('2026-11-09T10:00:00Z') });
  FakeWs.all = [];
  got = [];
  offsets = [];
  logs = [];
});
afterEach(() => vi.useRealTimers());

describe('MEXC public WebSocket ticker stream', () => {
  it('connects to the public edge endpoint and subscribes sub.ticker for every wanted contract; no login is sent', () => {
    const s = make();
    s.setSymbols(['BTC_USDT', 'ETH_USDT', 'not-a-symbol']);
    s.start();
    const ws = FakeWs.all[0]!;
    expect(ws.url).toBe('wss://contract.mexc.com/edge');
    ws.open();
    expect(ws.subs()).toEqual(['BTC_USDT', 'ETH_USDT']);
    expect(ws.sent.some((m) => m.method === 'ping')).toBe(true);
    expect(ws.sent.some((m) => String(m.method).includes('login') || 'apiKey' in ((m.param as object) ?? {}))).toBe(false);
    expect(s.connected()).toBe(true);
    s.stop();
  });

  it('delivers push.ticker as a parsed quote with the exchange timestamp and receipt time', () => {
    const s = make();
    s.setSymbols(['BTC_USDT']);
    s.start();
    const ws = FakeWs.all[0]!;
    ws.open();
    ws.recv({ channel: 'rs.sub.ticker', data: 'success', ts: 1 });
    ws.recv(push('BTC_USDT', 74780, Date.parse('2026-11-09T09:59:59.500Z')));
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ exchangeSymbol: 'BTC_USDT', bid: '74780', ask: '74780.1', mark: '74780.05', last: '74780', exchangeTimeMs: Date.parse('2026-11-09T09:59:59.500Z') });
    expect(got[0]!.receivedAt.toISOString()).toBe('2026-11-09T10:00:00.000Z');
    expect(s.status()).toMatchObject({ confirmed: ['BTC_USDT'], subscribeAcks: 1, tickersReceived: 1 });
    expect(logs.some((l) => l.includes('first push.ticker BTC_USDT'))).toBe(true);
    // A push for a contract we do not want is dropped.
    ws.recv(push('DOGE_USDT', 0.2, Date.now()));
    expect(got).toHaveLength(1);
    s.stop();
  });

  it('pings every 15 s and turns each pong into a clock sample', () => {
    const s = make();
    s.start();
    const ws = FakeWs.all[0]!;
    ws.open();
    vi.advanceTimersByTime(200);
    // sent at t0, received at t0+200 (midpoint t0+100); exchange says t0+500 → exchange 400 ms ahead
    ws.recv({ channel: 'pong', data: Date.now() + 300 });
    expect(offsets).toEqual([400]);
    vi.advanceTimersByTime(15_000);
    expect(ws.sent.filter((m) => m.method === 'ping')).toHaveLength(2);
    s.stop();
  });

  it('a dropped socket reconnects with backoff and resubscribes every contract', () => {
    const s = make();
    s.setSymbols(['BTC_USDT', 'ETH_USDT']);
    s.start();
    FakeWs.all[0]!.open();
    FakeWs.all[0]!.recv(push('BTC_USDT', 1, Date.now()));
    FakeWs.all[0]!.drop();
    expect(s.connected()).toBe(false);
    expect(s.status().state).toBe('CLOSED');
    vi.advanceTimersByTime(999);
    expect(FakeWs.all).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(FakeWs.all).toHaveLength(2); // first retry after ~1 s
    FakeWs.all[1]!.open();
    expect(FakeWs.all[1]!.subs()).toEqual(['BTC_USDT', 'ETH_USDT']);
    expect(s.status().reconnects).toBe(1);
    expect(s.status().confirmed).toEqual([]); // freshness is re-earned on the new socket
    s.stop();
  });

  it('repeated failed connections back off exponentially (capped)', () => {
    const s = make();
    s.start();
    const delays: number[] = [];
    for (let i = 0; i < 7; i++) {
      const ws = FakeWs.all.at(-1)!;
      ws.drop(); // fails before any message
      delays.push(Date.parse(s.status().nextReconnectAt!) - Date.now());
      vi.advanceTimersByTime(delays.at(-1)!);
    }
    expect(delays).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000]);
    s.stop();
  });

  it('an open socket that goes silent is closed and replaced; a connect that hangs is abandoned', () => {
    const s = make();
    s.setSymbols(['BTC_USDT']);
    s.start();
    const ws = FakeWs.all[0]!;
    ws.open();
    vi.advanceTimersByTime(45_000); // no pong, no ticker
    expect(ws.closed).not.toBeNull();
    expect(s.status().lastError).toMatch(/no message/);
    vi.advanceTimersByTime(1_000);
    expect(FakeWs.all).toHaveLength(2);
    // second socket never opens
    vi.advanceTimersByTime(10_000);
    expect(FakeWs.all[1]!.closed).not.toBeNull();
    s.stop();
  });

  it('setSymbols subscribes additions and unsubscribes removals on the live socket', () => {
    const s = make();
    s.setSymbols(['BTC_USDT']);
    s.start();
    const ws = FakeWs.all[0]!;
    ws.open();
    vi.advanceTimersByTime(5_000);
    s.setSymbols(['BTC_USDT', 'ETH_USDT']);
    expect(s.subscribedSince('BTC_USDT')!.toISOString()).toBe('2026-11-09T10:00:00.000Z');
    expect(s.subscribedSince('ETH_USDT')!.toISOString()).toBe('2026-11-09T10:00:05.000Z'); // its own grace start
    s.setSymbols(['ETH_USDT']);
    expect(s.subscribedSince('BTC_USDT')).toBeNull();
    expect(ws.sent.filter((m) => m.method !== 'ping').map((m) => `${m.method} ${(m.param as { symbol: string }).symbol}`)).toEqual(['sub.ticker BTC_USDT', 'sub.ticker ETH_USDT', 'unsub.ticker BTC_USDT']);
    s.stop();
  });

  it('forceDisconnect (drill) recovers through the normal reconnect path', () => {
    const s = make();
    s.setSymbols(['BTC_USDT']);
    s.start();
    FakeWs.all[0]!.open();
    FakeWs.all[0]!.recv(push('BTC_USDT', 1, Date.now()));
    s.forceDisconnect('drill');
    expect(FakeWs.all[0]!.closed?.code).toBe(4000);
    vi.advanceTimersByTime(1_000);
    FakeWs.all[1]!.open();
    FakeWs.all[1]!.recv(push('BTC_USDT', 2, Date.now()));
    expect(got.map((t) => t.bid)).toEqual(['1', '2']);
    s.stop();
    expect(s.status().state).toBe('STOPPED');
    vi.advanceTimersByTime(60_000);
    expect(FakeWs.all).toHaveLength(2); // no reconnect after stop
  });

  it('parses text, gzip and malformed frames safely', () => {
    expect(frameText('{"a":1}')).toBe('{"a":1}');
    expect(frameText(new Uint8Array(gzipSync(Buffer.from('{"b":2}'))))).toBe('{"b":2}');
    expect(() => parseWsTicker({ channel: 'push.ticker', data: { symbol: 'BTC_USDT', bid1: 1 } }, new Date())).toThrow(/ask1|timestamp|missing/);
    const s = make();
    s.setSymbols(['BTC_USDT']);
    s.start();
    FakeWs.all[0]!.open();
    FakeWs.all[0]!.recv('not json');
    FakeWs.all[0]!.recv({ channel: 'push.ticker', symbol: 'BTC_USDT', data: { symbol: 'BTC_USDT', bid1: 'x' } });
    expect(got).toHaveLength(0);
    expect(s.connected()).toBe(true);
    s.stop();
  });
});
