// 19 Nov 2026 production: reconciliation of e6d08d8e7da84c0696edd8ae89a435c3 stopped with "order
// 2123307529551073280: price is not a number". Bitunix's order HISTORY lists a market order with
// `price: "MARKET"` and the executed average in `avgPrice`; get_order_detail for the same order gives
// `price: "3552.71"` and `avgPrice: null`. Every history row also carried `subAccountId: "891435181"`,
// the key's own account, which the mirror dropped as a sub-account row. Rows below are the sanitized
// production responses.
import { describe, expect, it } from 'vitest';
import { normalizeBitunixHistoryPosition, normalizeBitunixOrder, readAllPages, readHistoryOrders, readPendingPositions, resolveBitunixAccountTag } from '../src/live/bitunixAccount';
import type { BitunixRequester } from '../src/live/bitunixPrivate';
import { bitunixStatusRank } from '../src/live/bitunixIntents';

const HISTORY_SELL = {
  orderId: '2123307529551073280', marginCoin: null, symbol: 'XAUUSDT', qty: '0.024', tradeQty: '0.024', positionMode: 'HEDGE', marginMode: 'ISOLATION', leverage: 20,
  price: 'MARKET', avgPrice: '3739.68', side: 'SELL', orderType: 'MARKET', effect: 'IOC', clientId: '2123307529555795969', reduceOnly: true, status: 'FILLED',
  fee: '0.04487616', realizedPNL: '-0.00576', tpPrice: null, slPrice: null, ctime: '1795070938851', mtime: '1795070938943', subAccountId: '891435181'
};
const HISTORY_BUY = { ...HISTORY_SELL, orderId: '2123290722031226880', avgPrice: '3739.92', side: 'BUY', clientId: '2123290721968840706', reduceOnly: false, fee: '0.04487904', realizedPNL: '0', ctime: '1795066931626', mtime: '1795066931712' };
const DETAIL_SELL = { ...HISTORY_SELL, price: '3552.71', avgPrice: null, effect: 'GTC', subAccountId: null };

const requester = (answer: (path: string, params: Record<string, unknown>) => unknown) => {
  const calls: { path: string; params: Record<string, unknown> }[] = [];
  const r: BitunixRequester & { accountTag?: string | null } = {
    async get<T>(path: string, params: Record<string, unknown> = {}) {
      calls.push({ path, params });
      return answer(path, params) as T;
    }
  };
  return { r, calls };
};

describe('Bitunix order price fields', () => {
  it('history market order: no requested price ("MARKET"), executed average kept exactly; IDs stay strings', () => {
    expect(normalizeBitunixOrder(HISTORY_SELL)).toMatchObject({ orderId: '2123307529551073280', clientId: '2123307529555795969', origin: 'EXCHANGE', requestedPrice: null, avgPrice: '3739.68', qty: '0.024', tradeQty: '0.024', fee: '0.04487616', realizedPNL: '-0.00576', status: 'FILLED', reduceOnly: true, ctimeMs: 1795070938851, mtimeMs: 1795070938943 });
    expect(normalizeBitunixOrder(HISTORY_SELL).issues).toBeUndefined();
  });
  it('order detail of the same order: requested price kept as requested, no executed average invented', () => {
    expect(normalizeBitunixOrder(DETAIL_SELL)).toMatchObject({ requestedPrice: '3552.71', avgPrice: null, tradeQty: '0.024' });
  });
  it('empty, null, zero-like and "market" forms; an unknown form is recorded, never fatal', () => {
    for (const price of ['', null, undefined, 'market', ' MARKET ']) expect(normalizeBitunixOrder({ ...HISTORY_SELL, price }).requestedPrice).toBeNull();
    expect(normalizeBitunixOrder({ ...HISTORY_SELL, price: '0' }).requestedPrice).toBe('0');
    const odd = normalizeBitunixOrder({ ...HISTORY_SELL, price: '--' });
    expect(odd).toMatchObject({ requestedPrice: null, avgPrice: '3739.68', issues: ['price "--" is not a price'] });
  });
  it('fields that establish fills and quantities stay strict', () => {
    expect(() => normalizeBitunixOrder({ ...HISTORY_SELL, avgPrice: 'MARKET' })).toThrow(/avgPrice is not a number/);
    expect(() => normalizeBitunixOrder({ ...HISTORY_SELL, tradeQty: 'x' })).toThrow(/tradeQty is not a number/);
    expect(() => normalizeBitunixOrder({ ...HISTORY_SELL, qty: 'x' })).toThrow(/qty is not a number/);
    expect(() => normalizeBitunixOrder({ ...HISTORY_SELL, orderId: 2123307529551073280 })).toThrow(/lost precision/);
  });
});

