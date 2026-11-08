import { signalClockFromEnv } from '@trendpilot/db';

/**
 * Signal clock for webhook intake. Precedence: a test override set in-process (vitest),
 * then SIGNAL_TEST_CLOCK (local replay / e2e), then real time.
 */
let override: (() => Date) | null = null;
let fromEnv: (() => Date) | null = null;

export const now = (): Date => {
  if (override) return override();
  fromEnv ??= signalClockFromEnv();
  return fromEnv();
};

/** Test-only. Refuses to run in production. */
export function setTestClock(fn: (() => Date) | null): void {
  if (process.env.NODE_ENV === 'production') throw new Error('The test clock cannot be used in production.');
  override = fn;
}
