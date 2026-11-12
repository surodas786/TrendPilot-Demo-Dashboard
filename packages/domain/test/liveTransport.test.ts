// AT-11, OPS-02: the live order transport is off by default and can only be enabled in a production process.
import { describe, expect, it } from 'vitest';
import { ALLOWED_MODES, assertLiveTransportAllowed, assertLiveTransportDisabled, LiveTransportError } from '../src';

describe('live transport guard', () => {
  it('defaults to disabled', () => {
    expect(assertLiveTransportAllowed({})).toBe('disabled');
    expect(assertLiveTransportAllowed({ LIVE_ORDER_TRANSPORT: 'disabled' })).toBe('disabled');
    expect(() => assertLiveTransportDisabled({})).not.toThrow();
  });

  it.each(['true', '1', 'DISABLED', 'live', ''])('refuses the unknown value %j', (value) => {
    expect(() => assertLiveTransportAllowed({ LIVE_ORDER_TRANSPORT: value })).toThrow(LiveTransportError);
  });

  it.each([
    ['development', { NODE_ENV: 'development' }],
    ['unset NODE_ENV', {}],
    ['test', { NODE_ENV: 'test' }],
    ['vitest', { NODE_ENV: 'production', VITEST: 'true' }],
    ['CI', { NODE_ENV: 'production', CI: 'true' }],
    ['replay clock', { NODE_ENV: 'production', SIGNAL_TEST_CLOCK: '2026-11-08T09:30:03Z' }],
    ['replay clock allowed', { NODE_ENV: 'production', ALLOW_SIGNAL_TEST_CLOCK: '1' }]
  ])('refuses "enabled" in %s', (_n, env) => {
    expect(() => assertLiveTransportAllowed({ LIVE_ORDER_TRANSPORT: 'enabled', ...env })).toThrow(LiveTransportError);
  });

  it('allows "enabled" only in a production process', () => {
    expect(assertLiveTransportAllowed({ LIVE_ORDER_TRANSPORT: 'enabled', NODE_ENV: 'production' })).toBe('enabled');
  });

  it('PAPER and LIVE are configurable modes', () => {
    expect([...ALLOWED_MODES]).toEqual(['PAPER', 'LIVE']);
  });
});
