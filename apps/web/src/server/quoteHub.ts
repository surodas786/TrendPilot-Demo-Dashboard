import { loadRootEnv, QuoteListener, requireEnv } from '@trendpilot/db';

type G = typeof globalThis & { __trendpilotQuoteHub?: QuoteListener };

/** Process-wide live quote hub: one LISTEN connection shared by every browser session. */
export function quoteHub(): QuoteListener {
  const g = globalThis as G;
  if (!g.__trendpilotQuoteHub) {
    loadRootEnv();
    g.__trendpilotQuoteHub = new QuoteListener({ connectionString: requireEnv('DATABASE_URL'), log: (m) => console.warn(`[quotes] ${m}`) });
  }
  return g.__trendpilotQuoteHub;
}

/** Test-only: close the shared listener. */
export async function closeQuoteHub(): Promise<void> {
  const g = globalThis as G;
  const h = g.__trendpilotQuoteHub;
  g.__trendpilotQuoteHub = undefined;
  await h?.close();
}
