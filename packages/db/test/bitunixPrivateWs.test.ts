// Bitunix private WebSocket: the separate login signature (Unix SECONDS), login success / failure
// (failure frame captured from the live server), login timeout, reconnect + re-login, the channel
// subscription after login (tpsl is automatic), event parsing per channel, and that no key,
// signature, nonce or login frame ever reaches a log line.
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bitunixTimeMs, BitunixPrivateStream, buildBitunixLogin, parseBitunixPrivateFrame, signBitunixWsLogin, type BitunixPrivateEvent } from '../src/live/bitunixPrivateWs';
import { signBitunix } from '../src/live/bitunixPrivate';
import type { WsLike } from '../src/market/publicStream';

const OBS = JSON.parse(readFileSync(new URL('./fixtures/bitunix-private/ws-observed.json', import.meta.url), 'utf8')) as Record<string, Record<string, unknown>>;
const CREDS = { apiKey: 'yourApiKey', secretKey: 'yourSecretKey' };

class FakeWs implements WsLike {
  static all: FakeWs[] = [];
  readyState = 0;
  binaryType = 'blob';
  raw: string[] = [];
  closed: { code?: number } | null = null;
  onopen: WsLike['onopen'] = null;
  onmessage: WsLike['onmessage'] = null;
  onclose: WsLike['onclose'] = null;
  onerror: WsLike['onerror'] = null;
  constructor(readonly url: string) {
    FakeWs.all.push(this);
  }
  get sent() {
    return this.raw.map((r) => JSON.parse(r) as Record<string, unknown>);
  }
  send(d: string) {
    this.raw.push(d);
  }
  close(code?: number) {
    this.closed = { code };
    this.readyState = 3;
  }
  open() {
    this.readyState = 1;
    this.onopen?.({});
  }
  recv(m: unknown) {
    this.onmessage?.({ data: typeof m === 'string' ? m : JSON.stringify(m) });
  }
  drop() {
    this.readyState = 3;
    this.onclose?.({ code: 1006 });
  }
  logins = () => this.sent.filter((m) => m.op === 'login');
}

let events: BitunixPrivateEvent[];
let logs: string[];
let ready: number;
let authFailed: string[];
const make = (o: { loginTimeoutMs?: number } = {}) =>
  new BitunixPrivateStream({
    factory: (u) => new FakeWs(u),
    credentials: () => CREDS,
    onEvent: (e) => events.push(e),
    onReady: () => (ready += 1),
    onAuthFailed: (m) => authFailed.push(m),
    log: (m) => logs.push(m),
    rand: () => 0.5,
    ...o
  });
const loginOk = { op: 'login', data: { result: true } };
const SEC = Math.floor(Date.parse('2026-11-16T10:00:00.750Z') / 1000);

beforeEach(() => {
  vi.useFakeTimers({ now: new Date('2026-11-16T10:00:00.750Z') });
  FakeWs.all = [];
  events = [];
  logs = [];
  ready = 0;
  authFailed = [];
});
afterEach(() => vi.useRealTimers());

describe('Bitunix WebSocket login signature', () => {
  it('matches a reference vector computed from the docs’ Python snippet (seconds, nonce + ts + apiKey)', () => {
    // Python: sha256(sha256(nonce + str(ts) + api_key) + secret_key), ts = 1747402389 (seconds)
    expect(signBitunixWsLogin({ nonce: 'o9jnhu8ijko2nbhy36fgt0mnjuyhgtsh', timestampSec: 1747402389, ...CREDS })).toBe('a3bfb87edfc362b67c66042164e4321715b063d31cfb7b8bb44fbcaffd2ea44c');
  });

  it('the login frame carries Unix SECONDS, while the REST signer keeps milliseconds', () => {
    const f = buildBitunixLogin(CREDS, Date.parse('2026-11-16T10:00:00.750Z'), 'n0nce');
    expect(f).toEqual({ op: 'login', args: [{ apiKey: 'yourApiKey', timestamp: SEC, nonce: 'n0nce', sign: signBitunixWsLogin({ nonce: 'n0nce', timestampSec: SEC, ...CREDS }) }] });
    // Not the REST formula (which also hashes query params and body, with a ms timestamp).
    expect(f.args[0].sign).not.toBe(signBitunix({ nonce: 'n0nce', timestamp: `${SEC}750`, apiKey: CREDS.apiKey, secretKey: CREDS.secretKey, queryParams: '', body: '' }));
  });
});

