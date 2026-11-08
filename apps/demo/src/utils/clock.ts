import { DEMO_NOW_ISO, REPORTING_TIMEZONE } from '../data/mockData';

const demoStart = new Date(DEMO_NOW_ISO).getTime();
const loadedAt = Date.now();

/** Simulated clock: starts at the demo "now" and advances in real time. */
export function simNow(): number {
  return demoStart + (Date.now() - loadedAt);
}

export function demoStartTime(): number {
  return demoStart;
}

const clockFormat = new Intl.DateTimeFormat('en-GB', {
  timeZone: REPORTING_TIMEZONE,
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false
});

const shortClockFormat = new Intl.DateTimeFormat('en-GB', {
  timeZone: REPORTING_TIMEZONE,
  hour: '2-digit',
  minute: '2-digit',
  hour12: false
});

const dayFormat = new Intl.DateTimeFormat('en-US', {
  timeZone: REPORTING_TIMEZONE,
  month: 'short',
  day: 'numeric'
});

export function formatClock(timestamp: number): string {
  return clockFormat.format(new Date(timestamp));
}

export function formatClockShort(timestamp: number): string {
  return shortClockFormat.format(new Date(timestamp));
}

/** "Nov 4 · 14:32:10" in the reporting timezone. */
export function formatDateTime(timestamp: number): string {
  return `${dayFormat.format(new Date(timestamp))} · ${formatClock(timestamp)}`;
}

export function formatSyncTime(timestamp: number | null): string {
  return timestamp === null ? 'Never' : formatDateTime(timestamp);
}

const dateKeyFormat = new Intl.DateTimeFormat('en-CA', { timeZone: REPORTING_TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' });

/** YYYY-MM-DD for a timestamp, using Asia/Dhaka day boundaries. */
export function dhakaDate(timestamp: number): string {
  return dateKeyFormat.format(new Date(timestamp));
}

/** Timestamp for an "HH:MM:SS" clock time on the demo reporting day (Asia/Dhaka). */
export function dayTimeToMs(time: string): number {
  return demoStart - (timeToSeconds(formatClock(demoStart)) - timeToSeconds(time)) * 1000;
}

export function timeToSeconds(time: string): number {
  const [h, m, s] = time.split(':').map(Number);
  return h * 3600 + m * 60 + (s || 0);
}