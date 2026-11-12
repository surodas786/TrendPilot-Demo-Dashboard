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

describe('planExits: allocation from the confirmed opening quantity', () => {
  const spec = { priceTick: '0.1', qtyStep: '1' };
  const FIXED = { mode: 'FIXED' as const, levels: [{ id: 'tp', movePct: '1', closePct: '100' }] };
  const SPLIT = { mode: 'SPLIT' as const, levels: [{ id: 'a', movePct: '1', closePct: '50' }, { id: 'b', movePct: '2', closePct: '50' }] };
  const on = (closePct: string) => ({ enabled: true, closePct });

  it('0 %: Take Profit gets everything; 40 %: 40 / 60; 100 %: Trailing gets everything (no target rows)', () => {
    expect(planExits('LONG', '100', '100', { takeProfit: FIXED, trailing: on('0') }, spec)).toMatchObject({ trailingContracts: '0', takeProfitContracts: '100', targets: [{ levelId: 'tp', plannedContracts: '100' }] });
    expect(planExits('LONG', '100', '100', { takeProfit: FIXED, trailing: on('40') }, spec)).toMatchObject({ trailingContracts: '40', takeProfitContracts: '60', targets: [{ plannedContracts: '60', triggerPrice: '101' }] });
    expect(planExits('LONG', '100', '100', { takeProfit: FIXED, trailing: on('100') }, spec)).toMatchObject({ trailingContracts: '100', takeProfitContracts: '0', targets: [] });
  });

  it('Split divides the Take Profit allocation between targets; the last gets the exact rest', () => {
    const p = planExits('SHORT', '100', '153', { takeProfit: SPLIT, trailing: on('40') }, spec);
    expect(p.trailingContracts).toBe('61');
    expect(p.targets.map((t) => [t.levelId, t.plannedContracts, t.triggerPrice])).toEqual([
      ['a', '46', '99'],
      ['b', '46', '98']
    ]);
  });

  it('trailing off: Take Profit manages all; Take Profit off: unallocated quantity stays with the other exits', () => {
    expect(planExits('LONG', '100', '7', { takeProfit: FIXED, trailing: { enabled: false } }, spec)).toMatchObject({ trailingContracts: '0', targets: [{ plannedContracts: '7' }] });
    expect(planExits('LONG', '100', '7', { takeProfit: { mode: 'OFF', levels: [] }, trailing: on('40') }, spec)).toEqual({ trailingContracts: '2', takeProfitContracts: '0', targets: [] });
  });
});
