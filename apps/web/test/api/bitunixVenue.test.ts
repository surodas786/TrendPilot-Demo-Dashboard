// Bitunix order venue (Step 3) against the stateful order mock: the four exact Hedge-mode payloads,
// both legs on one symbol, closes bound to the leg's positionId (stale / wrong leg refused),
// One-Way refusal, quantity rounding and limits, the stop loss in the entry request, margin and
// trading-settings checks, partial fills, late / missing protection, duplicate client IDs and
// timeouts (reconciled by client ID, never resent blind), and the order transport's gate.
import { describe, expect, it } from 'vitest';
import {
  bitunixVenue,
  BitunixOrderTransport,
  BitunixPrivateError,
  buildBitunixCloseOrder,
  buildBitunixOpenOrder,
  roundQtyDown,
  roundStop,
  UncertainSubmissionError,
  type BitunixContractSpec
} from '@trendpilot/db';
import { MockBitunixExchange } from '../bitunixOrderMock';

const BTC: BitunixContractSpec = { symbol: 'BTCUSDT', qtyStep: '0.0001', minQty: '0.0001', maxQty: '120', priceTick: '0.1', takerFeeRate: '0.0006' };
const ALL = { BITUNIX_OPEN_WITH_ATTACHED_STOP: 'VERIFIED', BITUNIX_HEDGE_CLOSE_BY_POSITION: 'VERIFIED' } as const;
const QUOTE = { bid: '63999.9', ask: '64000.1', mark: '64000', last: '64000' };
let seq = 0;
const cid = () => `tp-${(++seq).toString(16).padStart(29, '0')}`;

function setup(o: { capabilities?: Record<string, 'VERIFIED'> } = {}) {
  const x = new MockBitunixExchange();
  x.usdt.available = '1000';
  x.setSettings('BTCUSDT', { longLeverage: 10, shortLeverage: 10 });
  const v = bitunixVenue({ requester: x, contractFor: async () => BTC, capabilities: o.capabilities ?? ALL, confirm: { attempts: 3, delayMs: 0 }, sleep: async () => {} });
  const open = (side: 'LONG' | 'SHORT', contracts = '0.0156', stop = side === 'LONG' ? '63040.1' : '64960', o2: Partial<Parameters<typeof v.placeOpeningOrderWithStop>[0]> = {}) =>
    v.placeOpeningOrderWithStop({ paperAccountId: 'acct', clientOrderId: cid(), instrumentId: 'btc', side, contracts, contract: { multiplier: '1', qtyStep: '0.0001', minQty: '0.0001', takerFeeRate: '0.0006' }, quote: QUOTE, stop: { price: stop, basis: 'MARK' }, now: new Date(), leverage: 10, marginMode: 'ISOLATED', ...o2 });
  const close = (side: 'LONG' | 'SHORT', contracts: string, positionRef: string | null, clientOrderId = cid()) =>
    v.placeReduceOnlyClose({ paperAccountId: 'acct', clientOrderId, instrumentId: 'btc', positionSide: side, contracts, contract: { multiplier: '1', qtyStep: '0.0001', takerFeeRate: '0.0006' }, quote: QUOTE, now: new Date(), positionRef });
  return { x, v, open, close };
}

