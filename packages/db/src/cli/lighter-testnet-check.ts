/**
 * Lighter OFFICIAL TESTNET check (Lighter plan Step 4C) — isolated local test setup only.
 *
 * Saves and verifies the investor's TESTNET connection through the normal flow, then, per side,
 * places the smallest valid linked entry (market IOC + size-0 reduce-only stop) on the given
 * testnet market, records the stop's activation and size against the fill, closes reduce-only,
 * and cancels any stop left on the flat market. Prints evidence only (never keys, tokens or
 * signed payloads). Mainnet orders stay refused by their own gate.
 *
 * Required environment (set in the shell for one run; never committed):
 *   LIGHTER_TESTNET=enabled                       refused in production
 *   DATABASE_URL=…/<name>_test or …/<name>_testnet   an isolated local database (migrated, seeded)
 *   DATA_ENCRYPTION_KEY=…                         key sealing for the isolated database
 *   LIGHTER_TESTNET_ACCOUNT_INDEX, LIGHTER_TESTNET_API_KEY_INDEX, LIGHTER_TESTNET_API_PRIVATE_KEY
 *   LIGHTER_ENTRY_WORST_PRICE_PCT, LIGHTER_STOP_WORST_PRICE_PCT, LIGHTER_CLOSE_WORST_PRICE_PCT,
 *   LIGHTER_TAKER_FEE_RATE                        explicit inputs for this run
 *
 *   npm run ops:lighter-testnet-check -- --owner investor.a@trendpilot.local --symbol ETH --stop-pct 5 [--sides LONG,SHORT]
 */
import { eq } from 'drizzle-orm';
import { createDb } from '../client';
import { loadRootEnv, requireEnv } from '../env';
import { runLighterTestnetCheck } from '../live/lighterTestnetCheck';
import { users } from '../schema';

loadRootEnv();
const arg = (n: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

async function main() {
  const owner = arg('owner');
  const symbol = arg('symbol');
  const stopPct = arg('stop-pct');
  if (!owner || !symbol || !stopPct) throw new Error('Usage: --owner <investor email> --symbol <testnet perp symbol> --stop-pct <percent> [--sides LONG,SHORT]');
  const accountIndex = Number(requireEnv('LIGHTER_TESTNET_ACCOUNT_INDEX'));
  const apiKeyIndex = Number(requireEnv('LIGHTER_TESTNET_API_KEY_INDEX'));
  const apiPrivateKey = requireEnv('LIGHTER_TESTNET_API_PRIVATE_KEY');
  const h = createDb(requireEnv('DATABASE_URL'), 2);
  try {
    const [u] = await h.db.select({ id: users.id }).from(users).where(eq(users.email, owner));
    if (!u) throw new Error(`No user ${owner} in this database.`);
    const sides = (arg('sides') ?? 'LONG,SHORT').split(',').map((s) => s.trim().toUpperCase()) as ('LONG' | 'SHORT')[];
    const report = await runLighterTestnetCheck(h.db, { ownerId: u.id, accountIndex, apiKeyIndex, apiPrivateKey, symbol, stopDistancePct: stopPct, sides });
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await h.close();
  }
}

main().catch((e) => {
  console.error(`lighter testnet check: ${(e as Error).message}`);
  process.exit(1);
});
