// CFG-03, CFG-04, UI-03, OPS-02
import { describe, expect, it } from 'vitest';
import {
  assertModeAllowed,
  catalogIssues,
  DomainError,
  exitAllocation,
  orderBlockCreateSchema,
  orderBlockPatchSchema,
  parseWith,
  type OrderBlockCreate
} from '../src';

const INSTRUMENT = '11111111-1111-4111-8111-111111111111';
const VERSION = '22222222-2222-4222-8222-222222222222';

function valid(overrides: Record<string, unknown> = {}) {
  return {
    instrumentId: INSTRUMENT,
    strategyVersionId: VERSION,
    mode: 'PAPER',
    direction: 'BOTH',
    orderCostUsdt: '100',
    leverage: 10,
    marginMode: 'ISOLATED',
    stop: { type: 'PERCENT', value: '1.5', basis: 'MARK' },
    takeProfit: { mode: 'FIXED', levels: [{ id: 'tp1', movePct: '3', closePct: '100' }] },
    trailing: { enabled: false, activationPct: null, distancePct: null, basis: 'MARK' },
    weekdays: ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'],
    allowAdds: false,
    maxAdds: null,
    risk: { maxOpenPositions: null, maxNotionalUsdt: null, maxStopRiskUsdt: null, dailyLossLimitUsdt: null, cooldownMinutes: null, maxSpreadPct: null, maxPriceDeviationPct: null },
    ...overrides
  };
}

const parse = (raw: unknown) => parseWith(orderBlockCreateSchema, raw);
const paths = (raw: unknown) => {
  const r = parse(raw);
  return r.ok ? [] : r.issues.map((i) => i.path);
};
const issues = (raw: unknown) => {
  const r = parse(raw);
  return r.ok ? [] : r.issues;
};