describe('Hedge-mode payloads (documented mapping, exact)', () => {
  it('builders produce the four documented requests', () => {
    expect(buildBitunixOpenOrder({ symbol: 'BTCUSDT', side: 'LONG', qty: '0.0156', clientId: 'tp-1', stopPrice: '63040.1', stopType: 'MARK_PRICE' })).toEqual({ symbol: 'BTCUSDT', qty: '0.0156', side: 'BUY', tradeSide: 'OPEN', orderType: 'MARKET', clientId: 'tp-1', slPrice: '63040.1', slStopType: 'MARK_PRICE', slOrderType: 'MARKET' });
    expect(buildBitunixOpenOrder({ symbol: 'BTCUSDT', side: 'SHORT', qty: '0.0156', clientId: 'tp-2', stopPrice: '64960', stopType: 'LAST_PRICE' })).toEqual({ symbol: 'BTCUSDT', qty: '0.0156', side: 'SELL', tradeSide: 'OPEN', orderType: 'MARKET', clientId: 'tp-2', slPrice: '64960', slStopType: 'LAST_PRICE', slOrderType: 'MARKET' });
    expect(buildBitunixCloseOrder({ symbol: 'BTCUSDT', positionSide: 'LONG', positionId: '7001', qty: '0.0156', clientId: 'tp-3' })).toEqual({ symbol: 'BTCUSDT', qty: '0.0156', side: 'BUY', tradeSide: 'CLOSE', positionId: '7001', orderType: 'MARKET', clientId: 'tp-3' });
    expect(buildBitunixCloseOrder({ symbol: 'BTCUSDT', positionSide: 'SHORT', positionId: '7002', qty: '0.01', clientId: 'tp-4' })).toEqual({ symbol: 'BTCUSDT', qty: '0.01', side: 'SELL', tradeSide: 'CLOSE', positionId: '7002', orderType: 'MARKET', clientId: 'tp-4' });
  });

  it('opens both legs on one symbol and closes each by its own positionId; the other leg is untouched', async () => {
    const { x, open, close } = setup();
    const l = await open('LONG');
    const s = await open('SHORT', '0.02');
    expect(l).toMatchObject({ status: 'FILLED', fill: { contracts: '0.0156', price: '64000' }, stop: { triggerPrice: '63040.1', basis: 'MARK', contracts: '0.0156' } });
    expect(s).toMatchObject({ status: 'FILLED', fill: { contracts: '0.02' } });
    const longId = x.legOf('BTCUSDT', 'LONG')!.positionId;
    const shortId = x.legOf('BTCUSDT', 'SHORT')!.positionId;
    expect(l.status === 'FILLED' && l.positionRef).toBe(longId);
    expect(s.status === 'FILLED' && s.positionRef).toBe(shortId);
    expect(x.posts.map((p) => [p.side, p.tradeSide, p.positionId ?? null])).toEqual([
      ['BUY', 'OPEN', null],
      ['SELL', 'OPEN', null]
    ]);
    const c = await close('LONG', '0.0156', longId);
    expect(c).toMatchObject({ status: 'FILLED', requested: '0.0156', fill: { contracts: '0.0156' } });
    expect(x.posts.at(-1)).toEqual({ symbol: 'BTCUSDT', qty: '0.0156', side: 'BUY', tradeSide: 'CLOSE', positionId: longId, orderType: 'MARKET', clientId: x.posts.at(-1)!.clientId });
    expect(x.legOf('BTCUSDT', 'LONG')).toBeUndefined();
    expect(x.legOf('BTCUSDT', 'SHORT')).toMatchObject({ positionId: shortId, qty: '0.02' }); // untouched
    await close('SHORT', '0.005', shortId);
    expect(x.posts.at(-1)).toMatchObject({ side: 'SELL', tradeSide: 'CLOSE', positionId: shortId, qty: '0.005' });
    expect(x.legOf('BTCUSDT', 'SHORT')).toMatchObject({ qty: '0.015' });
  });
});

