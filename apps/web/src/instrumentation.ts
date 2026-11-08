/** Runs once when the Next.js server starts. */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const { loadRootEnv } = await import('@trendpilot/db');
  const { assertLiveTransportDisabled } = await import('@trendpilot/domain');
  // One .env at the repository root serves every workspace; explicit env vars win.
  loadRootEnv();
  // OPS-02 / AT-11: refuse to serve if anyone tries to enable live order transport.
  assertLiveTransportDisabled();
}