describe('order block schema', () => {
  it('accepts a valid block and normalises decimals', () => {
    const r = parse(valid({ orderCostUsdt: '100.50000000' }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.orderCostUsdt).toBe('100.5');
  });

  it.each(['0', '-1', 'abc', '1e3', '', '1.123456789'])('rejects order cost %j', (cost) => {
    expect(paths(valid({ orderCostUsdt: cost }))).toContain('orderCostUsdt');
  });

  it('rejects numeric (non-string) money', () => {
    expect(paths(valid({ orderCostUsdt: 100 }))).toContain('orderCostUsdt');
  });

  it('requires a stop', () => {
    const rest: Record<string, unknown> = valid();
    delete rest.stop;
    expect(paths(rest)).toContain('stop');
    expect(paths(valid({ stop: { type: 'PERCENT', value: '0', basis: 'MARK' } }))).toContain('stop.value');
    expect(paths(valid({ stop: { type: 'PERCENT', value: '100', basis: 'MARK' } }))).toContain('stop.value');
    expect(parse(valid({ stop: { type: 'PRICE', value: '48000', basis: 'LAST' } })).ok).toBe(true);
  });

  it('split TP must total 100% with increasing targets', () => {
    const split = (levels: unknown[]) => valid({ takeProfit: { mode: 'SPLIT', levels } });
    expect(parse(split([{ id: 'a', movePct: '2', closePct: '50' }, { id: 'b', movePct: '4', closePct: '50' }])).ok).toBe(true);
    expect(paths(split([{ id: 'a', movePct: '2', closePct: '50' }, { id: 'b', movePct: '4', closePct: '40' }]))).toContain('takeProfit');
    expect(paths(split([{ id: 'a', movePct: '4', closePct: '50' }, { id: 'b', movePct: '4', closePct: '50' }]))).toContain('takeProfit.levels.1.movePct');
    expect(paths(split([{ id: 'a', movePct: '2', closePct: '100' }]))).toContain('takeProfit.levels');
    expect(paths(split([{ id: 'a', movePct: '2', closePct: '50' }, { id: 'a', movePct: '3', closePct: '50' }]))).toContain('takeProfit.levels');
  });

  it('a split below 100% is valid only when Trailing Take Profit manages the remainder (EXT-07)', () => {
    const trail = { enabled: true, activationPct: '3', distancePct: '1', basis: 'MARK' };
    const levels = [{ id: 'a', movePct: '2', closePct: '50' }, { id: 'b', movePct: '4', closePct: '30' }];
    expect(parse(valid({ takeProfit: { mode: 'SPLIT', levels }, trailing: trail })).ok).toBe(true);
    expect(paths(valid({ takeProfit: { mode: 'SPLIT', levels } }))).toContain('takeProfit');
    const over = [{ id: 'a', movePct: '2', closePct: '60' }, { id: 'b', movePct: '4', closePct: '50' }];
    expect(paths(valid({ takeProfit: { mode: 'SPLIT', levels: over }, trailing: trail }))).toContain('takeProfit');
  });

  it('two exits never manage the same quantity: targets closing 100% leave nothing for Trailing Take Profit', () => {
    const trail = { enabled: true, activationPct: '0.3', distancePct: '0.1', basis: 'MARK' };
    const full = [{ id: 'a', movePct: '2', closePct: '50' }, { id: 'b', movePct: '4', closePct: '50' }];
    expect(issues(valid({ takeProfit: { mode: 'SPLIT', levels: full }, trailing: trail }))).toContainEqual({ path: 'takeProfit', message: expect.stringMatching(/nothing is left for Trailing Take Profit/) });
    expect(issues(valid({ trailing: trail }))).toContainEqual({ path: 'takeProfit.levels.0.closePct', message: expect.stringMatching(/nothing is left for Trailing Take Profit/) });
  });

  it('fixed TP closes 100% on its own, or its share when Trailing Take Profit manages the rest; OFF has no levels', () => {
    const trail = { enabled: true, activationPct: '0.3', distancePct: '0.1', basis: 'MARK' };
    expect(paths(valid({ takeProfit: { mode: 'FIXED', levels: [{ id: 'x', movePct: '3', closePct: '60' }] } }))).toContain('takeProfit.levels.0.closePct');
    expect(parse(valid({ takeProfit: { mode: 'FIXED', levels: [{ id: 'x', movePct: '3', closePct: '60' }] }, trailing: trail })).ok).toBe(true);
    expect(exitAllocation({ takeProfit: { mode: 'FIXED', levels: [{ id: 'x', movePct: '3', closePct: '60' }] }, trailing: trail as never })).toEqual({ targetsPct: '60', trailingPct: '40' });
    expect(parse(valid({ takeProfit: { mode: 'OFF', levels: [] } })).ok).toBe(true);
    expect(parse(valid({ takeProfit: { mode: 'OFF', levels: [] }, trailing: trail })).ok).toBe(true);
    expect(exitAllocation({ takeProfit: { mode: 'OFF', levels: [] }, trailing: trail as never })).toEqual({ targetsPct: '0', trailingPct: '100' });
  });

  it('Trailing Take Profit requires both Activate after profit and Trail distance — activation is never assumed', () => {
    const off = { takeProfit: { mode: 'OFF', levels: [] } };
    expect(issues(valid({ ...off, trailing: { enabled: true, activationPct: null, distancePct: '0.1', basis: 'MARK' } }))).toContainEqual({ path: 'trailing.activationPct', message: 'Enter Activate after profit (%).' });
    expect(issues(valid({ ...off, trailing: { enabled: true, activationPct: '0.3', distancePct: null, basis: 'MARK' } }))).toContainEqual({ path: 'trailing.distancePct', message: 'Enter Trail distance (%).' });
    expect(paths(valid({ ...off, trailing: { enabled: true, activationPct: '0', distancePct: '0.1', basis: 'MARK' } }))).toContain('trailing.activationPct');
    expect(parse(valid({ ...off, trailing: { enabled: true, activationPct: '0.3', distancePct: '0.1', basis: 'LAST' } })).ok).toBe(true);
    expect(paths(valid({ trailing: { enabled: false, activationPct: '0.3', distancePct: null, basis: 'MARK' } }))).toContain('trailing');
  });

  it('adds are off by default; maxAdds is required only when enabled', () => {
    expect(paths(valid({ allowAdds: true, maxAdds: null }))).toContain('maxAdds');
    expect(paths(valid({ allowAdds: true, maxAdds: 11 }))).toContain('maxAdds');
    expect(paths(valid({ allowAdds: false, maxAdds: 2 }))).toContain('maxAdds');
    expect(parse(valid({ allowAdds: true, maxAdds: 2 })).ok).toBe(true);
  });

  it('weekdays: empty set is valid; codes canonicalised; unknown rejected', () => {
    const empty = parse(valid({ weekdays: [] }));
    expect(empty.ok && empty.value.weekdays).toEqual([]);
    const shuffled = parse(valid({ weekdays: ['SAT', 'SUN', 'SAT'] }));
    expect(shuffled.ok && shuffled.value.weekdays).toEqual(['SUN', 'SAT']);
    expect(paths(valid({ weekdays: ['MON', 'XYZ'] }))).toContain('weekdays.1');
    expect(paths(valid({ weekdays: [0, 1] }))).toContain('weekdays.0');
  });

  it.each(['ownerId', 'owner_id', 'timezone', 'status', 'revision', 'accountId'])('rejects client-supplied %s', (key) => {
    expect(parse(valid({ [key]: 'x' })).ok).toBe(false);
  });

  it('patch schema refuses instrument and mode changes and unknown keys', () => {
    expect(parseWith(orderBlockPatchSchema, { orderCostUsdt: '5' }).ok).toBe(true);
    expect(parseWith(orderBlockPatchSchema, { mode: 'PAPER' }).ok).toBe(false);
    expect(parseWith(orderBlockPatchSchema, { instrumentId: INSTRUMENT }).ok).toBe(false);
    expect(parseWith(orderBlockPatchSchema, { ownerId: INSTRUMENT }).ok).toBe(false);
  });
});

describe('catalog checks', () => {
  const ctx = {
    instrument: { status: 'PUBLISHED' as const, leverageChoices: [1, 3, 5, 10] },
    version: { published: true, permittedDirections: 'LONG_ONLY' as const }
  };
  const s = (o: Partial<OrderBlockCreate>) => ({ leverage: 5, direction: 'LONG_ONLY' as const, ...o });

  it('leverage must be one of the instrument choices', () => {
    expect(catalogIssues(s({}), ctx)).toEqual([]);
    expect(catalogIssues(s({ leverage: 7 }), ctx).map((i) => i.path)).toEqual(['leverage']);
  });

  it('direction must be permitted by the strategy version', () => {
    expect(catalogIssues(s({ direction: 'BOTH' }), ctx).map((i) => i.path)).toEqual(['direction']);
    expect(catalogIssues(s({ direction: 'SHORT_ONLY' }), ctx).map((i) => i.path)).toEqual(['direction']);
    expect(catalogIssues(s({ direction: 'SHORT_ONLY' }), { ...ctx, version: { published: true, permittedDirections: 'BOTH' } })).toEqual([]);
  });

  it('unpublished instrument or version is rejected', () => {
    const issues = catalogIssues(s({}), {
      instrument: { status: 'DISABLED', leverageChoices: [5] },
      version: { published: false, permittedDirections: 'BOTH' }
    });
    expect(issues.map((i) => i.path)).toEqual(['instrumentId', 'strategyVersionId']);
  });
});

describe('mode gate (D1, OPS-02)', () => {
  it('allows PAPER and rejects LIVE with LIVE_DISABLED', () => {
    expect(() => assertModeAllowed('PAPER')).not.toThrow();
    let caught: unknown;
    try {
      assertModeAllowed('LIVE');
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(DomainError);
    expect((caught as DomainError).code).toBe('LIVE_DISABLED');
    expect((caught as DomainError).status).toBe(422);
  });
});