describe('close safety', () => {
  it('a stale positionId (leg already closed) or the wrong leg sends nothing', async () => {
    const { x, open, close } = setup();
    await open('LONG');
    await open('SHORT', '0.02');
    const longId = x.legOf('BTCUSDT', 'LONG')!.positionId;
    const shortId = x.legOf('BTCUSDT', 'SHORT')!.positionId;
    const posts = x.posts.length;
    expect(await close('LONG', '0.0156', shortId)).toMatchObject({ status: 'REJECTED', reason: 'CLOSE_POSITION_MISMATCH:SIDE' });
    expect(await close('LONG', '0.0156', '123456')).toMatchObject({ status: 'REJECTED', reason: 'REDUCE_ONLY_NO_POSITION' });
    expect(x.posts).toHaveLength(posts);
    // Closed on Bitunix in the meantime (stop or manual): the stored ID is stale.
    x.closeOnExchange(longId, { closePrice: '63040', mtime: Date.now() });
    expect(await close('LONG', '0.0156', longId)).toMatchObject({ status: 'REJECTED', reason: 'REDUCE_ONLY_NO_POSITION' });
    expect(x.posts).toHaveLength(posts);
  });

  it('caps a close at what the leg holds now (never more), rounded down to the step', async () => {
    const { x, open, close } = setup();
    await open('LONG');
    const id = x.legOf('BTCUSDT', 'LONG')!.positionId;
    x.positions.get(id)!.qty = '0.01'; // partly closed on Bitunix (stop child, manual)
    expect(await close('LONG', '0.0156', id)).toMatchObject({ status: 'FILLED', requested: '0.01' });
    expect(x.posts.at(-1)).toMatchObject({ qty: '0.01', positionId: id });
  });

  it('a duplicate client ID is reconciled to the existing order, never sent twice', async () => {
    const { x, open, close } = setup();
    await open('LONG');
    const id = x.legOf('BTCUSDT', 'LONG')!.positionId;
    const clientId = cid();
    x.next = { duplicate: true };
    expect(await close('LONG', '0.0156', id, clientId)).toMatchObject({ status: 'FILLED' });
    // Same intent again: Bitunix knows the clientId, so it is looked up, not resent.
    const before = x.posts.length;
    expect(await close('LONG', '0.0156', id, clientId)).toMatchObject({ status: 'FILLED' });
    expect(x.posts).toHaveLength(before);
  });
});

