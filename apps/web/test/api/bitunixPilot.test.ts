// Bitunix Step 5 (venue level, mocked exchange): fixed-quantity TP/SL resize through the documented
// tpsl/modify_order (gated by its own capability, verified by re-reading), the supervised pilot plan
// and run (four Hedge-mode paths, attached stops, fill visibility, clientId lookups, the other leg
// untouched), and trade history read once when offset pages overlap.
import { describe, expect, it } from 'vitest';
import { bitunixVenue, BitunixPrivateError, pilotReference, planBitunixPilot, readHistoryTrades, runBitunixPilot, type BitunixContractSpec } from '@trendpilot/db';
import { MockBitunixExchange } from '../bitunixOrderMock';

const BTC: BitunixContractSpec = { symbol: 'BTCUSDT', qtyStep: '0.0001', minQty: '0.0001', maxQty: '120', priceTick: '0.1', takerFeeRate: '0.0006' };
const ORDERS = { BITUNIX_OPEN_WITH_ATTACHED_STOP: 'VERIFIED', BITUNIX_HEDGE_CLOSE_BY_POSITION: 'VERIFIED' } as const;
const QUOTE = { bid: '63999.9', ask: '64000.1', mark: '64000', last: '64000' };

function setup(capabilities: Record<string, 'VERIFIED'> = ORDERS) {
  const x = new MockBitunixExchange();
  x.usdt.available = '1000';
  x.setSettings('BTCUSDT', { longLeverage: 10, shortLeverage: 10 });
  const v = bitunixVenue({ requester: x, contractFor: async () => BTC, capabilities, confirm: { attempts: 3, delayMs: 0 }, sleep: async () => {} });
  return { x, v };
}

/** A fixed-quantity stop (slQty) on the long leg, as Bitunix lists a TP/SL placed with a quantity. */
function fixedQtyStop(x: MockBitunixExchange, qty = '0.02', extra: Record<string, unknown> = {}) {
  x.positions.set('7001', { positionId: '7001', symbol: 'BTCUSDT', side: 'LONG', qty: '0.012', avgOpenPrice: '64000', mtime: 1 });
  x.tpsl.push({ id: '5001', positionId: '7001', symbol: 'BTCUSDT', base: 'BTC', quote: 'USDT', slPrice: '63040.1', slStopType: 'MARK_PRICE', slOrderType: 'MARKET', slQty: qty, ...extra });
}

describe('fixed-quantity TP/SL resize after a partial close (tpsl/modify_order)', () => {
  it('a whole-position stop (no slQty) follows the leg: nothing is sent', async () => {
    const { x, v } = setup();
    x.positions.set('7001', { positionId: '7001', symbol: 'BTCUSDT', side: 'LONG', qty: '0.012', mtime: 1 });
    x.tpsl.push({ id: '5001', positionId: '7001', symbol: 'BTCUSDT', slPrice: '63040.1', slStopType: 'MARK_PRICE' });
    expect(await v.resizeProtection('bitunix-tpsl:5001', '0.012', 'btc')).toBe('bitunix-tpsl:5001');
    expect(x.modifies).toEqual([]);
  });

  it('is refused while BITUNIX_TPSL_RESIZE is unverified (existing recovery: the position goes UNPROTECTED)', async () => {
    const { x, v } = setup();
    fixedQtyStop(x);
    await expect(v.resizeProtection('bitunix-tpsl:5001', '0.012', 'btc')).rejects.toMatchObject({ kind: 'REFUSED', message: 'CAPABILITY_UNVERIFIED:BITUNIX_TPSL_RESIZE' });
    expect(x.modifies).toEqual([]);
  });

  it('when verified: modifies THIS stop by orderId to the remaining quantity at the same trigger, confirmed by re-reading', async () => {
    const { x, v } = setup({ ...ORDERS, BITUNIX_TPSL_RESIZE: 'VERIFIED' });
    fixedQtyStop(x);
    expect(await v.resizeProtection('bitunix-tpsl:5001', '0.012', 'btc')).toBe('bitunix-tpsl:5001');
    expect(x.modifies).toEqual([{ orderId: '5001', slPrice: '63040.1', slStopType: 'MARK_PRICE', slOrderType: 'MARKET', slQty: '0.012' }]);
    expect(x.tpsl[0]).toMatchObject({ slPrice: '63040.1', slQty: '0.012' });
  });

  it('a timeout after Bitunix applied the change is confirmed by the re-read (not resent)', async () => {
    const { x, v } = setup({ ...ORDERS, BITUNIX_TPSL_RESIZE: 'VERIFIED' });
    fixedQtyStop(x);
    x.modifyOutcome = 'TIMEOUT_APPLIED';
    expect(await v.resizeProtection('bitunix-tpsl:5001', '0.012', 'btc')).toBe('bitunix-tpsl:5001');
    expect(x.modifies).toHaveLength(1);
  });

  it('an acknowledged but unapplied modify is NOT treated as protected', async () => {
    const { x, v } = setup({ ...ORDERS, BITUNIX_TPSL_RESIZE: 'VERIFIED' });
    fixedQtyStop(x);
    x.modifyOutcome = 'IGNORE';
    await expect(v.resizeProtection('bitunix-tpsl:5001', '0.012', 'btc')).rejects.toBeInstanceOf(BitunixPrivateError);
    expect(x.tpsl[0]).toMatchObject({ slQty: '0.02' });
  });

  it('a TP/SL that also carries a take profit is not modified (its TP part would change too)', async () => {
    const { x, v } = setup({ ...ORDERS, BITUNIX_TPSL_RESIZE: 'VERIFIED' });
    fixedQtyStop(x, '0.02', { tpPrice: '70000', tpStopType: 'MARK_PRICE', tpQty: '0.02' });
    await expect(v.resizeProtection('bitunix-tpsl:5001', '0.012', 'btc')).rejects.toMatchObject({ kind: 'REFUSED' });
    expect(x.modifies).toEqual([]);
  });
});