describe('Bitunix private stream', () => {
  it('logs in on open, then subscribes balance/order/position in ONE message (tpsl is automatic)', () => {
    const s = make();
    s.start();
    const ws = FakeWs.all[0]!;
    expect(ws.url).toBe('wss://fapi.bitunix.com/private/');
    ws.open();
    ws.recv(OBS.connect);
    expect(ws.logins()).toHaveLength(1);
    expect((ws.logins()[0]!.args as { timestamp: number }[])[0]!.timestamp).toBe(SEC);
    expect(s.authenticated()).toBe(false);
    ws.recv(loginOk);
    expect(s.authenticated()).toBe(true);
    expect(ready).toBe(1);
    expect(ws.sent.filter((m) => m.op === 'subscribe')).toEqual([{ op: 'subscribe', args: [{ ch: 'balance' }, { ch: 'order' }, { ch: 'position' }] }]);
    expect(s.status()).toMatchObject({ auth: 'AUTHENTICATED', state: 'OPEN' });
    s.stop();
  });

  it('a rejected login (frame captured from Bitunix) stops the stream: no retry loop with a bad key', () => {
    const s = make();
    s.start();
    FakeWs.all[0]!.open();
    FakeWs.all[0]!.recv(OBS.loginFailed);
    expect(authFailed).toEqual(['invalid params，Authorize: Token invalid']);
    expect(s.status()).toMatchObject({ auth: 'AUTH_FAILED', state: 'STOPPED', authError: 'invalid params，Authorize: Token invalid' });
    expect(FakeWs.all[0]!.closed).not.toBeNull();
    vi.advanceTimersByTime(120_000);
    expect(FakeWs.all).toHaveLength(1); // never reconnected
    expect(ready).toBe(0);
  });

  it('no login answer → the socket is dropped and the normal backoff retries the login', () => {
    const s = make({ loginTimeoutMs: 5_000 });
    s.start();
    FakeWs.all[0]!.open();
    vi.advanceTimersByTime(5_000);
    expect(FakeWs.all[0]!.closed).not.toBeNull();
    expect(s.status().lastError).toMatch(/no login answer/);
    vi.advanceTimersByTime(1_000);
    FakeWs.all[1]!.open();
    expect(FakeWs.all[1]!.logins()).toHaveLength(1);
    FakeWs.all[1]!.recv(loginOk);
    expect(ready).toBe(1);
    s.stop();
  });

  it('every reconnect logs in again and signals ready again (so REST reconciles the gap)', () => {
    const s = make();
    s.start();
    FakeWs.all[0]!.open();
    FakeWs.all[0]!.recv(loginOk);
    FakeWs.all[0]!.drop();
    expect(s.status().auth).toBe('DISCONNECTED');
    vi.advanceTimersByTime(1_000);
    FakeWs.all[1]!.open();
    FakeWs.all[1]!.recv(loginOk);
    expect(ready).toBe(2);
    expect(s.status()).toMatchObject({ reconnects: 1, auth: 'AUTHENTICATED' });
    s.stop();
  });

  it('a silent session (no pong) is replaced; pongs keep a quiet account alive', () => {
    const s = make();
    s.start();
    const ws = FakeWs.all[0]!;
    ws.open();
    ws.recv(loginOk);
    for (let i = 0; i < 4; i++) {
      vi.advanceTimersByTime(15_000);
      ws.recv(OBS.pong);
    }
    expect(ws.closed).toBeNull();
    vi.advanceTimersByTime(45_000);
    expect(ws.closed).not.toBeNull();
    expect(s.status().lastError).toMatch(/no message/);
    s.stop();
  });

  it('account pushes before login are ignored; after login each channel is parsed', () => {
    const s = make();
    s.start();
    const ws = FakeWs.all[0]!;
    ws.open();
    const pos = { ch: 'position', ts: 1794823201000, data: { event: 'OPEN', positionId: '9007199254740993', symbol: 'BTCUSDT', side: 'LONG', qty: '0.0010', positionMode: 'HEDGE', marginMode: 'ISOLATION', leverage: '10', margin: '6.4', ctime: '2026-11-16T10:00:01.123456789Z', realizedPNL: '0', unrealizedPNL: '0.01', funding: '0', fee: '0.0384' } };
    ws.recv(pos);
    expect(events).toHaveLength(0);
    ws.recv(loginOk);
    ws.recv(pos);
    ws.recv({ ch: 'tpsl', ts: 1794823202000, data: { event: 'CLOSE', status: 'FILLED', orderId: '777', positionId: '9007199254740993', symbol: 'BTCUSDT', side: 'SELL', ctime: '2026-11-16T10:00:02.5Z', slPrice: '60000', slQty: '0.001' } });
    ws.recv({ ch: 'order', ts: 1794823203000, data: { event: 'UPDATE', orderId: '888', clientId: 'tp-abc', symbol: 'BTCUSDT', side: 'SELL', type: 'MARKET', orderStatus: 'FILLED', qty: '0.001', dealAmount: '0.001', averagePrice: '60000', fee: '0.036', ctime: '2026-11-16T10:00:03Z', mtime: '2026-11-16T10:00:03.000000001Z' } });
    ws.recv({ ch: 'balance', ts: 1794823204000, data: { coin: 'USDT', available: '100.123456789', frozen: '0', margin: '6.4' } });
    expect(events.map((e) => e.channel)).toEqual(['position', 'tpsl', 'order', 'balance']);
    expect(events[0]).toMatchObject({ positionId: '9007199254740993', side: 'LONG', qty: '0.001', leverage: 10, ctimeMs: Date.parse('2026-11-16T10:00:01.123Z') });
    expect(events[1]).toMatchObject({ event: 'CLOSE', status: 'FILLED', orderId: '777', ctimeMs: Date.parse('2026-11-16T10:00:02.500Z') });
    expect(events[2]).toMatchObject({ status: 'FILLED', origin: 'TRENDPILOT', mtimeMs: Date.parse('2026-11-16T10:00:03.000Z') });
    expect(events[3]).toMatchObject({ coin: 'USDT', available: '100.123456789' });
    expect(events.map((e) => e.seq)).toEqual([1, 2, 3, 4]);
    expect(s.status().events).toEqual({ position: 1, tpsl: 1, order: 1, balance: 1 });
    s.stop();
  });

  it('never logs the API key, secret, signature, nonce or the login frame', () => {
    const s = make();
    s.start();
    const ws = FakeWs.all[0]!;
    ws.open();
    ws.recv(OBS.loginFailed);
    const login = ws.raw.find((r) => r.includes('"op":"login"'))!;
    const sign = (JSON.parse(login).args[0] as { sign: string }).sign;
    const nonce = (JSON.parse(login).args[0] as { nonce: string }).nonce;
    const all = logs.join('\n');
    for (const secret of ['yourApiKey', 'yourSecretKey', sign, nonce, '52f6ba308131ccbbf89a12ab16e4b9c6', login]) expect(all).not.toContain(secret);
    expect(logs).toContain('ws: → login');
  });

  it('malformed pushes are counted and skipped; times parse from ISO nanoseconds or ms', () => {
    const s = make();
    s.start();
    FakeWs.all[0]!.open();
    FakeWs.all[0]!.recv(loginOk);
    FakeWs.all[0]!.recv({ ch: 'position', ts: 1, data: { positionId: '1', symbol: 'BTCUSDT', side: 'BOTH', qty: '1' } });
    FakeWs.all[0]!.recv({ ch: 'order', ts: 1, data: { symbol: 'BTCUSDT' } });
    expect(events).toHaveLength(0);
    expect(s.status().parseErrors).toBe(2);
    expect(bitunixTimeMs('2024-05-16T08:13:09.123456789Z')).toBe(Date.parse('2024-05-16T08:13:09.123Z'));
    expect(bitunixTimeMs('1691382137448')).toBe(1691382137448);
    expect(bitunixTimeMs('soon')).toBeNull();
    expect(() => parseBitunixPrivateFrame({ ch: 'mystery', data: {} }, new Date(), () => 1)).toThrow(/unknown private channel/);
    s.stop();
  });
});
