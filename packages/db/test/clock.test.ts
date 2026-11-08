// Controlled signal clock: repeatable locally, refused in production.
import { describe, expect, it, vi } from 'vitest';
import { signalClockFromEnv } from '../src/clock';

describe('signal clock', () => {
  it('uses real time when unset', () => {
    const before = Date.now();
    const t = signalClockFromEnv({}).call(null).getTime();
    expect(t).toBeGreaterThanOrEqual(before);
  });

  it('pins time to SIGNAL_TEST_CLOCK outside production', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const clock = signalClockFromEnv({ SIGNAL_TEST_CLOCK: '2026-11-08T09:30:03Z', NODE_ENV: 'development' });
    expect(clock().toISOString()).toBe('2026-11-08T09:30:03.000Z');
    expect(clock().toISOString()).toBe('2026-11-08T09:30:03.000Z');
  });

  it('refuses a fixed clock in production unless explicitly allowed (e2e only)', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(() => signalClockFromEnv({ SIGNAL_TEST_CLOCK: '2026-11-08T09:30:03Z', NODE_ENV: 'production' })).toThrow(/not allowed in production/);
    expect(signalClockFromEnv({ SIGNAL_TEST_CLOCK: '2026-11-08T09:30:03Z', NODE_ENV: 'production', ALLOW_SIGNAL_TEST_CLOCK: 'true' })().toISOString()).toBe('2026-11-08T09:30:03.000Z');
  });

  it('rejects non-UTC values', () => {
    expect(() => signalClockFromEnv({ SIGNAL_TEST_CLOCK: '2026-11-08T15:30:03+06:00' })).toThrow(/UTC/);
  });
});
