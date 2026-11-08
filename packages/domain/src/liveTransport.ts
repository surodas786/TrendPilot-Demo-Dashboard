/**
 * SRS §1.3 / OPS-02 / AT-11: the private live-order transport is disabled in every
 * development, demo, CI, test and replay environment. This build contains no live
 * adapter at all, so the only accepted setting is "disabled". Enabling live trading
 * later needs a release gate plus investor opt-in (M4), not just this variable.
 */
export const LIVE_TRANSPORT_ENV = 'LIVE_ORDER_TRANSPORT';

export class LiveTransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LiveTransportError';
  }
}

export function assertLiveTransportDisabled(env: Record<string, string | undefined> = process.env): void {
  const value = env[LIVE_TRANSPORT_ENV] ?? 'disabled';
  if (value !== 'disabled') {
    throw new LiveTransportError(
      `${LIVE_TRANSPORT_ENV}=${value} is not allowed: live order transport is unavailable in this build. Set it to "disabled".`
    );
  }
}

/** Modes an investor may configure in this build (decision D1). */
export const ALLOWED_MODES = ['PAPER'] as const;
