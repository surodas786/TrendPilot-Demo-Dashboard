import { formatInTimeZone } from 'date-fns-tz';

/** CFG-03: weekday codes, always shown and stored in this order. */
export const WEEKDAYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'] as const;
export type Weekday = (typeof WEEKDAYS)[number];

export const WEEKDAY_LABELS: Record<Weekday, string> = {
  SUN: 'Sunday',
  MON: 'Monday',
  TUE: 'Tuesday',
  WED: 'Wednesday',
  THU: 'Thursday',
  FRI: 'Friday',
  SAT: 'Saturday'
};

export const WEEKDAY_SHORT: Record<Weekday, string> = {
  SUN: 'Sun',
  MON: 'Mon',
  TUE: 'Tue',
  WED: 'Wed',
  THU: 'Thu',
  FRI: 'Fri',
  SAT: 'Sat'
};

/** SRS §13: Asia/Dhaka initially. Fixed in this build (decision D2). */
export const DEFAULT_TIMEZONE = 'Asia/Dhaka';

/** CFG-04: all days are selected for a new order block. */
export const ALL_WEEKDAYS: readonly Weekday[] = WEEKDAYS;

export const TRADING_DAYS_HELP =
  'New trades can open only on the days you select, using the local weekday when the order is submitted. Exits and protection continue on every day.';

export const NO_DAYS_WARNING = 'No days selected — this block will not open new trades.';

export function isWeekday(value: unknown): value is Weekday {
  return typeof value === 'string' && (WEEKDAYS as readonly string[]).includes(value);
}

/**
 * Deduplicates and orders weekday codes SUN…SAT. Throws on an unknown code;
 * request validation rejects unknown codes before this is reached.
 */
export function canonicalWeekdays(days: readonly string[]): Weekday[] {
  for (const d of days) {
    if (!isWeekday(d)) throw new RangeError(`Unknown weekday code: ${String(d)}`);
  }
  return WEEKDAYS.filter((w) => days.includes(w));
}

/** Local weekday of an instant in an IANA timezone. */
export function localWeekday(at: Date, timeZone: string): Weekday {
  // ISO day of week: 1 = Monday … 7 = Sunday.
  const iso = Number(formatInTimeZone(at, timeZone, 'i'));
  return WEEKDAYS[iso % 7] as Weekday;
}

/**
 * CFG-04: whether new exposure may be submitted at `at`. An empty set blocks entries.
 * Exits are never gated by this check.
 */
export function isEntryDay(days: readonly Weekday[], at: Date, timeZone: string): boolean {
  return days.includes(localWeekday(at, timeZone));
}

/** Compact label for an order block row. */
export function weekdaysSummary(days: readonly Weekday[]): string {
  const d = canonicalWeekdays(days);
  if (d.length === 0) return 'No days — entries blocked';
  if (d.length === 7) return 'Every day';
  const key = d.join(',');
  if (key === 'MON,TUE,WED,THU,FRI') return 'Mon–Fri';
  if (key === 'SUN,SAT') return 'Sat–Sun';
  return d.map((x) => WEEKDAY_SHORT[x]).join(', ');
}
