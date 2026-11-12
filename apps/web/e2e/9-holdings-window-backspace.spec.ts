// Paper mode, through the real UI (production build):
// - Trade Settings: clearing percentage fields with Backspace never breaks the editor; Position
//   to close (%) lives on Trailing take profit, 0 is a value and empty is not; the trading window.
// - Signals: an entry outside the investor's trading window shows "Outside trading window".
// - My Holdings: own positions only, prices update by themselves from TrendPilot's feed, stale
//   marking; the detail shows fills, a partial exit with the remaining quantity, linked signals
//   and chart lines for the exact contract (historical stop once closed).
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import pg from 'pg';

test.describe.configure({ mode: 'serial' });

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const DB_URL = process.env.DATABASE_URL_E2E ?? 'postgres://trendpilot:trendpilot@localhost:5433/trendpilot_e2e';
const PASSWORD = process.env.SEED_PASSWORD ?? 'TrendPilot-dev-only-1';
const CLOCK = '2026-11-08T09:30:03Z'; // the e2e web server's fixed signal clock (Sunday 15:30 in Dhaka)
const env = { ...process.env, DATABASE_URL: DB_URL, SIGNAL_TEST_CLOCK: CLOCK, LIVE_ORDER_TRANSPORT: 'disabled' };
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const A = "(SELECT id FROM users WHERE email = 'investor.a@trendpilot.local')";
let positionA = '';

async function sql<T = Record<string, unknown>>(text: string): Promise<T[]> {
  const c = new pg.Client({ connectionString: DB_URL });
  await c.connect();
  try {
    return (await c.query(text)).rows as T[];
  } finally {
    await c.end();
  }
}
const run = (args: string[], extra: Record<string, string> = {}) =>
  execFileSync(npm, args, { cwd: ROOT, env: { ...env, ...extra }, encoding: 'utf8', shell: process.platform === 'win32' });
const priceThenWorker = (price: string, at: string, extra: string[] = []) => {
  run(['run', 'market:tick', '--', '--price', price, '--at', at, ...extra]);
  return run(['run', 'worker:once'], { SIGNAL_TEST_CLOCK: at });
};

async function signIn(page: Page, email: string) {
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).not.toHaveURL(/sign-in/);
}
/** A page that records uncaught errors (a crashed render shows up here). */
async function investorPage(browser: import('@playwright/test').Browser, email: string) {
  const page = await (await browser.newContext()).newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await signIn(page, email);
  return { page, errors };
}

test('prepare: exits profile — both investors have an active BTC/USDT Paper block', async () => {
  await sql(
    'TRUNCATE signal_decisions, jobs, signal_rejections, signal_events, position_targets, position_exits, sim_positions, ledger_entries, fills, positions, sim_fills, sim_orders, order_intents, paper_accounts, market_quotes, market_candles RESTART IDENTITY CASCADE'
  );
  expect(run(['run', 'demo:paper', '--', '--at', CLOCK, '--profile', 'exits'])).toContain('Investor B: BTC/USDT Paper, ACTIVE, every day');
});

test('Backspace clears percentage fields without breaking the editor; inline validation on blur; 0 is a value', async ({ browser }) => {
  const { page, errors } = await investorPage(browser, 'investor.a@trendpilot.local');
  await page.goto('/trade-settings');
  await page.getByRole('button', { name: 'Edit BTC/USDT Paper' }).click();
  const panel = page.getByRole('dialog');

  // The allocation field is not on Take profit any more.
  await expect(panel.getByLabel('Target closes')).toHaveCount(0);
  await panel.getByRole('switch', { name: /Trailing take profit/ }).click();
  const close = panel.getByLabel('Position to close (%)');
  await expect(close).toBeVisible();

  await close.fill('40');
  await expect(panel.getByTestId('tp-LONG').getByTestId('exit-allocation')).toContainText('Take profit 60% · Trailing take profit 40%');
  await close.press('Backspace');
  await close.press('Backspace');
  await expect(close).toHaveValue('');
  await expect(panel).toBeVisible(); // still open, nothing crashed
  await close.press('Tab'); // leave the field: its message shows inline
  await expect(panel.getByText('Enter Position to close (%), from 0 to 100.')).toBeVisible();

  await close.fill('0');
  await close.press('Tab');
  await expect(panel.getByText('Enter Position to close (%), from 0 to 100.')).toHaveCount(0);
  await expect(panel.getByTestId('tp-LONG').getByTestId('exit-allocation')).toContainText('Take profit 100% · Trailing take profit 0%');
  await close.fill('100');
  await expect(panel.getByTestId('tp-LONG').getByTestId('exit-allocation')).toContainText('Take profit 0% · Trailing take profit 100%');
  await close.fill('12.');
  await close.press('Tab');
  await expect(close).toHaveValue('12'); // tidied on blur
  await close.fill('100.5');
  await close.press('Tab');
  await expect(panel.getByText('Enter a value from 0 to 100.')).toBeVisible();

  // Other percentage fields: stop loss and the target move.
  const stop = panel.getByLabel('Stop loss');
  await stop.click();
  await stop.press('End');
  for (let i = 0; i < 6; i++) await stop.press('Backspace');
  await expect(stop).toHaveValue('');
  const move = panel.getByTestId('tp-LONG').getByLabel('Long target — price move');
  await move.click();
  await move.press('End');
  for (let i = 0; i < 4; i++) await move.press('Backspace');
  await expect(move).toHaveValue('');
  await move.press('Tab');

  // Save with invalid values: refused inline, the editor stays open.
  await panel.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(panel.getByText('Fix the highlighted fields before saving.')).toBeVisible();
  await expect(panel).toBeVisible();
  await panel.getByRole('button', { name: 'Cancel' }).click();
  expect(errors).toEqual([]);
});

