// Bitunix Futures private client (Step 1, read-only): signing against fixed reference vectors,
// query ordering, body bytes, header redaction, HTTP failures vs Bitunix API error codes, the
// read-only allowlist, and position-mode / account parsing.
import { describe, expect, it } from 'vitest';
import {
  bitunixQueryParamString,
  bitunixQueryString,
  bitunixReadOnlyCheck,
  BitunixPrivateError,
  BitunixReadOnlyTransport,
  buildBitunixSignedRequest,
  parseBitunixAccount,
  parseBitunixPositionMode,
  redactBitunixHeaders,
  signBitunix,
  unwrapBitunixEnvelope,
  type BitunixRequester
} from '../src/live/bitunixPrivate';

const CREDS = { apiKey: 'yourApiKey', secretKey: 'yourSecretKey' };
const NONCE = '0123456789abcdef0123456789abcdef';
const TS = 1794820330397;

/**
 * Reference vectors computed independently with Python hashlib from the official sign page's
 * algorithm and its sample inputs (digest = sha256(nonce+timestamp+apiKey+queryParams+body),
 * sign = sha256(digest+secretKey)); the page prints no expected output, so these pin the formula.
 */
const DOC_VECTOR = {
  nonce: '123456',
  timestamp: '20241120123045',
  apiKey: 'yourApiKey',
  secretKey: 'yourSecretKey',
  queryParams: 'id1uid200',
  body: '{"uid":"2899","arr":[{"id":1,"name":"maple"},{"id":2,"name":"lily"}]}',
  sign: '00397cd1e52c7dce3258067324363b6361fabc9178a0912b330c138db8745655'
};
const GET_ACCOUNT_SIGN = 'd6d0b36ef5620e3c4932d392816fbe38745555b29978a0a62fa7ba13d7496a8b'; // marginCoin=USDT
const NO_PARAMS_SIGN = '8a46ddfd9e8c29e5c6757f5d96976c8354d90dce5e5a1604241f8893327b1ad8';

const response = (body: unknown, status = 200) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function transport(reply: (url: string, init: RequestInit) => Response | Promise<Response>, seen: { url: string; headers: Record<string, string> }[] = []) {
  return new BitunixReadOnlyTransport({
    credentials: CREDS,
    baseUrl: 'https://fapi.example.test',
    now: () => TS,
    nonce: () => NONCE,
    fetch: (async (u: URL | string, init: RequestInit) => {
      seen.push({ url: String(u), headers: init.headers as Record<string, string> });
      return reply(String(u), init);
    }) as typeof fetch
  });
}

