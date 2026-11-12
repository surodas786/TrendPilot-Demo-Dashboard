import { formatInTimeZone } from 'date-fns-tz';
import { z } from 'zod';
import { localWeekday, WEEKDAYS, type Weekday } from './weekdays';

/**
 * CFG-04 optional daily trading window for new exposure (entries, adds, the opening leg of a
 * reversal). Times are 24-hour HH:mm in the block's timezone (the same one as Trading days).
 * Start is inclusive, End exclusive. A window whose End is earlier than its Start crosses
 * midnight and belongs to the weekday on which it started: Monday 22:00–02:00 runs until
 * Tuesday 02:00 and is governed by Monday's selection. null = All day.
 */
export interface TradingWindow {
  start: string;
  end: string;
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

export const isHhMm = (v: string) => HHMM.test(v);

export const TRADING_WINDOW_HELP =
  'Optional. New entries, adds and the opening leg of a reversal are submitted only inside this window. Start is included, End is not. A window that ends earlier than it starts runs past midnight and counts for the day it started (Mon 22:00–02:00 runs until Tue 02:00).';

export const OUTSIDE_WINDOW_TEXT = 'Outside trading window';

const hhmm = z
  .string({ error: 'Enter a time as HH:mm.' })
  .trim()
  .refine(isHhMm, 'Enter a 24-hour time as HH:mm, from 00:00 to 23:59.');

export const tradingWindowSchema = z
  .object({ start: hhmm, end: hhmm })
  .strict()
  .refine((w) => !isHhMm(w.start) || !isHhMm(w.end) || w.start !== w.end, { message: 'Start and End must differ. Choose All day to trade around the clock.', path: ['end'] });

const minutesOf = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

export const crossesMidnight = (w: TradingWindow) => minutesOf(w.end) < minutesOf(w.start);

const previousDay = (d: Weekday): Weekday => WEEKDAYS[(WEEKDAYS.indexOf(d) + 6) % 7]!;

export type EntryGate = { ok: true; sessionDay: Weekday } | { ok: false; reason: 'DAY_DISABLED' | 'OUTSIDE_TRADING_WINDOW'; sessionDay: Weekday | null };

/**
 * CFG-04: may new exposure be submitted at `at`? Checks the window (if any) and the weekday the
 * current window session started on. Exits are never gated by this check.
 */
export function entryGate(days: readonly Weekday[], window: TradingWindow | null | undefined, at: Date, timeZone: string): EntryGate {
  const today = localWeekday(at, timeZone);
  if (!window) return days.includes(today) ? { ok: true, sessionDay: today } : { ok: false, reason: 'DAY_DISABLED', sessionDay: today };
  const now = minutesOf(formatInTimeZone(at, timeZone, 'HH:mm'));
  const start = minutesOf(window.start);
  const end = minutesOf(window.end);
  let sessionDay: Weekday | null = null;
  if (start < end) {
    if (now >= start && now < end) sessionDay = today;
  } else if (now >= start) {
    sessionDay = today; // evening part: the session starts today
  } else if (now < end) {
    sessionDay = previousDay(today); // after midnight: the session started yesterday
  }
  if (sessionDay === null) return { ok: false, reason: 'OUTSIDE_TRADING_WINDOW', sessionDay: null };
  return days.includes(sessionDay) ? { ok: true, sessionDay } : { ok: false, reason: 'DAY_DISABLED', sessionDay };
}

/** Compact label, e.g. "All day" or "22:00–02:00 (next day)". */
export function tradingWindowSummary(w: TradingWindow | null | undefined): string {
  if (!w) return 'All day';
  return `${w.start}–${w.end}${crossesMidnight(w) ? ' (next day)' : ''}`;
}

/** Local HH:mm of an instant, for messages. */
export const localTime = (at: Date, timeZone: string) => formatInTimeZone(at, timeZone, 'EEE HH:mm');