test('B sets a 22:00–02:00 trading window; the shared alert at 15:30 skips B as "Outside trading window", A opens', async ({ browser, baseURL }) => {
  const { page, errors } = await investorPage(browser, 'investor.b@trendpilot.local');
  await page.goto('/trade-settings');
  await page.getByRole('button', { name: 'Edit BTC/USDT Paper' }).click();
  const panel = page.getByRole('dialog');
  await expect(panel.getByText(/Trading window · Timezone: Asia\/Dhaka · 24-hour HH:mm/)).toBeVisible();
  await panel.getByRole('radio', { name: 'Set hours' }).click();
  await panel.getByLabel('Start (from)').fill('22:00');
  await panel.getByLabel('End (until, not included)').fill('02:00');
  await expect(panel.getByTestId('trading-window-summary')).toContainText('Overnight: from 22:00 on each selected day until 02:00 the next morning (Asia/Dhaka)');
  await panel.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByTestId('trading-window-label')).toHaveText('22:00–02:00 (next day)');

  expect(run(['run', 'replay', '--', '--url', baseURL!])).toMatch(/→ 202 \{"status":"accepted"/);
  expect(run(['run', 'worker:once'])).toMatch(/entriesApproved=1/);
  const [p] = await sql<{ id: string }>(`SELECT id FROM positions WHERE owner_id = ${A} AND status = 'OPEN'`);
  positionA = p!.id;

  await page.goto('/signals');
  const outcome = page.getByTestId('signal-outcome').first();
  await expect(outcome).toHaveAttribute('data-reason', 'OUTSIDE_TRADING_WINDOW');
  await expect(outcome.getByTestId('outcome-status')).toHaveText('Skipped · Outside trading window');
  await expect(outcome).toContainText('Outside trading window.');
  expect(errors).toEqual([]);
});

test('My Holdings: A sees only A\'s position; the price updates by itself from the feed; stale marking', async ({ browser }) => {
  const { page, errors } = await investorPage(browser, 'investor.a@trendpilot.local');
  await page.getByRole('link', { name: 'My Holdings' }).click();
  await expect(page).toHaveURL(/\/my-holdings$/);
  const rows = page.getByTestId('holding-row');
  await expect(rows).toHaveCount(1);
  const row = rows.first();
  await expect(row).toContainText('BTC/USDT');
  await expect(row).toContainText('MEXC · BTC_USDT perpetual');
  await expect(row).toContainText('Paper');
  await expect(row).toContainText('Long');
  await expect(row).toContainText('153');
  await expect(row).toContainText('65,000.5');
  await expect(row).toContainText('Protected');
  // The fixture quote is days old in browser time: marked stale.
  await expect(row.getByTestId('holding-price')).toHaveAttribute('data-stale', 'true');
  await expect(page.getByTestId('live-connection')).toHaveText('Live');

  // A new price from the feed, stamped now: pushed to the page without reloading.
  run(['run', 'market:tick', '--', '--price', '65500', '--at', new Date().toISOString()]);
  // Only the displayed price matters here: drop the exit-engine job of this real-time quote so it
  // cannot act later in the replay's fixed clock.
  await sql("DELETE FROM jobs WHERE kind = 'market.tick' AND status = 'PENDING'");
  await expect(row.getByTestId('holding-price')).toContainText('65,500');
  await expect(row.getByTestId('holding-price')).toHaveAttribute('data-stale', 'false');
  await expect(row.getByTestId('holding-price')).toContainText('Fixture');
  await expect(row.getByTestId('holding-unrealized')).toContainText('+7.64'); // (65500 − 65000.5) × 153 × 0.0001
  expect(errors).toEqual([]);
});

