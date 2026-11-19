// 19 Nov 2026 incident (XAUUSDT OPEN LONG e6d08d8e7da84c0696edd8ae89a435c3): the REAL Bitunix order
// transport, built exactly as the Live venue builds it in production (credentials + base URL only,
// no clock / nonce / fetch overrides), threw "TypeError: this.o.now is not a function" on its first
// signed read, so every paper.submit attempt failed before place_order and the job went DEAD.
// Earlier tests replaced the transport with a seam and never constructed it. HTTP is mocked here.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BitunixOrderTransport, BITUNIX_PLACE_ORDER_PATH } from '../src/live/bitunixOrders';
import { BitunixReadOnlyTransport } from '../src/live/bitunixPrivate';

const PROD_ENV = { LIVE_ORDER_TRANSPORT: 'enabled', NODE_ENV: 'production' };
const CREDS = { apiKey: 'test-api-key-0001', secretKey: 'test-secret-key-0001' };

afterEach(() => vi.unstubAllGlobals());

function stubFetch() {
  const calls: { url: string; method: string; headers: Record<string, string>; body: string | null }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, method: String(init.method), headers: init.headers as Record<string, string>, body: (init.body as string) ?? null });
      const data = url.includes('get_order_detail') ? null : { orderId: '2123300000000000001', clientId: 'e6d08d8e7da84c0696edd8ae89a435c3' };
      return new Response(JSON.stringify({ code: 0, msg: 'Success', data }), { status: 200, headers: { 'content-type': 'application/json' } });
    })
  );
  return calls;
}

describe('Bitunix order transport as constructed in production', () => {
  it('signs reads and the order POST with its own defaults when no clock, nonce or fetch is passed', async () => {
    const calls = stubFetch();
    // liveMode.ts: new BitunixOrderTransport({ credentials, baseUrl: env.BITUNIX_PRIVATE_BASE_URL || undefined, env })
    const t = new BitunixOrderTransport({ credentials: CREDS, baseUrl: undefined, env: PROD_ENV });
    await expect(t.get('/api/v1/futures/trade/get_order_detail', { clientId: 'e6d08d8e7da84c0696edd8ae89a435c3' })).resolves.toBeNull();
    await expect(t.post(BITUNIX_PLACE_ORDER_PATH, { symbol: 'XAUUSDT', qty: '0.026', side: 'BUY', tradeSide: 'OPEN', orderType: 'MARKET', clientId: 'e6d08d8e7da84c0696edd8ae89a435c3' })).resolves.toMatchObject({ orderId: '2123300000000000001' });
    expect(calls.map((c) => `${c.method} ${c.url.split('?')[0]}`)).toEqual(['GET https://fapi.bitunix.com/api/v1/futures/trade/get_order_detail', `POST https://fapi.bitunix.com${BITUNIX_PLACE_ORDER_PATH}`]);
    for (const c of calls) {
      expect(Number(c.headers.timestamp)).toBeGreaterThan(1_700_000_000_000);
      expect(c.headers.nonce).toMatch(/^[0-9a-f]{32}$/);
      expect(c.headers.sign).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('a read-only transport keeps every default an explicit undefined would otherwise erase', async () => {
    const calls = stubFetch();
    const t = new BitunixReadOnlyTransport({ credentials: CREDS, baseUrl: undefined, timeoutMs: undefined, fetch: undefined, now: undefined, nonce: undefined, retries: undefined, minIntervalMs: undefined, sleep: undefined });
    await expect(t.get('/api/v1/futures/trade/get_order_detail', { clientId: 'x' })).resolves.toBeNull();
    expect(calls[0]!.url.startsWith('https://fapi.bitunix.com/')).toBe(true);
  });
});