describe('history reads', () => {
  it('a row that cannot be parsed is collected with its identifiers; the rest of the history is read', async () => {
    const bad = { ...HISTORY_BUY, orderId: '3', clientId: null, tradeQty: 'oops' };
    const { r } = requester(() => ({ orderList: [HISTORY_SELL, bad, HISTORY_BUY], total: '3' }));
    const out = await readHistoryOrders(r, { symbol: 'XAUUSDT' }, { includeSubAccountRows: true, collectRowErrors: true });
    expect(out.items.map((o) => o.orderId)).toEqual(['2123307529551073280', '2123290722031226880']);
    expect(out.skipped).toEqual([{ orderId: '3', clientId: null, symbol: 'XAUUSDT', error: 'order 3: tradeQty is not a number' }]);
    // Without collection the read still fails as before (the mirror never books from a partial page).
    await expect(readHistoryOrders(r, { symbol: 'XAUUSDT' }, { includeSubAccountRows: true })).rejects.toThrow(/tradeQty is not a number/);
  });
  it('pagination: every page by skip/limit until total, string totals included', async () => {
    const rows = Array.from({ length: 205 }, (_, i) => ({ ...HISTORY_SELL, orderId: String(9_000_000_000_000_000_000n + BigInt(i)), clientId: `c${i}` }));
    const { r, calls } = requester((_p, q) => ({ orderList: rows.slice(Number(q.skip), Number(q.skip) + Number(q.limit)), total: String(rows.length) }));
    const out = await readAllPages(r, '/api/v1/futures/trade/get_history_orders', { symbol: 'XAUUSDT' }, 'orderList', normalizeBitunixOrder, { includeSubAccountRows: true });
    expect(out.items).toHaveLength(205);
    expect(out.items[204]!.orderId).toBe('9000000000000000204');
    expect(calls.map((c) => c.params.skip)).toEqual([0, 100, 200]);
  });
});

describe("the key's own account tag", () => {
  it('is established only when get_order_detail returns the tagged history order as the key’s own', async () => {
    const { r } = requester((path, q) => (path.endsWith('get_history_orders') ? { orderList: [HISTORY_SELL], total: '1' } : q.orderId === HISTORY_SELL.orderId ? DETAIL_SELL : null));
    expect(await resolveBitunixAccountTag(r)).toMatchObject({ tag: '891435181', evidence: expect.stringMatching(/get_order_detail returns it/) });
    const { r: notMine } = requester((path) => (path.endsWith('get_history_orders') ? { orderList: [HISTORY_SELL], total: '1' } : null));
    expect((await resolveBitunixAccountTag(notMine)).tag).toBeNull();
  });
  it('rows with the own tag are the main account’s; rows with any other tag stay excluded', async () => {
    const pos = (positionId: string, subAccountId: unknown) => ({ positionId, symbol: 'XAUUSDT', side: 'LONG', qty: '0.024', mtime: 1, subAccountId });
    const { r } = requester(() => [pos('1', '891435181'), pos('2', '555'), pos('3', null)]);
    expect((await readPendingPositions(r)).items.map((p) => p.positionId)).toEqual(['3']); // tag unknown: unchanged rule
    r.accountTag = '891435181';
    const out = await readPendingPositions(r);
    expect(out.items.map((p) => p.positionId)).toEqual(['1', '3']);
    expect(out.excludedSubAccountRows).toBe(1);
  });
});

describe('position history', () => {
  it('the production row (side "BUY", own-account tag) is the closed LONG leg with exact figures', () => {
    const row = { positionId: '275788944450665588', symbol: 'XAUUSDT', marginCoin: null, maxQty: '0.024', qty: '0.024', entryPrice: '3739.92', closePrice: '3739.68', liqQty: null, side: 'BUY', marginMode: 'ISOLATION', positionMode: 'HEDGE', leverage: '20', fee: '0.0897552', funding: '0', realizedPNL: '-0.0955152', margin: null, liqPrice: '0', ctime: '1795066931000', mtime: '1795070939000', subAccountId: '891435181' };
    expect(normalizeBitunixHistoryPosition(row)).toMatchObject({ positionId: '275788944450665588', side: 'LONG', maxQty: '0.024', entryPrice: '3739.92', closePrice: '3739.68', fee: '0.0897552', realizedPNL: '-0.0955152', mtimeMs: 1795070939000 });
    expect(normalizeBitunixHistoryPosition({ ...row, side: 'SELL' }).side).toBe('SHORT');
    expect(() => normalizeBitunixHistoryPosition({ ...row, side: 'BOTH' })).toThrow(/unknown position side/);
  });
});

describe('order status rank', () => {
  it('NEW < PART_FILLED < final', () => {
    expect(bitunixStatusRank('NEW')).toBeLessThan(bitunixStatusRank('PART_FILLED'));
    for (const s of ['FILLED', 'CANCELED', 'PART_FILLED_CANCELED']) expect(bitunixStatusRank(s)).toBeGreaterThan(bitunixStatusRank('PART_FILLED'));
  });
});
