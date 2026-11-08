// AT-11, OPS-02: live order transport cannot be enabled in this build.
import { describe, expect, it } from 'vitest';
import { assertLiveTransportDisabled, LiveTransportError } from '../src';

describe('live transport guard', () => {
  it('passes when disabled or unset', () => {
    expect(() => assertLiveTransportDisabled({ LIVE_ORDER_TRANSPORT: 'disabled' })).not.toThrow();
    expect(() => assertLiveTransportDisabled({})).not.toThrow();
  });

  it.each(['enabled', 'true', '1', 'DISABLED', ''])('refuses %j', (value) => {
    expect(() => assertLiveTransportDisabled({ LIVE_ORDER_TRANSPORT: value })).toThrow(LiveTransportError);
  });

  it('refuses even with NODE_ENV=production (no release gate exists yet)', () => {
    expect(() => assertLiveTransportDisabled({ LIVE_ORDER_TRANSPORT: 'enabled', NODE_ENV: 'production' })).toThrow(LiveTransportError);
  });
});
