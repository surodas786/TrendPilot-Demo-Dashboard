// CFG-02 version settings, UI-05 pair input, CFG-03 risk ceilings.
import { describe, expect, it } from 'vitest';
import { instrumentCreateSchema, orderBlockSettingsSchema, PAPER_TEMPLATE, parseWith, PLATFORM_CEILINGS, strategyVersionDraftSchema } from '../src';

const PAIR = '5a9f3b2c-0000-4000-8000-000000000001';

describe('strategy version draft', () => {
  const draft = (o: Record<string, unknown> = {}) => ({ ...PAPER_TEMPLATE, instrumentIds: [PAIR], ...o });

  it('accepts 5m and 15m, EMA 200 on/off and all opposite-signal policies', () => {
    for (const timeframe of ['5m', '15m'])
      for (const emaFilter of ['OFF', 'EMA200'])
        for (const oppositePolicy of ['KEEP_OPEN', 'CLOSE_ONLY', 'CLOSE_AND_REVERSE']) {
          expect(parseWith(strategyVersionDraftSchema, draft({ timeframe, emaFilter, oppositePolicy })).ok).toBe(true);
        }
  });

  it('rejects other timeframes, bad Supertrend parameters and empty pair mappings', () => {
    const bad = (o: Record<string, unknown>) => parseWith(strategyVersionDraftSchema, draft(o)).ok;
    expect(bad({ timeframe: '1h' })).toBe(false);
    expect(bad({ atrLength: 0 })).toBe(false);
    expect(bad({ atrFactor: '0' })).toBe(false);
    expect(bad({ atrFactor: '25' })).toBe(false);
    expect(bad({ instrumentIds: [] })).toBe(false);
    expect(bad({ extra: 1 })).toBe(false);
  });
});

describe('pair input', () => {
  it('normalises the ticker and requires suggested exits', () => {
    const r = parseWith(instrumentCreateSchema, { symbol: ' solusdt ', suggestedStopPct: '2', suggestedTakeProfitPct: '4', suggestedTrailingEnabled: false, suggestedTrailingPct: '1' });
    expect(r.ok && r.value.symbol).toBe('SOLUSDT');
    expect(parseWith(instrumentCreateSchema, { symbol: 'BTC-PERP', suggestedStopPct: '2', suggestedTakeProfitPct: '4', suggestedTrailingEnabled: false, suggestedTrailingPct: '1' }).ok).toBe(false);
  });
});

describe('risk caps', () => {
  const base = {
    strategyVersionId: '7c1e0d4a-0000-4000-8000-000000000101',
    direction: 'BOTH',
    orderCostUsdt: '100',
    leverage: 5,
    marginMode: 'ISOLATED',
    stop: { type: 'PERCENT', value: '2', basis: 'MARK' },
    takeProfit: { mode: 'OFF', levels: [] },
    trailing: { enabled: false, activationPct: null, distancePct: null, basis: 'MARK' },
    weekdays: ['MON'],
    allowAdds: false,
    maxAdds: null
  };
  const risk = (o: Record<string, unknown>) => ({
    maxOpenPositions: null,
    maxNotionalUsdt: null,
    maxStopRiskUsdt: null,
    dailyLossLimitUsdt: null,
    cooldownMinutes: null,
    maxSpreadPct: null,
    maxPriceDeviationPct: null,
    ...o
  });

  it('accepts stricter investor caps and rejects values above platform ceilings', () => {
    expect(parseWith(orderBlockSettingsSchema, { ...base, risk: risk({ maxOpenPositions: 3, dailyLossLimitUsdt: '50', cooldownMinutes: 30 }) }).ok).toBe(true);
    expect(parseWith(orderBlockSettingsSchema, { ...base, risk: risk({ maxOpenPositions: PLATFORM_CEILINGS.maxOpenPositions + 1 }) }).ok).toBe(false);
    expect(parseWith(orderBlockSettingsSchema, { ...base, risk: risk({ maxSpreadPct: '3' }) }).ok).toBe(false);
    expect(parseWith(orderBlockSettingsSchema, { ...base, orderCostUsdt: '100001', risk: risk({}) }).ok).toBe(false);
  });

  it('requires trailing values to be cleared when trailing is off', () => {
    const r = parseWith(orderBlockSettingsSchema, { ...base, trailing: { enabled: false, activationPct: '1', distancePct: null, basis: 'MARK' }, risk: risk({}) });
    expect(r.ok).toBe(false);
  });
});
