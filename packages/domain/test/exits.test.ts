import { describe, expect, it } from 'vitest';
import { advanceTrailing, basisPrice, decideSignalExit, marginRelease, planTargets, realizedPnl, stopReached, takeProfitPrice, takeProfitReached, targetStatusAfter, trailingActivationPrice, trailingLevelFrom, type TrailingState } from '../src';

describe('fixed take profit', () => {
  it('targets the configured move from the confirmed entry, rounded toward entry', () => {
    expect(takeProfitPrice('LONG', '65000.5', '3', '0.1')).toBe('66950.5');
    expect(takeProfitPrice('SHORT', '64999.5', '3', '0.1')).toBe('63049.6');
    expect(takeProfitPrice('LONG', '100', '1.234', '0.01')).toBe('101.23');
    expect(takeProfitPrice('SHORT', '100', '1.234', '0.01')).toBe('98.77');
  });
  it('is reached at or beyond the target only on the right side', () => {
    expect(takeProfitReached('LONG', '66950.5', '66950.5')).toBe(true);
    expect(takeProfitReached('LONG', '66950.4', '66950.5')).toBe(false);
    expect(takeProfitReached('SHORT', '63049.6', '63049.6')).toBe(true);
    expect(takeProfitReached('SHORT', '63049.7', '63049.6')).toBe(false);
  });
});

describe('stop trigger on the saved basis', () => {
  it('Long stops on a fall, Short stops on a rise', () => {
    expect(stopReached('LONG', '64025.5', '64025.5')).toBe(true);
    expect(stopReached('LONG', '64025.6', '64025.5')).toBe(false);
    expect(stopReached('SHORT', '66000', '66000')).toBe(true);
    expect(stopReached('SHORT', '65999.9', '66000')).toBe(false);
  });
  it('reads mark or last as saved', () => {
    const q = { mark: '63000', last: '64000' };
    expect(basisPrice(q, 'MARK')).toBe('63000');
    expect(basisPrice(q, 'LAST')).toBe('64000');
  });
});

describe('realized P&L and margin release', () => {
  it('gross P&L uses contract size and side', () => {
    expect(realizedPnl('LONG', '65000.5', '66999.5', '153', '0.0001')).toBe('30.5847');
    expect(realizedPnl('SHORT', '64999.5', '63000.5', '153', '0.0001')).toBe('30.5847');
    expect(realizedPnl('LONG', '65000.5', '63999.5', '153', '0.0001')).toBe('-15.3153');
  });
  it('partial closes release a proportional share; the final close releases the exact remainder', () => {
    const first = marginRelease('99.45076501', '153', '100');
    expect(first).toBe('65.0005');
    const left = (99.45076501 - Number(first)).toFixed(8);
    expect(marginRelease(left, '53', '53')).toBe(left);
    expect(marginRelease('10', '3', '1')).toBe('3.33333333'); // rounds down, never over-releases
  });
});

describe('close on signal uses the policy saved with the position', () => {
  it('explicit close signals close only the matching side', () => {
    expect(decideSignalExit('CLOSE_LONG', 'LONG', 'KEEP_OPEN')).toEqual({ kind: 'CLOSE', reason: 'SIGNAL_CLOSE' });
    expect(decideSignalExit('CLOSE_SHORT', 'SHORT', 'KEEP_OPEN')).toEqual({ kind: 'CLOSE', reason: 'SIGNAL_CLOSE' });
    expect(decideSignalExit('CLOSE_SHORT', 'LONG', 'CLOSE_ONLY')).toEqual({ kind: 'NONE', reason: 'CLOSE_SIDE_MISMATCH' });
  });
  it('opposite flips follow KEEP_OPEN / CLOSE_ONLY / CLOSE_AND_REVERSE', () => {
    expect(decideSignalExit('BEARISH_FLIP', 'LONG', 'KEEP_OPEN')).toEqual({ kind: 'HOLD', reason: 'KEEP_OPEN' });
    expect(decideSignalExit('BEARISH_FLIP', 'LONG', 'CLOSE_ONLY')).toEqual({ kind: 'CLOSE', reason: 'OPPOSITE_SIGNAL_CLOSE' });
    expect(decideSignalExit('BULLISH_FLIP', 'SHORT', 'CLOSE_AND_REVERSE')).toEqual({ kind: 'CLOSE', reason: 'REVERSAL_CLOSE' });
    expect(decideSignalExit('BULLISH_FLIP', 'LONG', 'CLOSE_ONLY')).toEqual({ kind: 'HOLD', reason: 'SAME_DIRECTION' });
  });
});

