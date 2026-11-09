// The public feed process refuses a fixed replay clock and an enabled live transport.
import { describe, expect, it } from 'vitest';
import { assertRealClock, runFeedOnce } from '../src/feed';

describe('market feed process guards', () => {
  it('refuses SIGNAL_TEST_CLOCK: public quotes are stamped in real time', () => {
    expect(() => assertRealClock({ SIGNAL_TEST_CLOCK: '2026-11-08T09:30:03Z' })).toThrow(/real time/);
    expect(() => assertRealClock({})).not.toThrow();
  });

  it('refuses to start unless live order transport is disabled', async () => {
    await expect(runFeedOnce({ env: { LIVE_ORDER_TRANSPORT: 'enabled', DATABASE_URL: 'postgres://x@localhost:1/none' } })).rejects.toThrow(/LIVE_ORDER_TRANSPORT|live/i);
  });
});
