import { describe, expect, it } from 'vitest';
import {
  buildOpenWithStop,
  Decimal,
  buildReduceOnlyClose,
  checkLighterSize,
  decideUncertainTx,
  decimalsOfStep,
  fromScaledInt,
  LIGHTER_GROUPING,
  LIGHTER_ORDER_TYPE,
  LIGHTER_STOP_EXPIRY_MS,
  LIGHTER_TIF,
  missingLiveInputs,
  planStopRenewal,
  smallestLighterSize,
  toScaledInt,
  validateLighterConnection,
  worstPrice
} from '../src';

const XAU = { marketId: 92, sizeDecimals: 4, priceDecimals: 2, minBaseAmount: '0.0015', minQuoteAmount: '10', maxQuoteAmount: '1000000' };
const KEY = 'a1'.repeat(40);

describe('Lighter connection input', () => {
  it('accepts mainnet, a user account index, key index 4–254 and a 40-byte API private key (0x optional)', () => {
    const r = validateLighterConnection({ environment: 'mainnet', accountIndex: '4242', apiKeyIndex: 5, apiPrivateKey: `0x${KEY.toUpperCase()}` });
    expect(r).toEqual({ ok: true, value: { environment: 'MAINNET', accountIndex: 4242, apiKeyIndex: 5, apiPrivateKey: KEY } });
  });
  it('refuses reserved key indexes, system accounts, testnet in this release and anything that is not an API key', () => {
    for (const k of [0, 3, 255, '4.5']) expect(validateLighterConnection({ environment: 'MAINNET', accountIndex: 10, apiKeyIndex: k, apiPrivateKey: KEY }).ok).toBe(false);
    for (const a of [0, 2, -1, 2 ** 48]) expect(validateLighterConnection({ environment: 'MAINNET', accountIndex: a, apiKeyIndex: 5, apiPrivateKey: KEY }).ok).toBe(false);
    expect(validateLighterConnection({ environment: 'TESTNET', accountIndex: 10, apiKeyIndex: 5, apiPrivateKey: KEY })).toMatchObject({ ok: false, issues: [expect.stringMatching(/mainnet only/)] });
    // A wallet seed phrase or a 32-byte wallet private key is not a Lighter API key; the message never echoes it.
    const seed = 'abandon ability able about above absent absorb abstract absurd abuse access accident';
    const r = validateLighterConnection({ environment: 'MAINNET', accountIndex: 10, apiKeyIndex: 5, apiPrivateKey: seed });
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain('abandon');
    expect(validateLighterConnection({ environment: 'MAINNET', accountIndex: 10, apiKeyIndex: 5, apiPrivateKey: 'ab'.repeat(32) }).ok).toBe(false);
  });
});

describe('integer scaling', () => {
  it('derives decimals from power-of-ten steps and scales exactly', () => {
    expect(decimalsOfStep('0.000100000000')).toBe(4);
    expect(decimalsOfStep('0.01')).toBe(2);
    expect(() => decimalsOfStep('0.0025')).toThrow();
    expect(toScaledInt('0.01239', 4, 'DOWN')).toBe('123');
    expect(toScaledInt('2400.101', 2, 'UP')).toBe('240011');
    expect(() => toScaledInt('2400.101', 2, 'EXACT')).toThrow();
    expect(fromScaledInt('123', 4)).toBe('0.0123');
  });
  it('bounds taker prices without exceeding the configured slippage: buys ≤ ref×(1+p), sells ≥ ref×(1−p)', () => {
    expect(worstPrice(false, '2400.10', '0.5', 2)).toBe('241210'); // 2412.1005 → down to the tick
    expect(worstPrice(true, '2399.90', '0.5', 2)).toBe('238791'); // 2387.9005 → up to the tick
  });
  it('applies max(min_base_amount, min_quote_amount) and the per-order USDC limit', () => {
    expect(checkLighterSize('0.0014', '2400', XAU)).toMatch(/QTY_BELOW_MIN/);
    expect(checkLighterSize('0.0040', '2400', XAU)).toMatch(/NOTIONAL_BELOW_MIN/); // 9.6 USDC
    expect(checkLighterSize('0.0042', '2400', XAU)).toBeNull();
    expect(checkLighterSize('500', '2400', XAU)).toMatch(/NOTIONAL_ABOVE_MAX/);
  });
  it('requires every live input that Lighter does not provide', () => {
    expect(missingLiveInputs({ entryWorstPricePct: null, stopWorstPricePct: '1', closeWorstPricePct: null, takerFeeRate: null }, 'OPEN')).toEqual(['entryWorstPricePct', 'takerFeeRate']);
    expect(missingLiveInputs({ entryWorstPricePct: null, stopWorstPricePct: null, closeWorstPricePct: '0.5', takerFeeRate: null }, 'CLOSE')).toEqual([]);
  });
});

