// CFG-03, CFG-04, AT-05 (weekday rules)
import { describe, expect, it } from 'vitest';
import { ALL_WEEKDAYS, canonicalWeekdays, isEntryDay, localWeekday, WEEKDAYS, weekdaysSummary } from '../src';

const DHAKA = 'Asia/Dhaka';

describe('weekdays', () => {
  it('lists all seven days SUN…SAT', () => {
    expect(WEEKDAYS).toEqual(['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT']);
    expect(ALL_WEEKDAYS).toHaveLength(7);
  });

  it('canonicalises order and removes duplicates', () => {
    expect(canonicalWeekdays(['SAT', 'MON', 'SUN', 'MON'])).toEqual(['SUN', 'MON', 'SAT']);
  });

  it('rejects unknown codes', () => {
    expect(() => canonicalWeekdays(['MON', 'FUNDAY'])).toThrow(RangeError);
    expect(() => canonicalWeekdays(['mon'])).toThrow(RangeError);
  });

  it('resolves the local weekday in Asia/Dhaka (UTC+6) across midnight', () => {
    // Saturday 7 Nov 2026 23:59 Dhaka = 17:59 UTC; Sunday 00:30 Dhaka = 18:30 UTC.
    expect(localWeekday(new Date('2026-11-07T17:59:00Z'), DHAKA)).toBe('SAT');
    expect(localWeekday(new Date('2026-11-07T18:30:00Z'), DHAKA)).toBe('SUN');
    expect(localWeekday(new Date('2026-11-07T18:30:00Z'), 'UTC')).toBe('SAT');
  });

  it('an empty selection blocks every entry; a selected day allows it', () => {
    const sundayDhaka = new Date('2026-11-07T18:30:00Z');
    expect(isEntryDay([], sundayDhaka, DHAKA)).toBe(false);
    expect(isEntryDay(['SUN'], sundayDhaka, DHAKA)).toBe(true);
    expect(isEntryDay(['SAT'], sundayDhaka, DHAKA)).toBe(false);
    expect(isEntryDay(ALL_WEEKDAYS, sundayDhaka, DHAKA)).toBe(true);
  });

  it('every single day is independently selectable', () => {
    // 1 Nov 2026 is a Sunday; walk one week at noon Dhaka time.
    WEEKDAYS.forEach((day, i) => {
      const at = new Date(Date.UTC(2026, 10, 1 + i, 6, 0));
      expect(localWeekday(at, DHAKA)).toBe(day);
      for (const other of WEEKDAYS) expect(isEntryDay([other], at, DHAKA)).toBe(other === day);
    });
  });

  it('summarises selections', () => {
    expect(weekdaysSummary(ALL_WEEKDAYS)).toBe('Every day');
    expect(weekdaysSummary(['FRI', 'MON', 'TUE', 'WED', 'THU'])).toBe('Mon–Fri');
    expect(weekdaysSummary(['SAT', 'SUN'])).toBe('Sat–Sun');
    expect(weekdaysSummary(['MON', 'WED'])).toBe('Mon, Wed');
    expect(weekdaysSummary([])).toBe('No days — entries blocked');
  });
});
