// STR-09 EMA 200 and STR-08 paper entry checks (fixture inputs).
import { describe, expect, it } from 'vitest';
import { applyEmaFilter, Decimal, emaAtSignalBar, EMPTY_RISK, estimateLiquidation, evaluatePaperEntry, fixtureCandles, syntheticQuote, type Candle, type EntryInput } from '../src';

const M15 = 15 * 60_000;
const BAR = new Date('2026-11-08T09:15:00Z');
const NOW = new Date('2026-11-08T09:30:03Z');
const candles = (trend: 'UP' | 'DOWN' | 'FLAT', count = 260) => fixtureCandles({ endBarOpen: BAR, intervalMs: M15, count, endClose: '65000', trend });

describe('EMA 200 (STR-09)', () => {
  it('seeds from the mean of the first 200 closes and applies 2/201 smoothing through the signal bar', () => {
    const cs = candles('UP', 202);
    const r = emaAtSignalBar(cs, BAR, M15);
    // Independent recomputation.
    const D = Decimal.clone({ precision: 50 });
    let ema = cs.slice(0, 200).reduce((s, c) => s.plus(c.close), new D(0)).div(200);
    for (const c of cs.slice(200)) ema = ema.plus(new D(2).div(201).times(new D(c.close).minus(ema)));
    expect(r.ok && r.ema).toBe(ema.toDecimalPlaces(12).toFixed());
    expect(r.ok && r.candlesUsed).toBe(202);
    expect(r.ok && r.close).toBe('65000');
  });

  it('exactly 200 closes gives the simple mean', () => {
    const cs = candles('UP', 200);
    const r = emaAtSignalBar(cs, BAR, M15);
    const mean = cs.reduce((s, c) => s.plus(c.close), new Decimal(0)).div(200);
    expect(r.ok && r.ema).toBe(mean.toDecimalPlaces(12).toFixed());
  });

  it('is deterministic', () => {
    expect(emaAtSignalBar(candles('UP'), BAR, M15)).toEqual(emaAtSignalBar(candles('UP'), BAR, M15));
  });

  it('missing aligned candle, forming candle, too little history or a gap → EMA_UNAVAILABLE', () => {
    const cs = candles('UP');
    expect(emaAtSignalBar(cs.slice(0, -1), BAR, M15)).toMatchObject({ ok: false, detail: 'NO_ALIGNED_CANDLE' });
    const forming: Candle[] = cs.map((c, i) => (i === cs.length - 1 ? { ...c, closed: false } : c));
    expect(emaAtSignalBar(forming, BAR, M15)).toMatchObject({ ok: false, detail: 'ALIGNED_CANDLE_NOT_CLOSED' });
    expect(emaAtSignalBar(candles('UP', 199), BAR, M15)).toMatchObject({ ok: false, detail: 'INSUFFICIENT_HISTORY', candlesAvailable: 199 });
    const gap = cs.filter((_, i) => i !== cs.length - 50); // hole 50 bars back
    expect(emaAtSignalBar(gap, BAR, M15)).toMatchObject({ ok: false, detail: 'INSUFFICIENT_HISTORY', candlesAvailable: 49 });
  });

  it('filter: long above, short below, equality blocks, Off bypasses even without data', () => {
    const up = emaAtSignalBar(candles('UP'), BAR, M15);
    const down = emaAtSignalBar(candles('DOWN'), BAR, M15);
    const flat = emaAtSignalBar(candles('FLAT'), BAR, M15);
    expect(applyEmaFilter('EMA200', 'LONG', up).pass).toBe(true);
    expect(applyEmaFilter('EMA200', 'SHORT', up)).toMatchObject({ pass: false, reason: 'EMA_FILTERED' });
    expect(applyEmaFilter('EMA200', 'SHORT', down).pass).toBe(true);
    expect(applyEmaFilter('EMA200', 'LONG', down)).toMatchObject({ pass: false, reason: 'EMA_FILTERED' });
    expect(applyEmaFilter('EMA200', 'LONG', flat)).toMatchObject({ pass: false, reason: 'EMA_FILTERED', detail: { relation: 'EQUAL' } });
    expect(applyEmaFilter('EMA200', 'SHORT', flat)).toMatchObject({ pass: false, reason: 'EMA_FILTERED' });
    expect(applyEmaFilter('EMA200', 'LONG', null)).toMatchObject({ pass: false, reason: 'EMA_UNAVAILABLE' });
    expect(applyEmaFilter('OFF', 'LONG', null).pass).toBe(true);
  });
});

