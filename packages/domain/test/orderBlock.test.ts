// CFG-03, CFG-04, UI-03, OPS-02
import { describe, expect, it } from 'vitest';
import {
  assertModeAllowed,
  catalogIssues,
  DomainError,
  allocateContracts,
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
    expect(paths(split([{ id: 'a', movePct: '2', closePct: '50' }, { id: 'b', movePct: '4', closePct: '40' }]))).toContain('takeProfitLong');
    expect(paths(split([{ id: 'a', movePct: '4', closePct: '50' }, { id: 'b', movePct: '4', closePct: '50' }]))).toContain('takeProfitLong.levels.1.movePct');
    expect(paths(split([{ id: 'a', movePct: '2', closePct: '100' }]))).toContain('takeProfitLong.levels');
    expect(paths(split([{ id: 'a', movePct: '2', closePct: '50' }, { id: 'a', movePct: '3', closePct: '50' }]))).toContain('takeProfitLong.levels');
  });

  it('split targets divide the Take Profit share: they always total exactly 100 %, with or without Trailing Take Profit', () => {
    const trail = { enabled: true, activationPct: '3', distancePct: '1', closePct: '40', basis: 'MARK' };
    const full = [{ id: 'a', movePct: '2', closePct: '62.5' }, { id: 'b', movePct: '4', closePct: '37.5' }];
    expect(parse(valid({ takeProfit: { mode: 'SPLIT', levels: full }, trailing: trail })).ok).toBe(true);
    const short = [{ id: 'a', movePct: '2', closePct: '50' }, { id: 'b', movePct: '4', closePct: '30' }];
    expect(issues(valid({ takeProfit: { mode: 'SPLIT', levels: short }, trailing: trail }))).toContainEqual({ path: 'takeProfitLong', message: expect.stringMatching(/total 80%/) });
    const over = [{ id: 'a', movePct: '2', closePct: '60' }, { id: 'b', movePct: '4', closePct: '50' }];
    expect(paths(valid({ takeProfit: { mode: 'SPLIT', levels: over }, trailing: trail }))).toContain('takeProfitLong');
  });

  it('Position to close (%) lives on Trailing Take Profit: 0 to 100 inclusive, decimals allowed, empty is not 0', () => {
    const t = (closePct: unknown) => valid({ trailing: { enabled: true, activationPct: '0.3', distancePct: '0.1', closePct, basis: 'MARK' } });
    for (const v of ['0', '40', '100', '12.5', '0.00000001']) expect(parse(t(v)).ok, v).toBe(true);
    expect(parse(t('40')).ok && (parse(t('40')) as { value: { trailing: { closePct: string } } }).value.trailing.closePct).toBe('40');
    for (const v of ['100.1', '-1', 'abc', '1.', '']) expect(paths(t(v)), v).toContain('trailing.closePct');
    expect(issues(t(null))).toContainEqual({ path: 'trailing.closePct', message: 'Enter Position to close (%), from 0 to 100.' });
    expect(issues(valid({ trailing: { enabled: true, activationPct: '0.3', distancePct: '0.1', basis: 'MARK' } }))).toContainEqual({ path: 'trailing.closePct', message: 'Enter Position to close (%), from 0 to 100.' });
    // Off: no allocation may be saved for it.
    expect(paths(valid({ trailing: { enabled: false, activationPct: null, distancePct: null, closePct: '40', basis: 'MARK' } }))).toContain('trailing');
  });

  it('a fixed target manages the whole Take Profit share; OFF has no levels', () => {
    const trail = { enabled: true, activationPct: '0.3', distancePct: '0.1', closePct: '40', basis: 'MARK' };
    expect(paths(valid({ takeProfit: { mode: 'FIXED', levels: [{ id: 'x', movePct: '3', closePct: '60' }] } }))).toContain('takeProfitLong.levels.0.closePct');
    expect(parse(valid({ trailing: trail })).ok).toBe(true);
    expect(parse(valid({ takeProfit: { mode: 'OFF', levels: [] } })).ok).toBe(true);
    expect(parse(valid({ takeProfit: { mode: 'OFF', levels: [] }, trailing: trail })).ok).toBe(true);
    expect(paths(valid({ takeProfit: { mode: 'OFF', levels: [{ id: 'x', movePct: '3', closePct: '100' }] } }))).toContain('takeProfitLong.levels');
  });

  it('exitAllocation / allocateContracts: 0 %, 40 %, 100 % with trailing on; trailing off; Take Profit off', () => {
    const on = (closePct: string) => ({ enabled: true, closePct });
    const FIXED = { mode: 'FIXED' as const };
    expect(exitAllocation({ takeProfit: FIXED, trailing: on('0') })).toEqual({ takeProfitPct: '100', trailingPct: '0', unallocatedPct: '0' });
    expect(exitAllocation({ takeProfit: FIXED, trailing: on('40') })).toEqual({ takeProfitPct: '60', trailingPct: '40', unallocatedPct: '0' });
    expect(exitAllocation({ takeProfit: FIXED, trailing: on('100') })).toEqual({ takeProfitPct: '0', trailingPct: '100', unallocatedPct: '0' });
    expect(exitAllocation({ takeProfit: FIXED, trailing: { enabled: false, closePct: null } })).toEqual({ takeProfitPct: '100', trailingPct: '0', unallocatedPct: '0' });
    // Take Profit off: what Trailing Take Profit does not take stays under the other exit rules.
    expect(exitAllocation({ takeProfit: { mode: 'OFF' }, trailing: on('40') })).toEqual({ takeProfitPct: '0', trailingPct: '40', unallocatedPct: '60' });
    expect(exitAllocation({ takeProfit: { mode: 'OFF' }, trailing: { enabled: false } })).toEqual({ takeProfitPct: '0', trailingPct: '0', unallocatedPct: '100' });
    // Contracts from the confirmed opening quantity: trailing rounds down to the step, Take Profit gets the exact rest.
    expect(allocateContracts('153', { takeProfit: FIXED, trailing: on('0') }, '1')).toEqual({ trailingContracts: '0', takeProfitContracts: '153' });
    expect(allocateContracts('153', { takeProfit: FIXED, trailing: on('40') }, '1')).toEqual({ trailingContracts: '61', takeProfitContracts: '92' });
    expect(allocateContracts('153', { takeProfit: FIXED, trailing: on('100') }, '1')).toEqual({ trailingContracts: '153', takeProfitContracts: '0' });
    expect(allocateContracts('153', { takeProfit: { mode: 'OFF' }, trailing: on('40') }, '1')).toEqual({ trailingContracts: '61', takeProfitContracts: '0' });
    expect(allocateContracts('1.5', { takeProfit: FIXED, trailing: on('40') }, '0.001')).toEqual({ trailingContracts: '0.6', takeProfitContracts: '0.9' });
  });

  it('never throws while a field is cleared or half-typed (Backspace): it reports field issues instead', () => {
    const trail = { enabled: true, activationPct: '', distancePct: '', closePct: '', basis: 'MARK' };
    const cases = [
      valid({ takeProfit: { mode: 'FIXED', levels: [{ id: 'a', movePct: '', closePct: '' }] }, trailing: trail }),
      valid({ takeProfit: { mode: 'SPLIT', levels: [{ id: 'a', movePct: '', closePct: '50' }, { id: 'b', movePct: '4', closePct: '' }] } }),
      valid({ takeProfit: { mode: 'SPLIT', levels: [{ id: 'a', movePct: '2.', closePct: '.' }, { id: 'b', movePct: '4', closePct: '50' }] } }),
      valid({ stop: { type: 'PERCENT', value: '', basis: 'MARK' }, orderCostUsdt: '' })
    ];
    for (const c of cases) {
      expect(() => parse(c)).not.toThrow();
      expect(parse(c).ok).toBe(false);
    }
    expect(paths(cases[0])).toEqual(expect.arrayContaining(['takeProfitLong.levels.0.movePct', 'trailing.closePct']));
  });

  it('Trailing Take Profit requires Activate after profit and Trail distance — activation is never assumed', () => {
    const off = { takeProfit: { mode: 'OFF', levels: [] } };
    expect(issues(valid({ ...off, trailing: { enabled: true, activationPct: null, distancePct: '0.1', closePct: '100', basis: 'MARK' } }))).toContainEqual({ path: 'trailing.activationPct', message: 'Enter Activate after profit (%).' });
    expect(issues(valid({ ...off, trailing: { enabled: true, activationPct: '0.3', distancePct: null, closePct: '100', basis: 'MARK' } }))).toContainEqual({ path: 'trailing.distancePct', message: 'Enter Trail distance (%).' });
    expect(paths(valid({ ...off, trailing: { enabled: true, activationPct: '0', distancePct: '0.1', closePct: '100', basis: 'MARK' } }))).toContain('trailing.activationPct');
    expect(parse(valid({ ...off, trailing: { enabled: true, activationPct: '0.3', distancePct: '0.1', closePct: '100', basis: 'LAST' } })).ok).toBe(true);
    expect(paths(valid({ trailing: { enabled: false, activationPct: '0.3', distancePct: null, basis: 'MARK' } }))).toContain('trailing');
  });

  it('trading window: optional HH:mm Start and End, never equal; omitted or null = All day', () => {
    expect(parse(valid({})).ok).toBe(true);
    expect(parse(valid({ tradingWindow: null })).ok).toBe(true);
    expect(parse(valid({ tradingWindow: { start: '22:00', end: '02:00' } })).ok).toBe(true);
    expect(parse(valid({ tradingWindow: { start: '00:00', end: '23:59' } })).ok).toBe(true);
    expect(paths(valid({ tradingWindow: { start: '24:00', end: '02:00' } }))).toContain('tradingWindow.start');
    expect(paths(valid({ tradingWindow: { start: '9:00', end: '17:00' } }))).toContain('tradingWindow.start');
    expect(paths(valid({ tradingWindow: { start: '09:00', end: '' } }))).toContain('tradingWindow.end');
    expect(paths(valid({ tradingWindow: { start: '09:00', end: '09:00' } }))).toContain('tradingWindow.end');
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

  it('patch schema refuses instrument changes and unknown keys; a mode change is accepted for the server to check', () => {
    expect(parseWith(orderBlockPatchSchema, { orderCostUsdt: '5' }).ok).toBe(true);
    expect(parseWith(orderBlockPatchSchema, { mode: 'LIVE' }).ok).toBe(true);
    expect(parseWith(orderBlockPatchSchema, { mode: 'DEMO' }).ok).toBe(false);
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
  it('allows PAPER and LIVE and rejects anything else with LIVE_DISABLED', () => {
    expect(() => assertModeAllowed('PAPER')).not.toThrow();
    expect(() => assertModeAllowed('LIVE')).not.toThrow();
    let caught: unknown;
    try {
      assertModeAllowed('DEMO' as never);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(DomainError);
    expect((caught as DomainError).code).toBe('LIVE_DISABLED');
    expect((caught as DomainError).status).toBe(422);
  });
});

describe('per-side Take Profit (Long and Short independent)', () => {
  const LONG = { mode: 'FIXED', levels: [{ id: 'L', movePct: '2', closePct: '100' }] };
  const SHORT = { mode: 'SPLIT', levels: [{ id: 'a', movePct: '1', closePct: '60' }, { id: 'b', movePct: '2', closePct: '40' }] };
  const perSide = (o: Record<string, unknown> = {}) => {
    const { takeProfit: _shared, ...rest } = valid(o);
    void _shared;
    return { ...rest, takeProfitLong: LONG, takeProfitShort: SHORT, ...o };
  };

  it('accepts different Long and Short configurations', () => {
    const r = parse(perSide());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toMatchObject({ takeProfitLong: { mode: 'FIXED' }, takeProfitShort: { mode: 'SPLIT' } });
  });

  it('a shared `takeProfit` from an older client becomes both sides', () => {
    const r = parse(valid());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.takeProfitShort).toEqual(r.value.takeProfitLong);
  });

  it('reports each side under its own path', () => {
    const bad = { mode: 'SPLIT', levels: [{ id: 'a', movePct: '1', closePct: '50' }, { id: 'b', movePct: '2', closePct: '30' }] };
    expect(paths(perSide({ takeProfitShort: bad }))).toEqual(['takeProfitShort']);
    expect(paths(perSide({ takeProfitLong: bad }))).toEqual(['takeProfitLong']);
  });

  it('validates both sides whatever the direction, and keeps the untraded side as saved', () => {
    const bad = { mode: 'FIXED', levels: [] };
    expect(paths(perSide({ direction: 'SHORT_ONLY', takeProfitLong: bad }))).toEqual(['takeProfitLong.levels']);
    expect(paths(perSide({ direction: 'LONG_ONLY', takeProfitLong: bad }))).toEqual(['takeProfitLong.levels']);
    const r = parse(perSide({ direction: 'LONG_ONLY' }));
    expect(r.ok && r.value.takeProfitShort).toEqual(SHORT);
  });

  it('a percentage cleared with Backspace is a field message, never an exception', () => {
    const cleared = { mode: 'FIXED', levels: [{ id: 'L', movePct: '', closePct: '100' }] };
    expect(() => parse(perSide({ takeProfitShort: cleared }))).not.toThrow();
    expect(paths(perSide({ takeProfitShort: cleared }))).toContain('takeProfitShort.levels.0.movePct');
  });
});