test('B sees none of A\'s holdings and gets a 404 for A\'s holding page', async ({ browser }) => {
  const { page } = await investorPage(browser, 'investor.b@trendpilot.local');
  await page.goto('/my-holdings');
  await expect(page.getByText('No open positions')).toBeVisible();
  await expect(page.getByTestId('holding-row')).toHaveCount(0);
  const res = await page.goto(`/my-holdings/${positionA}`);
  expect(res!.status()).toBe(404);
  const api = await page.request.get(`/v1/me/holdings/${positionA}/chart`);
  expect(api.status()).toBe(404);
});

test('a partial take-profit (arm, then pullback with limited liquidity): the detail shows the exit fill and the remaining quantity', async ({ browser }) => {
  expect(priceThenWorker('67000', '2026-11-08T09:30:30Z')).toMatch(/takeProfitsRequested=0 .*targetsArmed=1/); // A's 3 % target (66950.5): armed
  expect(priceThenWorker('66900', '2026-11-08T09:30:40Z', ['--liquidity', '50'])).toMatch(/EXPIRED \(PARTIAL_FILL\) filled=50 remaining=103 exit=TAKE_PROFIT/);

  const { page, errors } = await investorPage(browser, 'investor.a@trendpilot.local');
  await page.goto('/my-holdings');
  await page.getByTestId('holding-row').first().click();
  await expect(page).toHaveURL(new RegExp(`/my-holdings/${positionA}$`));
  await expect(page.getByTestId('detail-remaining')).toHaveText('103 of 153 contracts');
  await expect(page.getByTestId('partial-summary')).toContainText('1 exit fill closed 50 contracts; 103 remain open');
  const fills = page.getByTestId('fill-row');
  await expect(fills).toHaveCount(2);
  await expect(fills.nth(0)).toHaveAttribute('data-kind', 'Open');
  await expect(fills.nth(0)).toContainText('Bullish flip');
  await expect(fills.nth(1)).toHaveAttribute('data-kind', 'Close');
  await expect(fills.nth(1)).toContainText('Take profit');
  await expect(fills.nth(1)).toContainText('50');
  await expect(fills.nth(1)).toContainText('103');
  await expect(page.getByTestId('linked-signal')).toContainText('Opened by Bullish flip');
  await expect(page.getByTestId('detail-target').first()).toHaveAttribute('data-armed', 'true');
  // The plan of the position's own side, saved at entry.
  await expect(page.getByTestId('detail-tp-plan')).toHaveText('Long take profit · Fixed · targets above entry');

  // Chart for the exact contract, with the entry and current stop lines.
  const chart = page.getByTestId('position-chart');
  await expect(chart).toContainText('MEXC · BTC_USDT perpetual');
  await expect(chart.locator('canvas').first()).toBeVisible();
  await expect(chart.locator('[data-kind="ENTRY"]')).toHaveAttribute('data-price', '65000.5');
  await expect(chart.locator('[data-kind="STOP"]')).toHaveAttribute('data-price', '64025.5');
  await expect(chart.locator('[data-kind="STOP"]')).toHaveAttribute('data-historical', 'false');
  await expect(chart.locator('[data-kind="STOP"]')).toContainText('Stop loss 64025.5');
  expect(errors).toEqual([]);
});

test('after the rest closes, the holding moves to Closed and its chart labels the last stop as historical', async ({ browser }) => {
  expect(priceThenWorker('66900', '2026-11-08T09:30:50Z')).toMatch(/FILLED filled=103 remaining=0 position CLOSED exit=TAKE_PROFIT/);
  const { page, errors } = await investorPage(browser, 'investor.a@trendpilot.local');
  await page.goto('/my-holdings');
  await expect(page.getByTestId('holding-row')).toHaveCount(0);
  await page.getByRole('tab', { name: /Closed positions/ }).click();
  await expect(page.getByTestId('closed-row')).toHaveCount(1);
  await page.getByTestId('closed-row').first().click();
  const chart = page.getByTestId('position-chart');
  await expect(chart.locator('[data-kind="STOP"]')).toHaveAttribute('data-historical', 'true');
  await expect(chart.locator('[data-kind="STOP"]')).toContainText('Stop loss (historical) 64025.5');
  await expect(page.getByTestId('fill-row')).toHaveCount(3);
  expect(errors).toEqual([]);
});