describe('signed order shapes', () => {
  const base = { rules: XAU, baseAmount: '100', entryWorstPrice: '241210', stopTrigger: '230000', stopWorstPrice: '228850', entryClientOrderIndex: 1001, stopClientOrderIndex: 1002, nowMs: 1_000 };
  it('Long: OTO of a buy MARKET IOC and a SELL reduce-only STOP_LOSS on the mark price (child size 0: Lighter sizes it), 28-day expiry', () => {
    const g = buildOpenWithStop({ side: 'LONG', ...base });
    expect(g.groupingType).toBe(LIGHTER_GROUPING.OTO);
    expect(g.orders[0]).toMatchObject({ MarketIndex: 92, ClientOrderIndex: 1001, BaseAmount: '100', IsAsk: 0, Type: LIGHTER_ORDER_TYPE.MARKET, TimeInForce: LIGHTER_TIF.IOC, ReduceOnly: 0, OrderExpiry: 0 });
    expect(g.orders[1]).toMatchObject({ ClientOrderIndex: 1002, BaseAmount: '0', IsAsk: 1, Type: LIGHTER_ORDER_TYPE.STOP_LOSS, ReduceOnly: 1, TriggerPrice: '230000', OrderExpiry: 1_000 + LIGHTER_STOP_EXPIRY_MS });
  });
  it('Short: sell entry, BUY reduce-only stop', () => {
    const g = buildOpenWithStop({ side: 'SHORT', ...base });
    expect([g.orders[0].IsAsk, g.orders[1].IsAsk, g.orders[1].ReduceOnly]).toEqual([1, 0, 1]);
  });
  it('closes are reduce-only market IOC on the side that reduces the position', () => {
    expect(buildReduceOnlyClose({ positionSide: 'LONG', marketId: 92, baseAmount: '50', worstPrice: '238790', clientOrderIndex: 7 })).toMatchObject({ IsAsk: 1, ReduceOnly: 1, Type: LIGHTER_ORDER_TYPE.MARKET, TimeInForce: LIGHTER_TIF.IOC });
    expect(buildReduceOnlyClose({ positionSide: 'SHORT', marketId: 92, baseAmount: '50', worstPrice: '241210', clientOrderIndex: 8 }).IsAsk).toBe(0);
  });
});

describe('uncertain transaction procedure (docs: Retrying safely)', () => {
  it.each([
    [2, 8, 7, 'EXECUTED'],
    [1, 8, 7, 'WAIT'],
    [3, 8, 7, 'WAIT'],
    [0, 8, 7, 'FAILED_NONCE_CONSUMED'],
    [0, 7, 7, 'FAILED_RESEND_SAME_NONCE'],
    [null, 7, 7, 'RESEND_SAME_NONCE'],
    [null, 6, 7, 'WAIT'],
    [null, 9, 7, 'UNKNOWN']
  ] as const)('status %s, next nonce %s, our nonce %s → %s', (txStatus, nextNonce, nonce, want) => {
    expect(decideUncertainTx({ txStatus, nextNonce, nonce })).toBe(want);
  });
});

