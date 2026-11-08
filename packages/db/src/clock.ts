/**
 * Signal clock: the time the webhook stamps as "received" and the worker uses as
 * "evaluated". Real time unless SIGNAL_TEST_CLOCK=<UTC ISO> pins it for repeatable local
 * replays and end-to-end tests. Only signal intake and routing use it; sessions, tokens and
 * audit timestamps always use real time.
 *
 * Refused in production builds unless ALLOW_SIGNAL_TEST_CLOCK=true is also set (the e2e
 * server is a production build). A real deployment must never set either variable.
 */
export function signalClockFromEnv(env: Record<string, string | undefined> = process.env): () => Date {
  const fixed = env.SIGNAL_TEST_CLOCK;
  if (!fixed) return () => new Date();
  if (env.NODE_ENV === 'production' && env.ALLOW_SIGNAL_TEST_CLOCK !== 'true') {
    throw new Error('SIGNAL_TEST_CLOCK is not allowed in production.');
  }
  const t = Date.parse(fixed);
  if (!/Z$/.test(fixed) || Number.isNaN(t)) throw new Error('SIGNAL_TEST_CLOCK must be a UTC ISO timestamp ending in Z.');
  console.warn(`[clock] SIGNAL_TEST_CLOCK is set: signal intake and routing use the fixed time ${fixed}.`);
  return () => new Date(t);
}