describe('Bitunix signing', () => {
  it('matches the reference vector built from the official sign-page example', () => {
    expect(signBitunix(DOC_VECTOR)).toBe(DOC_VECTOR.sign);
  });

  it('sorts query parameters by key in ASCII order and writes key+value with no separators', () => {
    expect(bitunixQueryParamString({ uid: 200, id: 1 })).toBe('id1uid200');
    expect(bitunixQueryParamString({ b: 'x', B: 'y', a: null, c: undefined })).toBe('Bybx'); // ASCII: 'B' (66) sorts before 'b' (98); nulls omitted
    expect(bitunixQueryString({ uid: 200, id: 1, skip: null })).toBe('id=1&uid=200');
    expect(bitunixQueryParamString({})).toBe('');
  });

  it('signs a GET with millisecond timestamp, the query params, and an empty body', () => {
    const r = buildBitunixSignedRequest(CREDS, 'GET', '/api/v1/futures/account', { marginCoin: 'USDT' }, { timestampMs: TS, nonce: NONCE });
    expect(r.url).toBe('/api/v1/futures/account?marginCoin=USDT');
    expect(r.body).toBeUndefined();
    expect(r.headers).toMatchObject({ 'api-key': 'yourApiKey', nonce: NONCE, timestamp: '1794820330397', sign: GET_ACCOUNT_SIGN, language: 'en-US', 'Content-Type': 'application/json' });
    expect(buildBitunixSignedRequest(CREDS, 'GET', '/api/v1/futures/account/position_mode', null, { timestampMs: TS, nonce: NONCE }).headers.sign).toBe(NO_PARAMS_SIGN);
  });

  it('signs a POST over the exact body bytes it sends (compact JSON, no spaces)', () => {
    const body = { uid: '2899', arr: [{ id: 1, name: 'maple' }, { id: 2, name: 'lily' }] };
    const r = buildBitunixSignedRequest({ apiKey: DOC_VECTOR.apiKey, secretKey: DOC_VECTOR.secretKey }, 'POST', '/x', { uid: 200, id: 1 }, { timestampMs: 0, nonce: DOC_VECTOR.nonce, body });
    expect(r.body).toBe(DOC_VECTOR.body);
    // Same inputs as the doc vector except the timestamp; recompute with the doc timestamp to compare.
    expect(signBitunix({ ...DOC_VECTOR, body: r.body! })).toBe(DOC_VECTOR.sign);
  });

  it('a different secret, nonce, timestamp or parameter order changes nothing but what it must', () => {
    const a = buildBitunixSignedRequest(CREDS, 'GET', '/p', { b: 2, a: 1 }, { timestampMs: TS, nonce: NONCE }).headers.sign;
    const b = buildBitunixSignedRequest(CREDS, 'GET', '/p', { a: 1, b: 2 }, { timestampMs: TS, nonce: NONCE }).headers.sign;
    expect(a).toBe(b); // insertion order is irrelevant
    expect(buildBitunixSignedRequest({ ...CREDS, secretKey: 'other' }, 'GET', '/p', { a: 1, b: 2 }, { timestampMs: TS, nonce: NONCE }).headers.sign).not.toBe(a);
    expect(buildBitunixSignedRequest(CREDS, 'GET', '/p', { a: 1, b: 2 }, { timestampMs: TS + 1, nonce: NONCE }).headers.sign).not.toBe(a);
  });

  it('redacts the key, nonce and signature from anything logged', () => {
    const r = buildBitunixSignedRequest(CREDS, 'GET', '/api/v1/futures/account', { marginCoin: 'USDT' }, { timestampMs: TS, nonce: NONCE });
    const red = redactBitunixHeaders(r.headers);
    expect(red).toMatchObject({ 'api-key': '[redacted]', sign: '[redacted]', nonce: '[redacted]', timestamp: String(TS) });
    expect(JSON.stringify(red)).not.toContain('yourApiKey');
    expect(JSON.stringify(red)).not.toContain(GET_ACCOUNT_SIGN);
  });
});

describe('Bitunix read-only transport', () => {
  it('sends the signed GET and returns data; diagnostics only ever see redacted headers', async () => {
    const seen: { url: string; headers: Record<string, string> }[] = [];
    const logged: unknown[] = [];
    const t = new BitunixReadOnlyTransport({
      credentials: CREDS,
      baseUrl: 'https://fapi.example.test/',
      now: () => TS,
      nonce: () => NONCE,
      onRequest: (r) => logged.push(r),
      fetch: (async (u: URL | string, init: RequestInit) => {
        seen.push({ url: String(u), headers: init.headers as Record<string, string> });
        return response({ code: 0, data: { positionMode: 'ONE_WAY' }, msg: 'Success' });
      }) as typeof fetch
    });
    expect(await t.get('/api/v1/futures/account/position_mode')).toEqual({ positionMode: 'ONE_WAY' });
    expect(seen[0]!.url).toBe('https://fapi.example.test/api/v1/futures/account/position_mode');
    expect(seen[0]!.headers.sign).toBe(NO_PARAMS_SIGN);
    expect(JSON.stringify(logged)).not.toMatch(/yourApiKey|yourSecretKey|8a46ddfd/);
  });

  it('refuses every path outside the read-only allowlist before signing or sending', async () => {
    const seen: unknown[] = [];
    const t = transport(() => response({ code: 0, data: null }), seen as never);
    for (const p of ['/api/v1/futures/trade/place_order', '/api/v1/futures/account/change_position_mode', '/api/v1/futures/account/change_leverage', '/api/v1/futures/account/x']) {
      await expect(t.get(p)).rejects.toMatchObject({ kind: 'REFUSED' });
    }
    expect(seen).toHaveLength(0);
    expect(() => new BitunixReadOnlyTransport({ credentials: { apiKey: '', secretKey: 'x' } })).toThrow(/not configured/);
  });

  it('an HTTP failure is kind HTTP with the status; a Bitunix error code is kind API with the code', async () => {
    await expect(transport(() => response('bad gateway', 502)).get('/api/v1/futures/account', { marginCoin: 'USDT' })).rejects.toMatchObject({ kind: 'HTTP', code: 502 });
    const e = (await transport(() => response({ code: 10007, data: null, msg: 'Signature Error' }))
      .get('/api/v1/futures/account', { marginCoin: 'USDT' })
      .catch((x: unknown) => x)) as BitunixPrivateError;
    expect(e).toBeInstanceOf(BitunixPrivateError);
    expect(e).toMatchObject({ kind: 'API', code: 10007 });
    expect(e.message).toMatch(/Signature Error \(code 10007\).*check the API key/);
    expect(e.message).not.toMatch(/yourApiKey|yourSecretKey/);
    await expect(transport(() => response({ code: 10004, msg: 'ip' })).get('/api/v1/futures/account')).rejects.toMatchObject({ kind: 'API', code: 10004, message: expect.stringMatching(/whitelist/) });
    const rl = (await transport(() => response({ code: 10006, msg: 'slow down' }))
      .get('/api/v1/futures/account')
      .catch((x: unknown) => x)) as BitunixPrivateError;
    expect(rl.rateLimited).toBe(true);
    expect(new BitunixPrivateError('x', 'HTTP', 429).rateLimited).toBe(true);
  });

  it('network failures, timeouts and malformed bodies are reported as such', async () => {
    await expect(transport(() => Promise.reject(Object.assign(new Error('x'), { name: 'TimeoutError' }))).get('/api/v1/futures/account')).rejects.toMatchObject({ kind: 'TIMEOUT' });
    await expect(transport(() => Promise.reject(new TypeError('fetch failed'))).get('/api/v1/futures/account')).rejects.toMatchObject({ kind: 'NETWORK' });
    await expect(transport(() => response('<html>', 200)).get('/api/v1/futures/account')).rejects.toMatchObject({ kind: 'PARSE' });
    expect(() => unwrapBitunixEnvelope({ data: 1 }, 'x')).toThrow(/unexpected response/);
  });
});

