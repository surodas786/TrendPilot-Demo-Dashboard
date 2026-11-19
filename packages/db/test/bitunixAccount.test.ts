// Bitunix private account reads: skip/limit pagination to completion, INCOMPLETE when the page cap
// is hit, incomplete / malformed responses rejected, sub-account rows excluded, exchange IDs kept
// as strings, quantities as exact decimals, both legs of one symbol kept apart, and a complete
// snapshot or an exception (never a partial one). Also the read-only transport's allowlist,
// throttle and retries for the new endpoints.
import { describe, expect, it } from 'vitest';
import { normalizeBitunixPosition, originOf, readAllPages, readPendingPositions, takeBitunixSnapshot, normalizeBitunixOrder } from '../src/live/bitunixAccount';
import { BitunixPrivateError, BitunixReadOnlyTransport, type BitunixRequester } from '../src/live/bitunixPrivate';

const pos = (o: Record<string, unknown> = {}) => ({ positionId: '1001', symbol: 'BTCUSDT', qty: '0.0010', side: 'LONG', positionMode: 'HEDGE', marginMode: 'ISOLATION', leverage: 10, avgOpenPrice: '64000.5', liqPrice: '0', fee: '0.0384', funding: '-0.0012', realizedPNL: '0', unrealizedPNL: '0.12', margin: '6.4', ctime: 1794823200000, mtime: 1794823260000, ...o });

/** A requester that serves fixed pages per path and records the params it was asked for. */
function pages(byPath: Record<string, (params: Record<string, unknown>) => unknown>) {
  const calls: { path: string; params: Record<string, unknown> }[] = [];
  const r: BitunixRequester = {
    async get<T>(path: string, params: Record<string, unknown> = {}) {
      calls.push({ path, params });
      const f = byPath[path];
      if (!f) throw new Error(`unexpected ${path}`);
      return f(params) as T;
    }
  };
  return { r, calls };
}