describe('opening checks (nothing is sent when one fails)', () => {
  it('One-Way mode, a leverage or margin-mode mismatch, and missing settings are refused, never changed', async () => {
    let t = setup();
    t.x.mode = 'ONE_WAY';
    expect(await t.open('LONG')).toMatchObject({ status: 'REJECTED', reason: 'POSITION_MODE_MISMATCH:ONE_WAY' });
    t = setup();
    t.x.setSettings('BTCUSDT', { longLeverage: 20, shortLeverage: 10 });
    expect(await t.open('LONG')).toMatchObject({ status: 'REJECTED', reason: expect.stringMatching(/^BITUNIX_SETTINGS_MISMATCH:LEVERAGE: Bitunix LONG leverage 20, order 10/) });
    expect(await t.open('SHORT')).toMatchObject({ status: 'FILLED' }); // the short leg's leverage matches
    t = setup();
    t.x.setSettings('BTCUSDT', { marginMode: 'CROSS' });
    expect(await t.open('LONG')).toMatchObject({ status: 'REJECTED', reason: expect.stringMatching(/MARGIN_MODE/) });
    t = setup();
    t.x.settings = {};
    expect(await t.open('LONG')).toMatchObject({ status: 'REJECTED', reason: expect.stringMatching(/^BITUNIX_SETTINGS_UNKNOWN/) });
    expect(t.x.posts).toHaveLength(0);
    expect(t.x.calls.some((c) => /change_|place_order/.test(c.path))).toBe(false);
  });

  it('quantity is rounded DOWN to the step and checked against min opening and max market quantity', async () => {
    expect(roundQtyDown('0.01567', '0.0001')).toBe('0.0156');
    expect(roundQtyDown('0.00009', '0.0001')).toBe('0');
    const t = setup();
    expect(await t.open('LONG', '0.01567')).toMatchObject({ status: 'FILLED', fill: { contracts: '0.0156' } });
    expect(t.x.posts.at(-1)!.qty).toBe('0.0156');
    expect(await t.open('LONG', '0.00009')).toMatchObject({ status: 'REJECTED', reason: expect.stringMatching(/^QTY_BELOW_MIN/) });
    expect(await t.open('LONG', '121')).toMatchObject({ status: 'REJECTED', reason: expect.stringMatching(/^QTY_ABOVE_MAX/) });
    expect(t.x.posts).toHaveLength(1);
  });

  it('the stop loss travels in the entry request, rounded without widening, and is checked against the side', async () => {
    expect(roundStop('LONG', '63040.15', '0.1', QUOTE)).toEqual({ ok: true, price: '63040.2' }); // Long: up (tighter)
    expect(roundStop('SHORT', '64960.15', '0.1', QUOTE)).toEqual({ ok: true, price: '64960.1' }); // Short: down (tighter)
    const t = setup();
    expect(await t.open('LONG', '0.0156', '64100')).toMatchObject({ status: 'REJECTED', reason: expect.stringMatching(/^STOP_PRICE_INVALID: Long stop 64100 is not below the ask/) });
    expect(await t.open('SHORT', '0.0156', '63900')).toMatchObject({ status: 'REJECTED', reason: expect.stringMatching(/^STOP_PRICE_INVALID: Short stop/) });
    expect(await t.open('LONG', '0.0156', '63040.1', { stop: { price: '63040.1', basis: 'INDEX' } })).toMatchObject({ status: 'REJECTED', reason: 'STOP_BASIS_UNSUPPORTED:INDEX' });
    expect(await t.open('LONG', '0.0156', '63040.1', { stop: null })).toMatchObject({ status: 'REJECTED', reason: 'STOP_REQUIRED' });
    expect(t.x.posts).toHaveLength(0);
    await t.open('SHORT', '0.0156', '64960.15');
    expect(t.x.posts[0]).toMatchObject({ side: 'SELL', tradeSide: 'OPEN', slPrice: '64960.1', slStopType: 'MARK_PRICE', slOrderType: 'MARKET' });
  });

  it('available margin is checked before sending', async () => {
    const t = setup();
    t.x.usdt.available = '50';
    t.x.usdt.crossUnrealizedPNL = '-1';
    expect(await t.open('LONG', '0.0156')).toMatchObject({ status: 'REJECTED', reason: expect.stringMatching(/^INSUFFICIENT_MARGIN: needs 100.4\d* USDT, Bitunix shows 49 available/) });
    expect(t.x.posts).toHaveLength(0);
  });

  it('unverified capabilities send nothing', async () => {
    const t = setup({ capabilities: {} });
    expect(await t.open('LONG')).toMatchObject({ status: 'REJECTED', reason: 'CAPABILITY_UNVERIFIED:BITUNIX_OPEN_WITH_ATTACHED_STOP' });
    expect(await t.close('LONG', '1', '1')).toMatchObject({ status: 'REJECTED', reason: 'CAPABILITY_UNVERIFIED:BITUNIX_HEDGE_CLOSE_BY_POSITION' });
    expect(t.x.posts).toHaveLength(0);
  });
});

