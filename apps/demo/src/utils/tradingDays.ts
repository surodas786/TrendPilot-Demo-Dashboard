/** Day-of-week schedule for new entries. 0 = Sunday … 6 = Saturday (JavaScript order). */
export const DAY_LABELS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;
export const DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
export const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];
export const DEFAULT_TIMEZONE = 'Asia/Dhaka';
export const TRADING_DAYS_HELP = 'New trades can open only on the days you select. Existing positions can still close on any day.';

/** The investor's configured timezone, defaulting to Asia/Dhaka. */
export function userTimezone(user: {timezone?: string;} | undefined): string {
  return user?.timezone || DEFAULT_TIMEZONE;
}

/** Saved schedule, or all seven days when none has been saved yet. */
export function effectiveDays(days: number[] | undefined): number[] {
  return days && days.length > 0 ? days : ALL_DAYS;
}

const fmtCache: Record<string, Intl.DateTimeFormat> = {};

/** Local day of week (0–6) for a UTC timestamp in the given timezone. */
export function localDay(at: number, tz: string): number {
  fmtCache[tz] ??= new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' });
  const name = fmtCache[tz].format(new Date(at));
  const idx = DAY_SHORT.indexOf(name as (typeof DAY_SHORT)[number]);
  return idx >= 0 ? idx : new Date(at).getUTCDay();
}

/** Compact label for the token card, e.g. "Every day", "Weekdays", "Mon, Wed, Fri". */
export function daysSummary(days: number[] | undefined): string {
  const d = [...effectiveDays(days)].sort((a, b) => a - b);
  if (d.length === 7) return 'Every day';
  if (d.join() === '1,2,3,4,5') return 'Mon–Fri';
  if (d.join() === '0,6') return 'Sat–Sun';
  return d.map((i) => DAY_SHORT[i]).join(', ');
}