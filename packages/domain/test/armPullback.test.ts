import { describe, expect, it } from 'vitest';
import { advanceTarget, planExits } from '../src';

describe('take-profit arm-then-pullback rule', () => {
  it('Long: the first touch only arms; a later price strictly back below the target triggers', () => {
    expect(advanceTarget('LONG', 'ARM_PULLBACK', false, '99.9', '100')).toEqual({ arm: false, trigger: false });
    expect(advanceTarget('LONG', 'ARM_PULLBACK', false, '100', '100')).toEqual({ arm: true, trigger: false }); // touch arms, never closes
    expect(advanceTarget('LONG', 'ARM_PULLBACK', false, '105', '100')).toEqual({ arm: true, trigger: false });
    expect(advanceTarget('LONG', 'ARM_PULLBACK', true, '101', '100')).toEqual({ arm: false, trigger: false }); // still above
    expect(advanceTarget('LONG', 'ARM_PULLBACK', true, '100', '100')).toEqual({ arm: false, trigger: false }); // at, not through
    expect(advanceTarget('LONG', 'ARM_PULLBACK', true, '99.99', '100')).toEqual({ arm: false, trigger: true });
  });

  it('Short (mirrored): the first touch at or below arms; a later price strictly back above triggers', () => {
    expect(advanceTarget('SHORT', 'ARM_PULLBACK', false, '100.1', '100')).toEqual({ arm: false, trigger: false });
    expect(advanceTarget('SHORT', 'ARM_PULLBACK', false, '100', '100')).toEqual({ arm: true, trigger: false });
    expect(advanceTarget('SHORT', 'ARM_PULLBACK', false, '95', '100')).toEqual({ arm: true, trigger: false });
    expect(advanceTarget('SHORT', 'ARM_PULLBACK', true, '99', '100')).toEqual({ arm: false, trigger: false });
    expect(advanceTarget('SHORT', 'ARM_PULLBACK', true, '100.01', '100')).toEqual({ arm: false, trigger: true });
  });

  it('legacy TOUCH targets (positions opened before) still close when reached', () => {
    expect(advanceTarget('LONG', 'TOUCH', false, '100', '100')).toEqual({ arm: false, trigger: true });
    expect(advanceTarget('SHORT', 'TOUCH', false, '101', '100')).toEqual({ arm: false, trigger: false });
  });
});

describe('planExits: overall Take Profit allocation of the confirmed opening quantity; the rest is the trailing pool', () => {
  const spec = { priceTick: '0.1', qtyStep: '1' };
  const FIXED = { mode: 'FIXED' as const, levels: [{ id: 'tp', movePct: '1', closePct: '100' }] };
  const SPLIT = { mode: 'SPLIT' as const, levels: [{ id: 'a', movePct: '1', closePct: '50' }, { id: 'b', movePct: '2', closePct: '50' }] };
  const alloc = <T extends object>(tp: T, allocationPct: string) => ({ ...tp, allocationPct });
  const on = { enabled: true };

  it('Take Profit 100 %: targets get everything; 60 %: 60 / pool 40; 0 %: the pool gets everything (no target rows)', () => {
    expect(planExits('LONG', '100', '100', { takeProfit: alloc(FIXED, '100'), trailing: on }, spec)).toMatchObject({ trailingContracts: '0', takeProfitContracts: '100', targets: [{ levelId: 'tp', plannedContracts: '100' }] });
    expect(planExits('LONG', '100', '100', { takeProfit: alloc(FIXED, '60'), trailing: on }, spec)).toMatchObject({ trailingContracts: '40', takeProfitContracts: '60', targets: [{ plannedContracts: '60', triggerPrice: '101' }] });
    expect(planExits('LONG', '100', '100', { takeProfit: alloc(FIXED, '0'), trailing: on }, spec)).toMatchObject({ trailingContracts: '100', takeProfitContracts: '0', targets: [] });
    // A plan saved before the field existed manages 100 %.
    expect(planExits('LONG', '100', '100', { takeProfit: FIXED, trailing: on }, spec)).toMatchObject({ trailingContracts: '0', takeProfitContracts: '100' });
  });

  it('Split divides the Take Profit allocation between targets; the last gets the exact rest (same rounding as the shared-trailing rules)', () => {
    const p = planExits('SHORT', '100', '153', { takeProfit: alloc(SPLIT, '60'), trailing: on }, spec);
    expect(p.trailingContracts).toBe('61');
    expect(p.targets.map((t) => [t.levelId, t.plannedContracts, t.triggerPrice])).toEqual([
      ['a', '46', '99'],
      ['b', '46', '98']
    ]);
  });

  it('trailing off: the non-Take-Profit share is unallocated; Take Profit off: the whole position is the trailing pool', () => {
    expect(planExits('LONG', '100', '7', { takeProfit: FIXED, trailing: { enabled: false } }, spec)).toMatchObject({ trailingContracts: '0', targets: [{ plannedContracts: '7' }] });
    expect(planExits('LONG', '100', '7', { takeProfit: { mode: 'OFF', levels: [] }, trailing: on }, spec)).toEqual({ trailingContracts: '7', takeProfitContracts: '0', targets: [] });
  });

  it('five split levels with stable IDs: shares of the Take Profit allocation, the last gets the exact rest', () => {
    const five = { mode: 'SPLIT' as const, allocationPct: '100', levels: ['l1', 'l2', 'l3', 'l4', 'l5'].map((id, i) => ({ id, movePct: String(i + 1), closePct: '20' })) };
    const p = planExits('LONG', '100', '103', { takeProfit: five, trailing: { enabled: false } }, spec);
    expect(p.targets.map((t) => [t.levelId, t.ordinal, t.plannedContracts])).toEqual([
      ['l1', 1, '20'],
      ['l2', 2, '20'],
      ['l3', 3, '20'],
      ['l4', 4, '20'],
      ['l5', 5, '23']
    ]);
  });
});
