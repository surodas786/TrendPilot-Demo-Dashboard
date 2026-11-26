// Investor Management revision (26 Nov 2026): partial exits 1-100 %, exchange rounding, rearm on the remainder.
import { describe, expect, it } from 'vitest';
import { advanceTrailing, commonExitDefinitionSchema, exitPlanChanges, liftLegacyExitPlan, parseWith, partialCloseContracts, partialExitCheck, previewOrder, EMPTY_RISK, type TrailingState } from '../src';

describe('partialCloseContracts: share of the pool, rounded down to the step; 100 % is exact', () => {
  it('10 units closing 40 % closes 4 and leaves 6', () => {
    expect(partialCloseContracts('10', '40', '1')).toBe('4');
    expect(partialExitCheck('4', '10', { qtyStep: '1', minQty: '1' })).toEqual({ ok: true });
  });
  it('rounds down to the step, never up', () => {
    expect(partialCloseContracts('7', '33.3', '1')).toBe('2');
    expect(partialCloseContracts('0.15', '50', '0.01')).toBe('0.07');
    expect(partialCloseContracts('1.239', '12.5', '0.001')).toBe('0.154');
  });
  it('100 % closes the whole pool exactly, even when it is not a step multiple', () => {
    expect(partialCloseContracts('0.157', '100', '0.01')).toBe('0.157');
    expect(partialCloseContracts('10', '100', '1')).toBe('10');
  });
  it('an empty pool closes nothing', () => {
    expect(partialCloseContracts('0', '40', '1')).toBe('0');
  });
});

describe('partialExitCheck: invalid partial quantities are reported, never widened to a full close', () => {
  const spec = { qtyStep: '0.01', minQty: '0.05' };
  it('a share that rounds to zero is refused', () => {
    expect(partialExitCheck('0', '1', spec)).toMatchObject({ ok: false, code: 'EXIT_BELOW_STEP' });
  });
  it('below the exchange minimum is refused', () => {
    expect(partialExitCheck('0.03', '1', spec)).toMatchObject({ ok: false, code: 'EXIT_BELOW_MINIMUM' });
  });
  it('a remainder below the minimum is refused', () => {
    expect(partialExitCheck('0.97', '1', spec)).toMatchObject({ ok: false, code: 'RESIDUAL_BELOW_MINIMUM' });
  });
  it('a quantity that is not a step multiple is refused', () => {
    expect(partialExitCheck('0.055', '1', spec)).toMatchObject({ ok: false, code: 'NOT_STEP_MULTIPLE' });
  });
  it('closing the whole remainder is always valid (exchange close path)', () => {
    expect(partialExitCheck('1', '1', spec)).toEqual({ ok: true });
    expect(partialExitCheck('0.02', '0.02', spec)).toEqual({ ok: true });
  });
});

describe('advanceTrailing: REARM after a completed partial cycle', () => {
  const cfg = { distancePct: '1', tick: '0.1' };
  const rearm = (extreme: string): TrailingState => ({ status: 'REARM', activationPrice: '101', watermark: extreme, level: '108.9', cycleExtreme: extreme });

  it('Long: nothing triggers again until a new high beyond the cycle extreme, then a fresh cycle starts from it', () => {
    // Still pulled back below the old level: no re-trigger of the same cycle.
    expect(advanceTrailing('LONG', rearm('110'), '108', cfg)).toMatchObject({ triggered: false, state: { status: 'REARM' } });
    // Back to the same extreme: not beyond it.
    expect(advanceTrailing('LONG', rearm('110'), '110', cfg)).toMatchObject({ triggered: false, state: { status: 'REARM' } });
    const s = advanceTrailing('LONG', rearm('110'), '111', cfg);
    expect(s).toMatchObject({ rearmed: true, triggered: false, state: { status: 'ACTIVE', watermark: '111', level: '109.8' } });
    // The new cycle triggers on its own retracement from the new extreme.
    expect(advanceTrailing('LONG', s.state, '109.8', cfg).triggered).toBe(true);
  });

  it('Short: mirrored (a new low beyond the cycle extreme)', () => {
    const st: TrailingState = { status: 'REARM', activationPrice: '99', watermark: '90', level: '90.9', cycleExtreme: '90' };
    expect(advanceTrailing('SHORT', st, '91', cfg).state.status).toBe('REARM');
    expect(advanceTrailing('SHORT', st, '89.5', cfg)).toMatchObject({ rearmed: true, state: { status: 'ACTIVE', watermark: '89.5', level: '90.4' } });
  });
});