describe('fills, protection and uncertain outcomes', () => {
  it('a partial fill reports the filled quantity; the leg TP/SL covers it', async () => {
    const t = setup();
    t.x.next = { fillFraction: '0.5' };
    const r = await t.open('LONG', '0.0156');
    expect(r).toMatchObject({ status: 'FILLED', fill: { contracts: '0.0078' }, stop: { contracts: '0.0078' } });
    const prot = await t.v.inspectProtection(r.status === 'FILLED' ? r.stop.orderId : '', 'btc');
    expect(prot).toMatchObject({ status: 'ACTIVE', side: 'SHORT', contracts: '0.0078', triggerPrice: '63040.1', reduceOnly: true });
  });

  it('protection that appears late is found; protection that never appears is reported missing', async () => {
    const t = setup();
    t.x.next = { stopVisibleAfterReads: 2 };
    const late = await t.open('LONG');
    expect(late.status === 'FILLED' && late.stop.orderId).toMatch(/^bitunix-tpsl:\d+$/);
    const t2 = setup();
    t2.x.next = { attachStop: 'NO' };
    const none = await t2.open('LONG');
    expect(none).toMatchObject({ status: 'FILLED', stop: { orderId: 'bitunix-tpsl:missing', contracts: '0' } });
    expect(await t2.v.inspectProtection('bitunix-tpsl:missing', 'btc')).toBeNull();
  });

  it('a timeout after Bitunix accepted the order is reconciled by client ID; before acceptance it stays pending', async () => {
    const t = setup();
    t.x.next = { timeout: 'AFTER_ACCEPT' };
    expect(await t.open('LONG')).toMatchObject({ status: 'FILLED' });
    expect(t.x.posts).toHaveLength(1);
    t.x.next = { timeout: 'BEFORE_ACCEPT' };
    await expect(t.open('LONG')).rejects.toBeInstanceOf(UncertainSubmissionError);
    expect(t.x.posts).toHaveLength(2); // sent once, never resent by the venue
  });

  it('lookups answer by client ID: unknown → null; a finished order → its fill', async () => {
    const t = setup();
    expect(await t.v.lookupOrder('tp-never-sent', 'btc')).toBeNull();
    const clientOrderId = cid();
    await t.v.placeOpeningOrderWithStop({ paperAccountId: 'a', clientOrderId, instrumentId: 'btc', side: 'SHORT', contracts: '0.01', contract: { multiplier: '1', qtyStep: '0.0001', minQty: '0.0001', takerFeeRate: '0' }, quote: QUOTE, stop: { price: '64960', basis: 'LAST' }, now: new Date(), leverage: 10, marginMode: 'ISOLATED' });
    expect(await t.v.lookupOrder(clientOrderId, 'btc')).toMatchObject({ status: 'FILLED', fill: { contracts: '0.01' }, stop: { triggerPrice: '64960', basis: 'LAST' } });
  });
});

describe('order transport', () => {
  const creds = { apiKey: 'k'.repeat(16), secretKey: 's'.repeat(16) };
  it('refuses to exist unless the live order transport is enabled (same gate as MEXC)', () => {
    expect(() => new BitunixOrderTransport({ credentials: creds, env: { NODE_ENV: 'test' } })).toThrow(/LIVE_ORDER_TRANSPORT/);
  });

  it('signs and sends only place_order; other order-changing paths are refused before sending', async () => {
    const sent: { url: string; body: string; headers: Record<string, string> }[] = [];
    const t = new BitunixOrderTransport({
      credentials: creds,
      env: { NODE_ENV: 'production', LIVE_ORDER_TRANSPORT: 'enabled' },
      baseUrl: 'https://fapi.example.test',
      now: () => 1794820330397,
      nonce: () => '0123456789abcdef0123456789abcdef',
      fetch: (async (u: URL | string, init: RequestInit) => {
        sent.push({ url: String(u), body: String(init.body), headers: init.headers as Record<string, string> });
        return new Response(JSON.stringify({ code: 0, data: { orderId: '1', clientId: 'tp-1' }, msg: 'Success' }));
      }) as typeof fetch
    });
    const body = buildBitunixOpenOrder({ symbol: 'BTCUSDT', side: 'LONG', qty: '0.0156', clientId: 'tp-1', stopPrice: '63040.1', stopType: 'MARK_PRICE' });
    expect(await t.post('/api/v1/futures/trade/place_order', body)).toEqual({ orderId: '1', clientId: 'tp-1' });
    expect(sent[0]!.body).toBe(JSON.stringify(body)); // the exact bytes that were signed
    expect(sent[0]!.headers).toMatchObject({ 'api-key': creds.apiKey, timestamp: '1794820330397', 'Content-Type': 'application/json' });
    for (const p of ['/api/v1/futures/trade/cancel_orders', '/api/v1/futures/account/change_leverage', '/api/v1/futures/account/change_position_mode', '/api/v1/futures/trade/flash_close_position', '/api/v1/futures/trade/close_all_position'])
      await expect(t.post(p, {})).rejects.toMatchObject({ kind: 'REFUSED' });
    expect(sent).toHaveLength(1);
    await expect(t.get('/api/v1/futures/account/change_margin_mode')).rejects.toBeInstanceOf(BitunixPrivateError);
  });
});
