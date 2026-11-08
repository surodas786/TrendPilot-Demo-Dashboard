import { createDb } from '../client';
import { loadRootEnv, requireEnv } from '../env';
import { FIXTURE_USERS } from '../fixtures';
import { resetDatabase, seedFixtures } from '../seed';

loadRootEnv();
const url = process.env.SEED_DATABASE_URL ?? requireEnv('DATABASE_URL');
const h = createDb(url, 1);
try {
  if (process.argv.includes('--reset')) await resetDatabase(h.db, url);
  const { ingressToken } = await seedFixtures(h.db);
  console.log(`Seeded ${new URL(url).pathname.slice(1)}:`);
  for (const u of Object.values(FIXTURE_USERS)) console.log(`  ${u.role.padEnd(8)} ${u.email}  (${u.name})`);
  console.log('  Password: value of SEED_PASSWORD in .env');
  console.log('  TradingView routes: MEXC:BTCUSDT.P 15m BULLISH_FLIP / BEARISH_FLIP / CLOSE_LONG / CLOSE_SHORT -> BTCUSDT, fixture strategy package');
  if (ingressToken) {
    const fromEnv = ingressToken === process.env.DEV_INGRESS_TOKEN;
    console.log(fromEnv ? '  Webhook ingress token: DEV_INGRESS_TOKEN from .env' : `  Webhook ingress token (shown once, store it): ${ingressToken}`);
  }
} finally {
  await h.close();
}