describe('native stop expiry: renewal plan (Step 5)', () => {
  const H = 3600_000;
  const base = { nowMs: 1_000 * H, leadMs: 72 * H, renewVerified: true, previous: null };
  it('nothing to do far from expiry, or without a configured lead time', () => {
    expect(planStopRenewal({ ...base, expiresAtMs: base.nowMs + 200 * H }).action).toBe('NONE');
    expect(planStopRenewal({ ...base, leadMs: null, expiresAtMs: base.nowMs + 1 * H })).toMatchObject({ action: 'NONE', reason: expect.stringMatching(/LEAD_UNSET/) });
  });
  it('expired or unknown expiry: alert (protection lost)', () => {
    expect(planStopRenewal({ ...base, expiresAtMs: base.nowMs })).toMatchObject({ action: 'ALERT', reason: expect.stringMatching(/STOP_EXPIRED/) });
    expect(planStopRenewal({ ...base, expiresAtMs: null })).toMatchObject({ action: 'ALERT', reason: expect.stringMatching(/UNKNOWN/) });
  });
  it('due: renew only when the capability is verified, otherwise alert', () => {
    expect(planStopRenewal({ ...base, expiresAtMs: base.nowMs + 10 * H })).toEqual({ action: 'RENEW', attemptKey: `renew:${base.nowMs + 10 * H}` });
    expect(planStopRenewal({ ...base, renewVerified: false, expiresAtMs: base.nowMs + 10 * H })).toMatchObject({ action: 'ALERT', reason: expect.stringMatching(/disabled/) });
  });
  it('pending attempt → wait (no duplicate); rejected → alert, no automatic retry; confirmed → nothing', () => {
    const exp = base.nowMs + 10 * H;
    const key = `renew:${exp}`;
    expect(planStopRenewal({ ...base, expiresAtMs: exp, previous: { attemptKey: key, status: 'PENDING' } }).action).toBe('WAIT');
    expect(planStopRenewal({ ...base, expiresAtMs: exp, previous: { attemptKey: key, status: 'REJECTED' } })).toMatchObject({ action: 'ALERT', reason: expect.stringMatching(/REJECTED/) });
    expect(planStopRenewal({ ...base, expiresAtMs: exp, previous: { attemptKey: key, status: 'CONFIRMED' } }).action).toBe('NONE');
    // A duplicate trigger for the same expiry yields the same idempotency key.
    expect(planStopRenewal({ ...base, expiresAtMs: exp })).toEqual(planStopRenewal({ ...base, expiresAtMs: exp }));
  });
});

describe('smallest valid Lighter size (XAU pilot runbook)', () => {
  const XAU_RULES = { sizeDecimals: 4, minBaseAmount: '0.0015', minQuoteAmount: '10' };
  it.each([
    ['3854.13', '0.0026'], // observed mainnet ask 2026-11-17: 0.0015 XAU would be only 5.78 USDC
    ['4000', '0.0025'], // exactly 10 USDC: no rounding needed
    ['7000', '0.0015'], // 0.0015 XAU = 10.5 USDC: the base minimum governs
    ['2000.01', '0.0050'] // 10 / 2000.01 = 0.0049999… → up to 0.0050
  ])('at %s USDC the smallest valid size is %s XAU', (price, want) => {
    const q = smallestLighterSize(XAU_RULES, price);
    expect(q).toBe(want);
    const step = new Decimal('0.0001');
    // A valid increment, meets both minimums, and one step less would not.
    expect(new Decimal(q).mod(step).isZero()).toBe(true);
    expect(checkLighterSize(q, price, { ...XAU_RULES, marketId: 92, priceDecimals: 2, maxQuoteAmount: null })).toBeNull();
    expect(checkLighterSize(new Decimal(q).minus(step).toFixed(), price, { ...XAU_RULES, marketId: 92, priceDecimals: 2, maxQuoteAmount: null })).not.toBeNull();
  });
  it('headroom raises the quote minimum only', () => {
    expect(smallestLighterSize(XAU_RULES, '3854.13', '2')).toBe('0.0027'); // 10.2 / 3854.13 = 0.002646… → 0.0027
    expect(smallestLighterSize({ sizeDecimals: 4, minBaseAmount: '0.005', minQuoteAmount: '10' }, '3000.50', '2')).toBe('0.0050'); // testnet ETH
  });
});
