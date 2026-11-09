/**
 * Read-only MEXC Futures account check for the pilot handoff (Step 11). Sends GET requests on the
 * READ_ONLY transport only (an allowlist of account/position/order queries); it cannot place,
 * change or cancel anything. Keys come from the environment and are never printed.
 *
 *   MEXC_READONLY_API_KEY=… MEXC_READONLY_SECRET_KEY=… npm run ops:mexc-readonly-check -- [--symbol BTC_USDT]
 *
 * Use a key created with ONLY "View Account Details" and "View Order Details" permissions.
 */
import { eq } from 'drizzle-orm';
import { Decimal } from '@trendpilot/domain';
import { createDb } from '../client';
import { loadRootEnv } from '../env';
import { MexcHttpTransport, MEXC_PRIVATE_DEFAULT_BASE_URL, normalizeAssets, normalizePositions, normalizeStops } from '../live/mexcPrivate';
import { MexcPublicClient } from '../market/mexcPublic';
import { instruments } from '../schema';

loadRootEnv();
const arg = (n: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const symbol = (arg('symbol') ?? 'BTC_USDT').toUpperCase();
const apiKey = process.env.MEXC_READONLY_API_KEY ?? '';
const secretKey = process.env.MEXC_READONLY_SECRET_KEY ?? '';
if (!apiKey || !secretKey) {
  console.log('PENDING: no authorized read-only MEXC account is configured (MEXC_READONLY_API_KEY / MEXC_READONLY_SECRET_KEY unset). Nothing was sent.');
  process.exit(3);
}

const t = new MexcHttpTransport({ mode: 'READ_ONLY', credentials: { apiKey, secretKey }, baseUrl: process.env.MEXC_PRIVATE_BASE_URL || MEXC_PRIVATE_DEFAULT_BASE_URL });
const results: { check: string; ok: boolean; detail: string }[] = [];
const step = async (check: string, fn: () => Promise<string>) => {
  try {
    results.push({ check, ok: true, detail: await fn() });
  } catch (e) {
    results.push({ check, ok: false, detail: (e as Error).message });
  }
};

await step('position mode', async () => {
  const m = await t.request<number>('GET', '/api/v1/private/position/position_mode');
  return m === 2 ? 'ONE_WAY (2)' : m === 1 ? 'HEDGE (1): closes rely on close sides 4/2; one-way exposure is enforced by the adapter' : `unknown (${m})`;
});
await step('balances', async () => normalizeAssets(await t.request('GET', '/api/v1/private/account/assets')).filter((a) => a.currency === 'USDT').map((a) => `USDT equity ${a.equity}, available ${a.available}, open ${a.availableOpen}`).join('; ') || 'no USDT asset');
await step(`open positions (${symbol})`, async () => {
  const p = normalizePositions(await t.request('GET', '/api/v1/private/position/open_positions', { symbol }));
  return p.length ? p.map((x) => `${x.side} ${x.contracts} @ ${x.avgEntryPrice} ${x.marginMode} ${x.leverage}x`).join('; ') : 'none';
});
await step(`stop orders (${symbol})`, async () => {
  const s = normalizeStops(await t.request('GET', '/api/v1/private/stoporder/open_orders', { symbol }));
  return s.length ? s.map((x) => `${x.state} ${x.positionSide} SL ${x.stopLossPrice} ${x.basis} vol ${x.vol}`).join('; ') : 'none';
});
await step(`leverage (${symbol})`, async () => JSON.stringify(await t.request('GET', '/api/v1/private/position/leverage', { symbol })).slice(0, 300));
await step(`risk limit (${symbol})`, async () => JSON.stringify(await t.request('GET', '/api/v1/private/account/risk_limit', { symbol })).slice(0, 300));
await step('contract spec vs platform instrument', async () => {
  const d = await new MexcPublicClient().contractDetail(symbol);
  const url = process.env.DATABASE_URL;
  if (!url) return `MEXC: size ${d.contractSize}, tick ${d.priceUnit}, step ${d.volUnit}, min ${d.minVol} (no DATABASE_URL to compare)`;
  const h = createDb(url, 1);
  try {
    const [i] = await h.db.select().from(instruments).where(eq(instruments.exchangeSymbol, symbol));
    if (!i) return `no platform instrument mapped to ${symbol}`;
    const diff = (
      [
        ['contractSize', i.contractMultiplier, d.contractSize],
        ['priceTick', i.priceTick, d.priceUnit],
        ['qtyStep', i.qtyStep, d.volUnit],
        ['minQty', i.minQty, d.minVol]
      ] as const
    ).filter(([, a, b]) => !new Decimal(a).eq(b));
    if (diff.length) throw new Error(`differs: ${diff.map(([f, a, b]) => `${f} platform ${a} vs MEXC ${b}`).join(', ')}`);
    return 'matches';
  } finally {
    await h.close();
  }
});

for (const r of results) console.log(`${r.ok ? 'OK  ' : 'FAIL'}  ${r.check}: ${r.detail}`);
process.exit(results.every((r) => r.ok) ? 0 : 1);
