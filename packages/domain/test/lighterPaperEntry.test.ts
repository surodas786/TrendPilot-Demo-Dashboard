// Lighter plan Step 3 (pure rules): the USDT-reference vs USDC-venue comparison is compared 1:1 only
// in PAPER under the approved, labelled assumption and refused otherwise; Lighter sizing uses the
// catalog's USDC order-value limits and no base-unit maximum; MEXC behaviour is unchanged.
import { describe, expect, it } from 'vitest';
import { EMPTY_RISK, evaluatePaperEntry, PAPER_USDT_USDC_PARITY, previewOrder, syntheticQuote, type EntryInput } from '../src';

const NOW = new Date('2026-11-17T10:00:00Z');
const LIGHTER_XAU = { contractMultiplier: '1', qtyStep: '0.0001', minQty: '0.0015', maxQty: null, priceTick: '0.01', takerFeeRate: '0', minNotional: '10', maxNotional: '5000000', quoteCurrency: 'USDC' };
const base = (o: Partial<EntryInput> = {}): EntryInput => ({
  side: 'LONG',
  settings: {
    orderCostUsdt: '100',
    leverage: 10,
    marginMode: 'ISOLATED',
    stop: { type: 'PERCENT', value: '1.5', basis: 'MARK' },
    takeProfitLong: { mode: 'OFF', levels: [] },
    takeProfitShort: { mode: 'OFF', levels: [] },
    trailingLong: { enabled: false, activationPct: null, distancePct: null, closePct: null, basis: 'MARK' }, trailingShort: { enabled: false, activationPct: null, distancePct: null, closePct: null, basis: 'MARK' },
    risk: EMPTY_RISK
  },
  version: { emaFilter: 'OFF', maxPriceDeviationPct: '0.5' },
  referencePrice: '3860',
  quote: { ...syntheticQuote('3860', NOW), source: 'LIGHTER_PUBLIC' },
  ema: null,
  spec: LIGHTER_XAU,
  account: { availableUsdt: '10000' },
  exposure: { openPositionInScope: false, unresolvedIntentInScope: false, openPositionsForOwner: 0 },
  now: NOW,
  ...o
});

describe('reference vs venue price comparison', () => {
  it('Paper: a USDT reference against a USDC Lighter price uses the labelled Paper-only parity', () => {
    const r = evaluatePaperEntry(base({ priceComparison: { referenceCurrency: 'USDT', venueCurrency: 'USDC', mode: 'PAPER' } }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.checks.comparison).toMatchObject({ policy: PAPER_USDT_USDC_PARITY, note: expect.stringMatching(/Paper only, not for Live/) });
    expect(r.checks.quote).toMatchObject({ source: 'LIGHTER_PUBLIC', currency: 'USDC' });
    expect(r.checks.reference).toEqual({ price: '3860', currency: 'USDT' });
  });

  it('Live, an unknown reference currency, or another pair of currencies: refused, never assumed', () => {
    expect(evaluatePaperEntry(base({ priceComparison: { referenceCurrency: 'USDT', venueCurrency: 'USDC', mode: 'LIVE' } }))).toMatchObject({ ok: false, reason: 'PRICE_COMPARISON_UNAVAILABLE' });
    expect(evaluatePaperEntry(base({ priceComparison: { referenceCurrency: null, venueCurrency: 'USDC', mode: 'PAPER' } }))).toMatchObject({ ok: false, reason: 'PRICE_COMPARISON_UNAVAILABLE' });
    expect(evaluatePaperEntry(base({ priceComparison: { referenceCurrency: 'USDC', venueCurrency: 'USDT', mode: 'PAPER' } }))).toMatchObject({ ok: false, reason: 'PRICE_COMPARISON_UNAVAILABLE' });
  });

  it('same currency (every MEXC / Bitunix decision, and decisions without the field) is compared as before', () => {
    const r = evaluatePaperEntry(base({ spec: { ...LIGHTER_XAU, quoteCurrency: undefined }, quote: { ...syntheticQuote('3860', NOW), source: 'MEXC_PUBLIC' } }));
    expect(r.ok && r.checks.comparison).toEqual({ policy: 'SAME_CURRENCY' });
    // The deviation check still applies under parity.
    expect(evaluatePaperEntry(base({ referencePrice: '3900', priceComparison: { referenceCurrency: 'USDT', venueCurrency: 'USDC', mode: 'PAPER' } }))).toMatchObject({ ok: false, reason: 'PRICE_DEVIATION' });
  });
});

describe('Lighter sizing limits', () => {
  const q = { ...syntheticQuote('3860', NOW), asOf: NOW.toISOString(), source: 'LIGHTER_PUBLIC' as const };
  const settings = (orderCostUsdt: string, leverage: number) => ({ ...base().settings, orderCostUsdt, leverage, direction: 'LONG_ONLY' as const });
  it('floors to the 0.0001 base step, labels USDC and has no base-unit maximum', () => {
    const p = previewOrder(settings('100', 10), LIGHTER_XAU, q).sides[0]!;
    expect(p.reasons).toEqual([]);
    expect(p.contracts).toMatch(/^0\.259/);
  });
  it('refuses below 10 USDC per order and above the catalog maximum per order', () => {
    expect(previewOrder(settings('5', 1), LIGHTER_XAU, q).sides[0]!.reasons.map((r) => r.message).join(' ')).toMatch(/below the exchange minimum of 10 USDC/);
    expect(previewOrder(settings('100', 10), { ...LIGHTER_XAU, maxNotional: '500' }, q).sides[0]!.reasons.map((r) => r.code)).toEqual(['SIZE_ABOVE_MAXIMUM']);
  });
});