describe('Bitunix account reads', () => {
  it('reads skip/limit pages until a short page, and stops at total', async () => {
    const all = Array.from({ length: 230 }, (_, i) => ({ orderId: String(5_000_000_000_000_000 + i), symbol: 'BTCUSDT', status: 'NEW', qty: '1' }));
    const { r, calls } = pages({ '/x': (p) => ({ orderList: all.slice(Number(p.skip), Number(p.skip) + Number(p.limit)), total: all.length }) });
    const out = await readAllPages(r, '/x', { symbol: 'BTCUSDT' }, 'orderList', normalizeBitunixOrder);
    expect(out.items).toHaveLength(230);
    expect(out.items[229]!.orderId).toBe('5000000000000229');
    expect(calls.map((c) => [c.params.skip, c.params.limit])).toEqual([[0, 100], [100, 100], [200, 100]]);
    const exact = await readAllPages(pages({ '/x': (p) => ({ orderList: all.slice(Number(p.skip), Number(p.skip) + 100).slice(0, 100), total: 200 }) }).r, '/x', {}, 'orderList', normalizeBitunixOrder);
    expect(exact.pages).toBe(2); // skip reached total: no third request
  });

  it('a read that would need more pages than allowed is INCOMPLETE, never truncated silently', async () => {
    const full = Array.from({ length: 100 }, (_, i) => ({ orderId: String(i), symbol: 'BTCUSDT', status: 'NEW' }));
    const { r } = pages({ '/x': () => ({ orderList: full }) });
    await expect(readAllPages(r, '/x', {}, 'orderList', normalizeBitunixOrder, { maxPages: 3 })).rejects.toMatchObject({ kind: 'INCOMPLETE' });
  });

  it('an incomplete or malformed response is rejected', async () => {
    await expect(readAllPages(pages({ '/x': () => ({ total: 5 }) }).r, '/x', {}, 'orderList', normalizeBitunixOrder)).rejects.toMatchObject({ kind: 'PARSE', message: expect.stringMatching(/no orderList/) });
    await expect(readAllPages(pages({ '/x': () => 'oops' }).r, '/x', {}, 'orderList', normalizeBitunixOrder)).rejects.toMatchObject({ kind: 'PARSE' });
    await expect(readAllPages(pages({ '/x': () => ({ orderList: [{ symbol: 'BTCUSDT' }] }) }).r, '/x', {}, 'orderList', normalizeBitunixOrder)).rejects.toThrow(/orderId is missing/);
    expect(() => normalizeBitunixPosition(pos({ qty: 'x' }))).toThrow(/qty is not a number/);
    // BUY/SELL is a position direction only on a row that states its position mode (see bitunixPendingPositionSide.test.ts).
    expect(() => normalizeBitunixPosition(pos({ side: 'BUY', positionMode: undefined }))).toThrow(/unknown position side "BUY" \(no positionMode on the row\)/);
    expect(() => normalizeBitunixPosition(pos({ side: 'BOTH' }))).toThrow(/unknown position side/);
    expect(() => normalizeBitunixPosition(pos({ positionId: Number('9007199254740993') }))).toThrow(/lost precision/);
    expect((await readAllPages(pages({ '/x': () => ({ total: 0 }) }).r, '/x', {}, 'orderList', normalizeBitunixOrder)).items).toEqual([]);
  });

  it('reads the MAIN account only: asks without sub-accounts and drops any sub-account row', async () => {
    const { r, calls } = pages({ '/api/v1/futures/position/get_pending_positions': () => [pos(), pos({ positionId: '2002', subAccountId: 77 }), pos({ positionId: '3003', subAccountId: 0 })] });
    const out = await readPendingPositions(r);
    expect(calls[0]!.params).toEqual({ includeSubAccounts: false });
    expect(out.items.map((p) => p.positionId)).toEqual(['1001', '3003']);
    expect(out.excludedSubAccountRows).toBe(1);
  });

  it('keeps IDs as strings, quantities as exact decimals, and both legs of one symbol', async () => {
    const { r } = pages({ '/api/v1/futures/position/get_pending_positions': () => [pos({ positionId: '1001', side: 'LONG', qty: '0.0010' }), pos({ positionId: '1002', side: 'SHORT', qty: '0.123456789012345678' })] });
    const [l, s] = (await readPendingPositions(r)).items;
    expect(l).toMatchObject({ positionId: '1001', side: 'LONG', qty: '0.001', liqPrice: null, fee: '0.0384', funding: '-0.0012', mtimeMs: 1794823260000 });
    expect(s).toMatchObject({ positionId: '1002', side: 'SHORT', qty: '0.123456789012345678', symbol: 'BTCUSDT' });
  });

  it('a snapshot is complete or it throws; it never returns a partial account', async () => {
    const ok = {
      '/api/v1/futures/account/position_mode': () => ({ positionMode: 'HEDGE' }),
      '/api/v1/futures/account': () => [{ marginCoin: 'USDT', available: '100', frozen: '0', margin: '6.4', transfer: '100', crossUnrealizedPNL: '0', isolationUnrealizedPNL: '0.12', bonus: '0' }],
      '/api/v1/futures/position/get_pending_positions': () => [pos(), pos({ positionId: '1002', side: 'SHORT' })],
      '/api/v1/futures/trade/get_pending_orders': () => ({ orderList: [{ orderId: '1', symbol: 'BTCUSDT', status: 'NEW', clientId: 'tp-1' }], total: 1 }),
      '/api/v1/futures/tpsl/get_pending_orders': () => [{ id: '9', positionId: '1001', symbol: 'BTCUSDT', slPrice: '60000', slQty: '0.001' }]
    };
    const s = await takeBitunixSnapshot(pages(ok).r, () => 42);
    expect(s).toMatchObject({ takenAt: 42, positionMode: 'HEDGE', positions: [{ positionId: '1001' }, { positionId: '1002', side: 'SHORT' }], pendingOrders: [{ origin: 'TRENDPILOT' }], tpsl: [{ id: '9', slQty: '0.001' }] });
    await expect(takeBitunixSnapshot(pages({ ...ok, '/api/v1/futures/tpsl/get_pending_orders': () => ({ unexpected: true }) }).r)).rejects.toBeInstanceOf(BitunixPrivateError);
    await expect(takeBitunixSnapshot(pages({ ...ok, '/api/v1/futures/position/get_pending_positions': () => [pos(), pos()] }).r)).rejects.toThrow(/listed twice/);
  });

  it('classifies origin by client ID', () => {
    expect([originOf('tp-1'), originOf('tpx-9'), originOf('manual-1'), originOf(null)]).toEqual(['TRENDPILOT', 'TRENDPILOT', 'EXCHANGE', 'EXCHANGE']);
  });
});