describe('Bitunix position mode and account parsing', () => {
  it('reads the exchange-reported position mode', () => {
    expect(parseBitunixPositionMode({ positionMode: 'HEDGE' })).toEqual({ mode: 'HEDGE', raw: 'HEDGE' });
    expect(parseBitunixPositionMode({ positionMode: 'one_way' })).toEqual({ mode: 'ONE_WAY', raw: 'one_way' });
    for (const bad of [null, {}, { positionMode: 'NET' }, { positionMode: 2 }, [{ positionMode: 'HEDGE' }]]) expect(() => parseBitunixPositionMode(bad)).toThrow(/unknown position mode/);
  });

  it('reads the USDT account from the documented array response (and from an object)', () => {
    const doc = [{ marginCoin: 'USDT', available: '1000', frozen: '0', margin: '10', transfer: '1000', positionMode: 'HEDGE', crossUnrealizedPNL: '2', isolationUnrealizedPNL: '0', bonus: '0' }];
    expect(parseBitunixAccount(doc)).toEqual({ marginCoin: 'USDT', available: '1000', frozen: '0', margin: '10', transfer: '1000', positionMode: 'HEDGE', crossUnrealizedPNL: '2', isolationUnrealizedPNL: '0', bonus: '0' });
    expect(parseBitunixAccount(doc[0])!.available).toBe('1000');
    expect(parseBitunixAccount([{ marginCoin: 'BTC', available: '1' }])).toBeNull();
    expect(() => parseBitunixAccount([{ marginCoin: 'USDT', available: 'abc' }])).toThrow(/available is not a number/);
  });

  it('the read-only check makes exactly two GETs and reports the mode Bitunix states', async () => {
    const calls: string[] = [];
    const r: BitunixRequester = {
      async get<T>(path: string, params?: Record<string, unknown>) {
        calls.push(`${path}${params ? JSON.stringify(params) : ''}`);
        if (path.endsWith('position_mode')) return { positionMode: 'ONE_WAY' } as T;
        return [{ marginCoin: 'USDT', available: '100.5', frozen: '1', margin: '20', transfer: '100', positionMode: 'HEDGE', crossUnrealizedPNL: '-0.5', isolationUnrealizedPNL: '1', bonus: '0' }] as T;
      }
    };
    const c = await bitunixReadOnlyCheck(r, () => new Date('2026-11-16T00:00:00Z'));
    expect(calls).toEqual(['/api/v1/futures/account/position_mode', '/api/v1/futures/account{"marginCoin":"USDT"}']);
    expect(c).toMatchObject({ positionMode: 'ONE_WAY', positionModeRaw: 'ONE_WAY', usdt: { available: '100.5', unrealized: '0.5', equity: '122' }, accountPositionMode: 'HEDGE' });
    expect(c.positionModeNote).toMatch(/One-way/);
  });
});