describe('paper entry checks (STR-08, EXE-01/02)', () => {
  const BTC = { contractMultiplier: '0.0001', qtyStep: '1', minQty: '1', maxQty: '1000000', priceTick: '0.1', takerFeeRate: '0.0004' };
  const base = (o: Partial<EntryInput> = {}): EntryInput => ({
    side: 'LONG',
    settings: {
      orderCostUsdt: '100',
      leverage: 10,
      marginMode: 'ISOLATED',
      stop: { type: 'PERCENT', value: '1.5', basis: 'MARK' },
      takeProfitLong: { mode: 'OFF', levels: [] },
      takeProfitShort: { mode: 'OFF', levels: [] },
      trailing: { enabled: false, activationPct: null, distancePct: null, basis: 'MARK' },
      risk: EMPTY_RISK
    },
    version: { emaFilter: 'OFF', maxPriceDeviationPct: '0.5' },
    referencePrice: '65000.5',
    quote: { ...syntheticQuote('65000', NOW) },
    ema: null,
    spec: BTC,
    account: { availableUsdt: '10000' },
    exposure: { openPositionInScope: false, unresolvedIntentInScope: false, openPositionsForOwner: 0 },
    now: NOW,
    ...o
  });

  it('approves a flat long with sizing, stop and liquidation estimate', () => {
    const r = evaluatePaperEntry(base());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.sizing).toMatchObject({ side: 'LONG', entryPrice: '65000.5', contracts: '153', stopPrice: '64025.5' }) // 65000.5 × 0.985 = 64025.4925 → up to tick;
    expect(Number(r.liquidationPrice)).toBeLessThan(Number(r.sizing.stopPrice));
    expect(r.requiredUsdt).toBe(new Decimal(r.sizing.estimatedMarginUsdt).plus(r.sizing.estimatedEntryFeeUsdt).toFixed());
  });

  it('a short uses the bid and a stop above entry', () => {
    const r = evaluatePaperEntry(base({ side: 'SHORT' }));
    expect(r.ok && r.sizing).toMatchObject({ side: 'SHORT', entryPrice: '64999.5' });
    expect(r.ok && Number(r.sizing.stopPrice)).toBeGreaterThan(64999.5);
  });

  it.each([
    ['ORDER_UNCERTAIN', { exposure: { openPositionInScope: false, unresolvedIntentInScope: true, openPositionsForOwner: 0 } }],
    ['POSITION_NOT_FLAT', { exposure: { openPositionInScope: true, unresolvedIntentInScope: false, openPositionsForOwner: 1 } }],
    ['FEED_STALE', { quote: null }],
    ['FEED_STALE', { quote: syntheticQuote('65000', new Date(NOW.getTime() - 16_000)) }],
    ['SPREAD_TOO_WIDE', { quote: syntheticQuote('65000', NOW, '1000') }],
    ['PRICE_DEVIATION', { referencePrice: '66000' }],
    ['EMA_UNAVAILABLE', { version: { emaFilter: 'EMA200', maxPriceDeviationPct: '0.5' } }],
    ['SIZE_BELOW_MINIMUM', { settings: { ...base().settings, orderCostUsdt: '0.5', leverage: 1 } }],
    ['RISK_LIMIT', { settings: { ...base().settings, risk: { ...EMPTY_RISK, maxNotionalUsdt: '100' } } }],
    ['RISK_LIMIT', { exposure: { openPositionInScope: false, unresolvedIntentInScope: false, openPositionsForOwner: 20 } }],
    ['PROTECTION_FAILED', { settings: { ...base().settings, leverage: 100 } }],
    ['PROTECTION_FAILED', { settings: { ...base().settings, stop: { type: 'PRICE', value: '66000', basis: 'MARK' } } }],
    ['INSUFFICIENT_MARGIN', { account: { availableUsdt: '50' } }]
  ] as const)('%s', (reason, o) => {
    const r = evaluatePaperEntry(base(o as Partial<EntryInput>));
    expect(r.ok ? 'OK' : r.reason).toBe(reason);
  });

  it('liquidation estimate: long below entry, short above', () => {
    expect(Number(estimateLiquidation('LONG', '65000', 10))).toBeCloseTo(58825, 6);
    expect(Number(estimateLiquidation('SHORT', '65000', 10))).toBeCloseTo(71175, 6);
  });
});