describe('Common Exit Definition: the same fields and rules as an investor exit plan', () => {
  const OFF = { enabled: false, activationPct: null, distancePct: null, closePct: null, targetClose: null, basis: 'MARK' };
  const five = { mode: 'SPLIT', allocationPct: '80', levels: [1, 2, 3, 4, 5].map((i) => ({ id: `l${i}`, movePct: String(i), closePct: '20' })) };
  const plan = { takeProfitLong: five, takeProfitShort: { mode: 'OFF', levels: [] }, trailingLong: { enabled: true, activationPct: '1', distancePct: '0.5', closePct: '40', targetClose: { enabled: true, movePct: '6', closePct: '50' }, basis: 'MARK' }, trailingShort: OFF };
  it('accepts independent Long / Short, five split levels, allocation, trailing with target close', () => {
    expect(parseWith(commonExitDefinitionSchema, plan).ok).toBe(true);
  });
  it('refuses what an investor plan refuses (shares not totalling 100 %, close share 0)', () => {
    const bad = parseWith(commonExitDefinitionSchema, { ...plan, takeProfitLong: { ...five, levels: five.levels.map((l) => ({ ...l, closePct: '10' })) }, trailingShort: { ...OFF, enabled: true, activationPct: '1', distancePct: '1', closePct: '0' } });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.issues.map((i) => i.path)).toEqual(expect.arrayContaining(['takeProfitLong', 'trailingShort.closePct']));
  });
  it('lists changed fields for the audit log', () => {
    const r = parseWith(commonExitDefinitionSchema, plan);
    if (!r.ok) throw new Error('invalid');
    expect(exitPlanChanges(null, r.value).map((c) => c.field)).toEqual(['takeProfitLong', 'takeProfitShort', 'trailingLong', 'trailingShort']);
    expect(exitPlanChanges(r.value, { ...r.value, trailingShort: { ...r.value.trailingShort, basis: 'LAST' } }).map((c) => c.field)).toEqual(['trailingShort']);
  });
});

describe('preview: invalid partial exits are explained at configuration time', () => {
  const spec = { contractMultiplier: '1', qtyStep: '1', minQty: '1', maxQty: '1000', priceTick: '0.01', takerFeeRate: '0.0004' };
  const quote = { bid: '100', ask: '100', mark: '100', asOf: '2026-11-26T00:00:00Z', source: 'FIXTURE' as const };
  const base = (trailingLong: unknown) =>
    liftLegacyExitPlan({
      orderCostUsdt: '10',
      leverage: 10,
      direction: 'LONG_ONLY',
      stop: { type: 'PERCENT', value: '2', basis: 'MARK' },
      takeProfitLong: { mode: 'OFF', levels: [] },
      takeProfitShort: { mode: 'OFF', levels: [] },
      trailingLong,
      trailingShort: { enabled: false, activationPct: null, distancePct: null, closePct: null, basis: 'MARK' },
      risk: EMPTY_RISK
    }) as Parameters<typeof previewOrder>[0];
  it('1 contract, close 40 %: rounds to 0 → warned (it would not be sent)', () => {
    const p = previewOrder(base({ enabled: true, activationPct: '1', distancePct: '0.5', closePct: '40', basis: 'MARK' }), { ...spec }, quote);
    const long = p.sides[0]!;
    expect(long.contracts).toBe('1');
    expect(long.trailing).toMatchObject({ contracts: '1', firstCloseContracts: '0' });
    expect(long.exitWarnings).toEqual([expect.objectContaining({ exit: 'Trailing take profit', code: 'EXIT_BELOW_STEP' })]);
  });
  it('10 contracts, close 40 %: closes 4, no warning', () => {
    const p = previewOrder({ ...base({ enabled: true, activationPct: '1', distancePct: '0.5', closePct: '40', basis: 'MARK' }), orderCostUsdt: '100' }, spec, quote);
    expect(p.sides[0]!.trailing).toMatchObject({ contracts: '10', firstCloseContracts: '4' });
    expect(p.sides[0]!.exitWarnings).toEqual([]);
  });
});
