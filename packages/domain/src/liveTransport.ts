/**
 * SRS §1.3 / OPS-02 / AT-11: the private live-order transport.
 *
 * `LIVE_ORDER_TRANSPORT` is the deployment-level switch for real MEXC orders:
 *  - `disabled` (the default and the shipped value): no order-changing request can be built.
 *  - `enabled`: allowed ONLY in a production process (NODE_ENV=production) that has no replay
 *    clock and is not a test or CI run. Development, demo, CI, test and replay environments refuse
 *    to start with it.
 *
 * Enabling the transport alone places no order. A Live order also needs, at the moment it is sent:
 * the platform Live switch (admin, audited, default Off), the investor's verified and approved
 * exchange connection, the investor's own activation (default Off), the contract on the Live
 * allowlist, and the configured order-size, leverage and exposure limits (see `live.ts`).
 */
export const LIVE_TRANSPORT_ENV = 'LIVE_ORDER_TRANSPORT';

export class LiveTransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LiveTransportError';
  }
}

export type LiveTransportState = 'disabled' | 'enabled';

/** Why `enabled` is refused in this environment, or null when it is allowed. */
export function liveTransportRefusal(env: Record<string, string | undefined> = process.env): string | null {
  if (env.SIGNAL_TEST_CLOCK || env.ALLOW_SIGNAL_TEST_CLOCK) return 'a replay clock is configured';
  if (env.CI || env.VITEST || env.NODE_ENV === 'test') return 'test or CI environment';
  if (env.NODE_ENV !== 'production') return `NODE_ENV is "${env.NODE_ENV ?? 'unset'}", not production`;
  return null;
}

/**
 * Validates the setting at process start (web, worker) and returns it. Throws for an unknown
 * value, or for `enabled` anywhere but a production process.
 */
export function assertLiveTransportAllowed(env: Record<string, string | undefined> = process.env): LiveTransportState {
  const value = env[LIVE_TRANSPORT_ENV] ?? 'disabled';
  if (value === 'disabled') return 'disabled';
  if (value !== 'enabled') throw new LiveTransportError(`${LIVE_TRANSPORT_ENV}=${value} is not allowed. Use "disabled" (default) or "enabled".`);
  const refusal = liveTransportRefusal(env);
  if (refusal) throw new LiveTransportError(`${LIVE_TRANSPORT_ENV}=enabled is not allowed here: ${refusal}. Set it to "disabled".`);
  return 'enabled';
}

/** Processes that never send orders (the public market feed) require `disabled`. */
export function assertLiveTransportDisabled(env: Record<string, string | undefined> = process.env): void {
  const value = env[LIVE_TRANSPORT_ENV] ?? 'disabled';
  if (value === 'disabled') return;
  if (value === 'enabled') {
    assertLiveTransportAllowed(env); // still refuses `enabled` outside production
    return;
  }
  throw new LiveTransportError(`${LIVE_TRANSPORT_ENV}=${value} is not allowed. Use "disabled" (default) or "enabled".`);
}

/** Modes an investor may configure. LIVE orders still pass every gate in `live.ts`. */
export const ALLOWED_MODES = ['PAPER', 'LIVE'] as const;
export type TradingMode = (typeof ALLOWED_MODES)[number];
