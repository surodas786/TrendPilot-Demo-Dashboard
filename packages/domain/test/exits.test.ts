import { describe, expect, it } from 'vitest';
import { advanceTrailing, basisPrice, decideSignalExit, marginRelease, planTargets, realizedPnl, stopReached, takeProfitPrice, takeProfitReached, targetStatusAfter, trailingActivationPrice, trailingLevelFrom, trailingTakeProfitContracts, type TrailingState } from '../src';

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

describe('Trailing Take Profit — BTC example (entry 74788.4, activation 0.3 %, trail 0.1 %, tick 0.1)', () => {
  const tick = '0.1';
  const cfg = { distancePct: '0.1', tick };
  const start = (side: 'LONG' | 'SHORT'): TrailingState => ({ status: 'WAITING', activationPrice: trailingActivationPrice(side, '74788.4', '0.3', tick), watermark: null, level: null });
  const walk = (side: 'LONG' | 'SHORT', prices: string[]) => {
    let s = start(side);
    return prices.map((p) => {
      const step = advanceTrailing(side, s, p, cfg);
      s = step.state;
      return { price: p, status: s.status, watermark: s.watermark, level: s.level, triggered: step.triggered };
    });
  };

  it('arms only after the activation move from the confirmed average entry, never closer than configured', () => {
    expect(trailingActivationPrice('SHORT', '74788.4', '0.3', tick)).toBe('74564'); // 74564.0348 rounded down
    expect(trailingActivationPrice('LONG', '74788.4', '0.3', tick)).toBe('75012.8'); // 75012.7652 rounded up
  });

  it('Short: a direct adverse move to 74863.2 does not trigger it (the old from-entry trailing stop would have)', () => {
    expect(walk('SHORT', ['74863.2'])).toEqual([{ price: '74863.2', status: 'WAITING', watermark: null, level: null, triggered: false }]);
    // The legacy behaviour this replaces: active from entry, level = entry + 0.1 % = 74863.2 → a losing exit.
    const legacy = advanceTrailing('SHORT', { status: 'ACTIVE', activationPrice: null, watermark: '74788.4', level: trailingLevelFrom('SHORT', '74788.4', '0.1', tick) }, '74863.2', cfg);
    expect(legacy.triggered).toBe(true);
  });

  it('Short: a favourable move short of activation, then a rebound, never arms or triggers', () => {
    const r = walk('SHORT', ['74700', '74600', '74564.1', '74700', '74800', '74863.2']);
    expect(r.every((x) => x.status === 'WAITING' && !x.triggered)).toBe(true);
  });

  it('Short: arms at the activation price, tracks the lowest price, closes on a 0.1 % pullback from it', () => {
    const r = walk('SHORT', ['74600', '74564', '74520', '74500', '74560', '74574.4', '74574.5']);
    expect(r.map((x) => [x.status, x.watermark, x.level, x.triggered])).toEqual([
      ['WAITING', null, null, false],
      ['ACTIVE', '74564', '74638.6', false], // armed: 74564 × 1.001 rounded up
      ['ACTIVE', '74520', '74594.6', false],
      ['ACTIVE', '74500', '74574.5', false],
      ['ACTIVE', '74500', '74574.5', false], // a bounce never loosens the level
      ['ACTIVE', '74500', '74574.5', false],
      ['ACTIVE', '74500', '74574.5', true] // 0.1 % above the low → market close
    ]);
  });

  it('Long (mirror): no trigger below activation or after a rebound; arms, tracks the high, closes on a 0.1 % pullback', () => {
    const r = walk('LONG', ['74713.6', '74900', '75012.7', '74800', '75012.8', '75100', '75025', '75024.8']);
    expect(r.map((x) => [x.status, x.watermark, x.level, x.triggered])).toEqual([
      ['WAITING', null, null, false], // a direct adverse move of 0.1 %
      ['WAITING', null, null, false],
      ['WAITING', null, null, false], // one tick short of activation
      ['WAITING', null, null, false], // rebound
      ['ACTIVE', '75012.8', '74937.7', false], // 75012.8 × 0.999 rounded down
      ['ACTIVE', '75100', '75024.9', false],
      ['ACTIVE', '75100', '75024.9', false],
      ['ACTIVE', '75100', '75024.9', true]
    ]);
  });
});

describe('Trailing Take Profit quantity', () => {
  const t = (status: string, planned: string, filled: string) => ({ status, plannedContracts: planned, filledContracts: filled });

  it('manages only what no unfinished target reserves', () => {
    // 153 contracts, targets 76 + 45 planned: Trailing Take Profit manages 32.
    expect(trailingTakeProfitContracts('153', [t('PENDING', '76', '0'), t('PENDING', '45', '0')])).toBe('32');
    // Target 1 partly filled (50 of 76): 103 open, 26 + 45 still reserved → still 32.
    expect(trailingTakeProfitContracts('103', [t('PARTIAL', '76', '50'), t('PENDING', '45', '0')])).toBe('32');
    // Both targets done: whatever is open is its own.
    expect(trailingTakeProfitContracts('32', [t('DONE', '76', '76'), t('DONE', '45', '45')])).toBe('32');
    // No targets (take profit off): the whole position.
    expect(trailingTakeProfitContracts('153', [])).toBe('153');
    // After it closed its own share, only target quantity remains: nothing left for it.
    expect(trailingTakeProfitContracts('121', [t('PENDING', '76', '0'), t('PENDING', '45', '0')])).toBe('0');
    // A cancelled target reserves nothing.
    expect(trailingTakeProfitContracts('77', [t('DONE', '76', '76'), t('CANCELLED', '77', '0')])).toBe('77');
  });

  it('a fixed target closes its saved share when Trailing Take Profit manages the rest', () => {
    const [x] = planTargets('LONG', '74788.4', '133', { mode: 'FIXED', levels: [{ id: 'tp1', movePct: '1', closePct: '60' }] }, { priceTick: '0.1', qtyStep: '1' });
    expect(x).toMatchObject({ closePct: '60', plannedContracts: '79' }); // 79.8 → 79; Trailing Take Profit manages 54
    const [all] = planTargets('LONG', '74788.4', '133', { mode: 'FIXED', levels: [{ id: 'tp1', movePct: '1', closePct: '100' }] }, { priceTick: '0.1', qtyStep: '1' });
    expect(all!.plannedContracts).toBe('133');
  });
});