describe('read-only transport for account sync', () => {
  const make = (reply: () => Response, now = { t: 0 }) => {
    const sent: string[] = [];
    const slept: number[] = [];
    const t = new BitunixReadOnlyTransport({
      credentials: { apiKey: 'k'.repeat(16), secretKey: 's'.repeat(16) },
      baseUrl: 'https://fapi.example.test',
      now: () => now.t,
      sleep: async (ms) => {
        slept.push(ms);
        now.t += ms;
      },
      fetch: (async (u: URL | string) => {
        sent.push(String(u));
        return reply();
      }) as typeof fetch
    });
    return { t, sent, slept };
  };
  const ok = () => new Response(JSON.stringify({ code: 0, data: [], msg: 'Success' }));

  it('allows the documented read endpoints and still refuses every write', async () => {
    const { t, sent } = make(ok);
    for (const p of ['/api/v1/futures/position/get_pending_positions', '/api/v1/futures/position/get_history_positions', '/api/v1/futures/trade/get_pending_orders', '/api/v1/futures/trade/get_history_orders', '/api/v1/futures/trade/get_history_trades', '/api/v1/futures/trade/get_order_detail', '/api/v1/futures/tpsl/get_pending_orders', '/api/v1/futures/tpsl/get_history_orders']) await t.get(p);
    expect(sent).toHaveLength(8);
    for (const p of ['/api/v1/futures/trade/place_order', '/api/v1/futures/trade/cancel_orders', '/api/v1/futures/tpsl/place_order', '/api/v1/futures/account/change_position_mode', '/api/v1/futures/account/change_leverage', '/api/v1/futures/trade/flash_close_position']) await expect(t.get(p)).rejects.toMatchObject({ kind: 'REFUSED' });
    expect(sent).toHaveLength(8);
  });

  it('spaces requests under the 10/s per-UID limit and retries a rate-limited read with backoff', async () => {
    let n = 0;
    const { t, slept } = make(() => (++n <= 2 ? new Response(JSON.stringify({ code: 10006, msg: 'Request too frequently' })) : ok()));
    await t.get('/api/v1/futures/trade/get_pending_orders');
    expect(n).toBe(3);
    expect(slept.filter((x) => x >= 500)).toHaveLength(2); // two backoffs
    const r2 = make(ok);
    await r2.t.get('/api/v1/futures/account');
    await r2.t.get('/api/v1/futures/account');
    expect(r2.slept.some((x) => x > 0 && x <= 120)).toBe(true); // throttle spacing
  });

  it('retries a network or 5xx failure of a read, but never an API refusal such as a bad signature', async () => {
    let n = 0;
    const flaky = make(() => (++n === 1 ? new Response('busy', { status: 503 }) : ok()));
    await flaky.t.get('/api/v1/futures/account');
    expect(n).toBe(2);
    let m = 0;
    const bad = make(() => {
      m += 1;
      return new Response(JSON.stringify({ code: 10007, msg: 'Signature Error' }));
    });
    await expect(bad.t.get('/api/v1/futures/account')).rejects.toMatchObject({ kind: 'API', code: 10007 });
    expect(m).toBe(1);
    let k = 0;
    const down = make(() => {
      k += 1;
      return new Response('down', { status: 502 });
    });
    await expect(down.t.get('/api/v1/futures/account')).rejects.toMatchObject({ kind: 'HTTP', code: 502 });
    expect(k).toBe(3); // first try + 2 retries
  });
});
