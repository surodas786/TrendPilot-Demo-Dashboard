/** Runs once when the Next.js server starts. */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const { loadRootEnv } = await import('@trendpilot/db');
  const { assertLiveTransportAllowed } = await import('@trendpilot/domain');
  // One .env at the repository root serves every workspace; explicit env vars win.
  loadRootEnv();
  // OPS-02 / AT-11: refuse to serve with an invalid LIVE_ORDER_TRANSPORT, or "enabled" outside production.
  assertLiveTransportAllowed();
}