describe('trade history across overlapping pages', () => {
  it('a trade returned on two offset pages (a new trade shifted the list) is read once', async () => {
    const x = new MockBitunixExchange();
    const t = (i: number) => ({ tradeId: `t${i}`, orderId: `o${i}`, positionId: '7001', symbol: 'BTCUSDT', side: 'SELL', qty: '0.001', price: '64000', fee: '0.0384', realizedPNL: '0.5', reduceOnly: false, ctime: 1_000 + i });
    // 150 trades: two pages of 100 (offset-based).
    x.trades = Array.from({ length: 150 }, (_, i) => t(i));
    // While page 1 is read, a new trade lands at the front: page 2 (skip 100) starts one row earlier
    // and returns t99 a second time.
    x.beforeAnswer = (path) => {
      if (path.endsWith('get_history_trades') && x.calls.filter((c) => c.path === path).length === 2) x.trades.unshift(t(150));
    };
    const read = await readHistoryTrades(x, {});
    expect(read.pages).toBe(2);
    const ids = read.items.map((i) => i.tradeId);
    expect(new Set(ids).size).toBe(ids.length); // each trade once
    expect(ids.filter((i) => i === 't99')).toHaveLength(1);
    expect(ids).toHaveLength(150); // t0…t149 (t150 lands at offset 0, already read: the next sync picks it up)
  });
});

describe('supervised pilot (plan, then the four Hedge-mode paths)', () => {
  const input = { symbol: 'BTCUSDT', contract: BTC, quote: { bid: QUOTE.bid, ask: QUOTE.ask }, leverage: 10, marginMode: 'ISOLATED' as const, stopPct: '2', basis: 'MARK' as const, maxExposureUsdt: '20', clientIdPrefix: 'tpx-pilot-t1' };

  it('plans the smallest valid quantity within the approved exposure, with the exact four payloads', () => {
    const p = planBitunixPilot(input);
    expect(p).toMatchObject({ ok: true, qty: '0.0001', notionalPerLegUsdt: '6.4', exposureUsdt: '12.8', marginPerLegUsdt: '0.64', stops: { LONG: '62720.1', SHORT: '65279.8' } });
    expect(p.steps.map((s) => [s.payload.side, s.payload.tradeSide, s.payload.positionId ?? null, s.payload.slPrice ?? null])).toEqual([
      ['BUY', 'OPEN', null, '62720.1'],
      ['SELL', 'OPEN', null, '65279.8'],
      ['BUY', 'CLOSE', '<long positionId>', null],
      ['SELL', 'CLOSE', '<short positionId>', null]
    ]);
    expect(planBitunixPilot({ ...input, maxExposureUsdt: '10' })).toMatchObject({ ok: false, problems: [expect.stringContaining('exceed the operator-approved exposure 10 USDT')] });
  });

  it('runs all four paths: stops attached, fills visible, clientId lookups, closing the long leaves the short untouched', async () => {
    const { x, v } = setup();
    const ev = await runBitunixPilot(v, x, { ...input, instrumentId: 'btc', paperAccountId: 'acct' }, { sleep: async () => {} });
    expect(ev.steps.map((s) => [s.step, s.ok])).toEqual([
      ['open LONG', true],
      ['open SHORT', true],
      ['both legs listed separately', true],
      ['close long; short untouched', true],
      ['close short', true]
    ]);
    expect(ev.steps[3]!.detail).toMatchObject({ shortBefore: '0.0001', shortAfter: '0.0001' });
    expect(ev.steps[0]!.detail).toMatchObject({ protection: { status: 'ACTIVE' }, lookupByClientId: { status: 'FILLED' } });
    expect(x.posts.map((p) => [p.side, p.tradeSide])).toEqual([
      ['BUY', 'OPEN'],
      ['SELL', 'OPEN'],
      ['BUY', 'CLOSE'],
      ['SELL', 'CLOSE']
    ]);
    expect(pilotReference(ev)).toMatch(/^bitunix-pilot:[0-9a-f]{64}$/);
    // Sanitized: no credentials or signatures in the evidence.
    expect(JSON.stringify(ev)).not.toMatch(/secret|api-key|sign|nonce/i);
  });

  it('stops at the first failed step: a missing attached stop ends the run', async () => {
    const { x, v } = setup();
    x.next = { attachStop: 'NO' };
    const ev = await runBitunixPilot(v, x, { ...input, instrumentId: 'btc', paperAccountId: 'acct' }, { sleep: async () => {} });
    expect(ev.steps.map((s) => [s.step, s.ok])).toEqual([['open LONG', false]]);
    expect(x.posts.filter((p) => p.tradeSide === 'OPEN')).toHaveLength(1);
  });
});
