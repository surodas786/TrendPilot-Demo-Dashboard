import { describe, expect, it } from 'vitest';
import { ALL_WEEKDAYS, crossesMidnight, entryGate, evaluateBlockForSignal, tradingWindowSummary, type Weekday } from '../src';

const DHAKA = 'Asia/Dhaka'; // UTC+6, no DST
/** Local Dhaka wall-clock time → instant. 2026-11-09 is a Monday. */
const dhaka = (date: string, hhmm: string) => new Date(`${date}T${hhmm}:00+06:00`);
const MON = '2026-11-09';
const TUE = '2026-11-10';
const SUN = '2026-11-08';

describe('trading window (CFG-04)', () => {
  it('All day (null) only checks the local weekday', () => {
    expect(entryGate(['MON'], null, dhaka(MON, '00:00'), DHAKA)).toMatchObject({ ok: true, sessionDay: 'MON' });
    expect(entryGate(['MON'], null, dhaka(TUE, '00:00'), DHAKA)).toMatchObject({ ok: false, reason: 'DAY_DISABLED' });
  });

  it('a same-day window: Start inclusive, End exclusive', () => {
    const w = { start: '09:00', end: '17:30' };
    const at = (t: string) => entryGate(ALL_WEEKDAYS, w, dhaka(MON, t), DHAKA);
    expect(at('08:59')).toMatchObject({ ok: false, reason: 'OUTSIDE_TRADING_WINDOW' });
    expect(at('09:00')).toMatchObject({ ok: true, sessionDay: 'MON' });
    expect(at('17:29')).toMatchObject({ ok: true });
    expect(at('17:30')).toMatchObject({ ok: false, reason: 'OUTSIDE_TRADING_WINDOW' });
    // Seconds count: 17:29:59 is inside, 08:59:59 is outside.
    expect(entryGate(ALL_WEEKDAYS, w, new Date('2026-11-09T17:29:59+06:00'), DHAKA).ok).toBe(true);
    expect(entryGate(ALL_WEEKDAYS, w, new Date('2026-11-09T08:59:59+06:00'), DHAKA).ok).toBe(false);
  });

  it('an overnight window belongs to the weekday it started: Monday 22:00–02:00 runs until Tuesday 02:00', () => {
    const w = { start: '22:00', end: '02:00' };
    expect(crossesMidnight(w)).toBe(true);
    const mondayOnly: Weekday[] = ['MON'];
    const at = (d: string, t: string) => entryGate(mondayOnly, w, dhaka(d, t), DHAKA);
    expect(at(MON, '21:59')).toMatchObject({ ok: false, reason: 'OUTSIDE_TRADING_WINDOW' });
    expect(at(MON, '22:00')).toMatchObject({ ok: true, sessionDay: 'MON' }); // start inclusive
    expect(at(MON, '23:59')).toMatchObject({ ok: true, sessionDay: 'MON' });
    expect(at(TUE, '00:00')).toMatchObject({ ok: true, sessionDay: 'MON' }); // Tuesday morning still Monday's session
    expect(at(TUE, '01:59')).toMatchObject({ ok: true, sessionDay: 'MON' });
    expect(at(TUE, '02:00')).toMatchObject({ ok: false, reason: 'OUTSIDE_TRADING_WINDOW' }); // end exclusive
    expect(at(TUE, '22:00')).toMatchObject({ ok: false, reason: 'DAY_DISABLED', sessionDay: 'TUE' }); // Tuesday's own session is not selected
    // Monday 00:30 belongs to Sunday's session, which is not selected.
    expect(at(MON, '00:30')).toMatchObject({ ok: false, reason: 'DAY_DISABLED', sessionDay: 'SUN' });
    expect(entryGate(['SUN'], w, dhaka(MON, '00:30'), DHAKA)).toMatchObject({ ok: true, sessionDay: 'SUN' });
    expect(entryGate(['SAT'], w, dhaka(SUN, '01:00'), DHAKA)).toMatchObject({ ok: true, sessionDay: 'SAT' }); // week wraps SUN → SAT
  });

  it('uses the block timezone, not UTC', () => {
    const w = { start: '09:00', end: '10:00' };
    // 03:30 UTC = 09:30 in Dhaka (inside); 09:30 UTC = 15:30 in Dhaka (outside).
    expect(entryGate(ALL_WEEKDAYS, w, new Date('2026-11-09T03:30:00Z'), DHAKA).ok).toBe(true);
    expect(entryGate(ALL_WEEKDAYS, w, new Date('2026-11-09T09:30:00Z'), DHAKA).ok).toBe(false);
  });

  it('the signal screen skips entries outside the window with OUTSIDE_TRADING_WINDOW; close signals are never gated', () => {
    const base = {
      interval: '15' as const,
      user: { status: 'ACTIVE' as const },
      version: { timeframe: '15m' as const, permittedDirections: 'BOTH' as const, signalMaxAgeSeconds: 600 }
    };
    const block = { status: 'ACTIVE' as const, mode: 'PAPER' as const, direction: 'BOTH' as const, weekdays: [...ALL_WEEKDAYS], timezone: DHAKA, tradingWindow: { start: '22:00', end: '02:00' } };
    const now = dhaka(MON, '12:00');
    const flip = evaluateBlockForSignal({ ...base, action: 'BULLISH_FLIP', barCloseAt: now, evaluatedAt: now, block });
    expect(flip).toMatchObject({ status: 'SKIPPED', reason: 'OUTSIDE_TRADING_WINDOW' });
    const inside = dhaka(TUE, '01:00');
    expect(evaluateBlockForSignal({ ...base, action: 'BEARISH_FLIP', barCloseAt: inside, evaluatedAt: inside, block })).toMatchObject({ status: 'READY_FOR_EVALUATION' });
    const close = evaluateBlockForSignal({ ...base, action: 'CLOSE_LONG', barCloseAt: now, evaluatedAt: now, block });
    expect(close.failed).not.toContain('OUTSIDE_TRADING_WINDOW');
  });

  it('summaries', () => {
    expect(tradingWindowSummary(null)).toBe('All day');
    expect(tradingWindowSummary({ start: '09:00', end: '17:00' })).toBe('09:00–17:00');
    expect(tradingWindowSummary({ start: '22:00', end: '02:00' })).toBe('22:00–02:00 (next day)');
  });
});