describe('split take profit plan (EXT-03)', () => {
  const spec = { priceTick: '0.1', qtyStep: '1' };
  it('a full split gives the last target the exact remainder', () => {
    const t = planTargets('LONG', '65000.5', '153', { mode: 'SPLIT', levels: [{ id: 'a', movePct: '2', closePct: '50' }, { id: 'b', movePct: '4', closePct: '50' }] }, spec);
    expect(t.map((x) => [x.levelId, x.triggerPrice, x.plannedContracts])).toEqual([
      ['a', '66300.5', '76'],
      ['b', '67600.5', '77']
    ]);
  });
  it('a partial allocation rounds each target down and leaves the rest to trailing', () => {
    const t = planTargets('SHORT', '64999.5', '153', { mode: 'SPLIT', levels: [{ id: 'a', movePct: '2', closePct: '50' }, { id: 'b', movePct: '4', closePct: '30' }] }, spec);
    expect(t.map((x) => [x.triggerPrice, x.plannedContracts])).toEqual([
      ['63699.6', '76'],
      ['62399.6', '45']
    ]);
  });
  it('fixed is one 100 % target; off has none', () => {
    expect(planTargets('LONG', '100', '7', { mode: 'FIXED', levels: [{ id: 'x', movePct: '3', closePct: '100' }] }, spec)[0]).toMatchObject({ plannedContracts: '7', ordinal: 1 });
    expect(planTargets('LONG', '100', '7', { mode: 'OFF', levels: [] }, spec)).toEqual([]);
  });
  it('status follows confirmed fills only', () => {
    expect(targetStatusAfter('76', '0', true)).toBe('REQUESTED');
    expect(targetStatusAfter('76', '50', false)).toBe('PARTIAL');
    expect(targetStatusAfter('76', '0', false)).toBe('PENDING');
    expect(targetStatusAfter('76', '76', true)).toBe('DONE');
  });
});

describe('trailing stop (EXT-04)', () => {
  const cfg = { distancePct: '1', tick: '0.1' };
  it('activation and level rounding never make it closer than configured', () => {
    expect(trailingActivationPrice('LONG', '65000.5', '3', '0.1')).toBe('66950.6');
    expect(trailingActivationPrice('SHORT', '64999.5', '3', '0.1')).toBe('63049.5');
    expect(trailingActivationPrice('LONG', '65000.5', null, '0.1')).toBeNull();
    expect(trailingLevelFrom('LONG', '67000.3', '1', '0.1')).toBe('66330.2');
    expect(trailingLevelFrom('SHORT', '64999.5', '1', '0.1')).toBe('65649.5');
  });
  it('Long: waits for activation, tracks the high, only tightens, triggers at the level', () => {
    let s: TrailingState = { status: 'WAITING', activationPrice: '66950.6', watermark: null, level: null };
    let r = advanceTrailing('LONG', s, '66900', cfg);
    expect(r).toMatchObject({ activated: false, triggered: false });
    expect(r.state).toBe(s);
    r = advanceTrailing('LONG', s, '67000', cfg);
    expect(r).toMatchObject({ activated: true, state: { status: 'ACTIVE', watermark: '67000', level: '66330' } });
    s = r.state;
    r = advanceTrailing('LONG', s, '67700', cfg);
    expect(r).toMatchObject({ tightened: true, state: { watermark: '67700', level: '67023' } });
    s = r.state;
    r = advanceTrailing('LONG', s, '67300', cfg);
    expect(r).toMatchObject({ tightened: false, triggered: false });
    expect(r.state.level).toBe('67023');
    expect(advanceTrailing('LONG', s, '67023', cfg).triggered).toBe(true);
  });
  it('Short: tracks the low, a bounce never loosens it, triggers on a rise to the level', () => {
    let s: TrailingState = { status: 'ACTIVE', activationPrice: null, watermark: '64999.5', level: '65649.5' };
    s = advanceTrailing('SHORT', s, '64000', cfg).state;
    expect(s).toMatchObject({ watermark: '64000', level: '64640' });
    expect(advanceTrailing('SHORT', s, '64500', cfg).state).toBe(s);
    expect(advanceTrailing('SHORT', s, '64639.9', cfg).triggered).toBe(false);
    expect(advanceTrailing('SHORT', s, '64640', cfg).triggered).toBe(true);
  });
});
