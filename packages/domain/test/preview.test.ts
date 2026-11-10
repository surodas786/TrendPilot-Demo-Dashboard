// EXE-01 sizing with fixture inputs (AT-06 units and rounding, minimum failures).
import { describe, expect, it } from 'vitest';
import { EMPTY_RISK, previewOrder, type ContractSpec, type Quote } from '../src';

const BTC: ContractSpec = { contractMultiplier: '0.0001', qtyStep: '1', minQty: '1', maxQty: '1000000', priceTick: '0.1', takerFeeRate: '0.0004' };
const quote: Quote = { bid: '64990.5', ask: '65000.0', mark: '64995.2', asOf: '2026-11-08T00:00:00Z', source: 'FIXTURE' };

const settings = (o: Record<string, unknown> = {}) =>
  ({
    orderCostUsdt: '100',
    leverage: 10,
    direction: 'BOTH',
    stop: { type: 'PERCENT', value: '1.5', basis: 'MARK' },
    takeProfit: { mode: 'FIXED', levels: [{ id: 'tp1', movePct: '3', closePct: '100' }] },
    trailing: { enabled: false, activationPct: null, distancePct: null, basis: 'MARK' },
    risk: EMPTY_RISK,
    ...o
  }) as Parameters<typeof previewOrder>[0];

describe('previewOrder', () => {
  it('sizes a long from the ask: 100 USDT × 10 at 65,000 = 153 contracts', () => {
    const p = previewOrder(settings(), BTC, quote);
    const long = p.sides.find((s) => s.side === 'LONG')!;
    expect(long).toMatchObject({
      entryPrice: '65000',
      entryPriceBasis: 'ASK',
      targetNotionalUsdt: '1000',
      rawContracts: '153.846154',
      contracts: '153',
      quantity: '0.0153',
      estimatedNotionalUsdt: '994.5',
      estimatedMarginUsdt: '99.45',
      estimatedEntryFeeUsdt: '0.3978',
      stopPrice: '64025',
      stopBasis: 'MARK',
      ok: true
    });
    // 0.0153 × 975 + entry fee 0.3978 + exit fee at stop 0.0153 × 64025 × 0.0004
    expect(long.lossToStopUsdt).toBe('15.71');
    expect(long.takeProfits).toEqual([{ id: 'tp1', price: '66950', closePct: '100', contracts: '153' }]);
    expect(long.trailing).toBeNull();
  });

  it('shows which quantity each exit manages: the fixed target its share, Trailing Take Profit the rest', () => {
    const p = previewOrder(settings({ takeProfit: { mode: 'FIXED', levels: [{ id: 'tp1', movePct: '3', closePct: '60' }] }, trailing: { enabled: true, activationPct: '1', distancePct: '0.5', basis: 'LAST' } }), BTC, quote);
    const long = p.sides.find((s) => s.side === 'LONG')!;
    const short = p.sides.find((s) => s.side === 'SHORT')!;
    // 153 × 60 % = 91.8 → 91 contracts (rounded down to the step); the other 62 trail.
    expect(long.takeProfits).toEqual([{ id: 'tp1', price: '66950', closePct: '60', contracts: '91' }]);
    // Activation is never closer than configured: Long 65000 × 1.01 rounded up, Short 64990.5 × 0.99 rounded down.
    expect(long.trailing).toEqual({ activationPrice: '65650', distancePct: '0.5', managesPct: '40', contracts: '62' });
    expect(short.trailing).toMatchObject({ activationPrice: '64340.5', managesPct: '40' });
    // Take profit off: Trailing Take Profit manages the whole position.
    const all = previewOrder(settings({ takeProfit: { mode: 'OFF', levels: [] }, trailing: { enabled: true, activationPct: '1', distancePct: '0.5', basis: 'LAST' } }), BTC, quote).sides[0]!;
    expect(all.trailing).toMatchObject({ managesPct: '100', contracts: all.contracts });
  });

  it('sizes a short from the bid and puts its stop above entry', () => {
    const short = previewOrder(settings(), BTC, quote).sides.find((s) => s.side === 'SHORT')!;
    expect(short.entryPriceBasis).toBe('BID');
    expect(short.entryPrice).toBe('64990.5');
    expect(Number(short.stopPrice)).toBeGreaterThan(64990.5);
    expect(Number(short.takeProfits[0]!.price)).toBeLessThan(64990.5);
  });

  it('only previews the permitted direction', () => {
    expect(previewOrder(settings({ direction: 'LONG_ONLY' }), BTC, quote).sides.map((s) => s.side)).toEqual(['LONG']);
    expect(previewOrder(settings({ direction: 'SHORT_ONLY' }), BTC, quote).sides.map((s) => s.side)).toEqual(['SHORT']);
  });

  it('never increases size to meet the minimum', () => {
    const long = previewOrder(settings({ orderCostUsdt: '0.5', leverage: 1 }), BTC, quote).sides[0]!;
    expect(long.contracts).toBe('0');
    expect(long.ok).toBe(false);
    expect(long.reasons.map((r) => r.code)).toContain('SIZE_BELOW_MINIMUM');
  });

  it('flags a price stop on the wrong side', () => {
    const long = previewOrder(settings({ direction: 'LONG_ONLY', stop: { type: 'PRICE', value: '66000', basis: 'MARK' } }), BTC, quote).sides[0]!;
    expect(long.reasons.map((r) => r.code)).toContain('STOP_WRONG_SIDE');
  });

  it('applies the investor\'s stricter notional and loss-to-stop caps', () => {
    const p = previewOrder(settings({ direction: 'LONG_ONLY', risk: { ...EMPTY_RISK, maxNotionalUsdt: '500', maxStopRiskUsdt: '10' } }), BTC, quote);
    expect(p.sides[0]!.reasons.filter((r) => r.code === 'RISK_LIMIT')).toHaveLength(2);
  });

  it('labels the quote as fixture data', () => {
    const p = previewOrder(settings(), BTC, quote);
    expect(p.quote.source).toBe('FIXTURE');
    expect(p.notes.join(' ')).toMatch(/Fixture quote/);
  });
});
