// M2 slice 3 end to end through the local replay: two investors open Longs from one alert; a
// replayed price reaches only A's 3 % target, the worker crashes right after the simulated close
// fill and a restart reconciles it once; B stays open with its stop, then closes manually from
// My Trades. B cannot close A's position by ID.
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import pg from 'pg';

test.describe.configure({ mode: 'serial' });

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const DB_URL = process.env.DATABASE_URL_E2E ?? 'postgres://trendpilot:trendpilot@localhost:5433/trendpilot_e2e';
const PASSWORD = process.env.SEED_PASSWORD ?? 'TrendPilot-dev-only-1';
const CLOCK = '2026-11-08T09:30:03Z'; // the e2e web server's fixed signal clock (Sunday in Dhaka)
const T0 = '2026-11-08T09:30:50Z'; // replayed price that reaches A's target (arms it only)
const T1 = '2026-11-08T09:31:00Z'; // replayed pullback through A's target (closes it)
const T2 = '2026-11-08T09:31:05Z'; // worker clock for B's manual close
const env = { ...process.env, DATABASE_URL: DB_URL, SIGNAL_TEST_CLOCK: CLOCK, LIVE_ORDER_TRANSPORT: 'disabled' };
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const A = "(SELECT id FROM users WHERE email = 'investor.a@trendpilot.local')";
const B = "(SELECT id FROM users WHERE email = 'investor.b@trendpilot.local')";

async function sql<T = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> {
  const c = new pg.Client({ connectionString: DB_URL });
  await c.connect();
  try {
    return (await c.query(text, params)).rows as T[];
  } finally {
    await c.end();
  }
}
const run = (args: string[], extra: Record<string, string> = {}) =>
  execFileSync(npm, args, { cwd: ROOT, env: { ...env, ...extra }, encoding: 'utf8', shell: process.platform === 'win32' });
const count = async (q: string) => Number((await sql<{ n: string }>(q))[0]!.n);

async function signIn(page: Page, email: string) {
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).not.toHaveURL(/sign-in/);
}

test('prepare: exits profile (A TP 3 %, B TP 6 %), replay the alert, open both Longs', async ({ baseURL }) => {
  await sql(
    'TRUNCATE signal_decisions, jobs, signal_rejections, signal_events, position_targets, position_exits, sim_positions, ledger_entries, fills, positions, sim_fills, sim_orders, order_intents, paper_accounts, market_quotes, market_candles RESTART IDENTITY CASCADE'
  );
  const out = run(['run', 'demo:paper', '--', '--at', CLOCK, '--profile', 'exits']);
  expect(out).toContain('Investor B: BTC/USDT Paper, ACTIVE, every day, 50 USDT x5, stop 2%, TP 6% (A has TP 3%)');
  expect(run(['run', 'replay', '--', '--url', baseURL!])).toMatch(/→ 202 \{"status":"accepted"/);
  expect(run(['run', 'worker:once'])).toMatch(/entriesApproved=2/);
  expect(await count("SELECT count(*) AS n FROM positions WHERE status = 'OPEN' AND protection_status = 'PROTECTED'")).toBe(2);
});

test('a price reaching only A\'s target arms it; nothing closes on the first touch', async () => {
  expect(run(['run', 'market:tick', '--', '--price', '67000', '--at', T0])).toContain('FIXTURE tick BTCUSDT');
  expect(run(['run', 'worker:once'], { SIGNAL_TEST_CLOCK: T0 })).toMatch(/takeProfitsRequested=0 .*targetsArmed=1/);
  expect(await count("SELECT count(*) AS n FROM sim_orders WHERE kind = 'MARKET_CLOSE'")).toBe(0);
  expect(await count(`SELECT count(*) AS n FROM position_targets WHERE owner_id = ${A} AND armed_at IS NOT NULL AND trigger_rule = 'ARM_PULLBACK'`)).toBe(1);
});

test('the pullback through A\'s target closes it; the worker crashes after the simulated close fill', async () => {
  expect(run(['run', 'market:tick', '--', '--price', '66900', '--at', T1])).toContain('FIXTURE tick BTCUSDT');
  let output = '';
  try {
    output = run(['run', 'worker:once'], { SIGNAL_TEST_CLOCK: T1, PAPER_SIM_CRASH_AFTER_FILL: '1' });
  } catch (e) {
    output = String((e as { stdout?: string }).stdout ?? '');
  }
  expect(output).toMatch(/market tick stopsTriggered=0 stopExitsRecorded=0 takeProfitsRequested=1/);
  expect(output).toContain('PAPER_SIM_CRASH_AFTER_FILL: exiting after the simulated fill');
  expect(await count("SELECT count(*) AS n FROM sim_orders WHERE kind = 'MARKET_CLOSE'")).toBe(1);
  expect(await count('SELECT count(*) AS n FROM position_exits')).toBe(0);
});

test('a restarted worker reconciles the close once; B stays open and protected', async () => {
  await sql("UPDATE jobs SET claim_expires_at = '2000-01-01' WHERE status = 'RUNNING'");
  const out = run(['run', 'worker:once'], { SIGNAL_TEST_CLOCK: T1 });
  expect(out).toMatch(/paper close [0-9a-f-]{36} FILLED filled=153 remaining=0 position CLOSED \[reconciled with simulator\]/);
  expect(run(['run', 'worker:once'], { SIGNAL_TEST_CLOCK: T1 })).toContain('no runnable jobs');

  expect(await count("SELECT count(*) AS n FROM sim_orders WHERE kind = 'MARKET_CLOSE'")).toBe(1);
  expect(await count(`SELECT count(*) AS n FROM position_exits WHERE owner_id = ${A}`)).toBe(1);
  expect(await count(`SELECT count(*) AS n FROM ledger_entries WHERE owner_id = ${A} AND kind = 'POSITION_MARGIN_RELEASE'`)).toBe(1);
  expect(await count(`SELECT count(*) AS n FROM positions WHERE owner_id = ${A} AND status = 'CLOSED' AND close_reason = 'TAKE_PROFIT' AND contracts = 0`)).toBe(1);
  expect(await count(`SELECT count(*) AS n FROM positions WHERE owner_id = ${B} AND status = 'OPEN' AND protection_status = 'PROTECTED'`)).toBe(1);
  expect(await count("SELECT count(*) AS n FROM positions WHERE side = 'SHORT'")).toBe(0);
});

test('A sees the closed Paper trade with exit reason, remaining quantity and realized P&L', async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await signIn(page, 'investor.a@trendpilot.local');
  await page.goto('/my-trades');
  const row = page.getByTestId('closed-BTCUSDT');
  await expect(row).toHaveAttribute('data-reason', 'TAKE_PROFIT');
  await expect(row.getByTestId('exit-reason')).toHaveText('Take profit');
  await expect(row.getByTestId('remaining')).toHaveText('153 · 0');
  await expect(row.getByTestId('realized-pnl')).toHaveText('+29.0547 USDT'); // (66899.5 bid − 65000.5) × 153 × 0.0001
  await expect(row.getByText('Paper')).toBeVisible();
  await row.getByRole('link', { name: 'Details' }).click();
  await expect(page.getByTestId('exit')).toHaveCount(1);
  await expect(page.getByTestId('exit')).toHaveAttribute('data-reason', 'TAKE_PROFIT');
  await expect(page.getByTestId('remaining')).toHaveText('0 of 153');
});

test('B cannot close A\'s position by ID; B closes its own from My Trades', async ({ browser }) => {
  const [posA] = await sql<{ id: string }>(`SELECT id FROM positions WHERE owner_id = ${A}`);
  const page = await (await browser.newContext()).newPage();
  await signIn(page, 'investor.b@trendpilot.local');
  const denied = await page.request.post(`/v1/me/positions/${posA!.id}/close`, { headers: { 'idempotency-key': 'e2e-b-closes-a-0001' } });
  expect(denied.status()).toBe(404);

  await page.goto('/my-trades');
  const row = page.getByTestId('position-BTCUSDT');
  await expect(row).toHaveAttribute('data-protection', 'PROTECTED');
  await row.getByTestId('close-position').click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Close at market' }).click();
  await expect(page.getByTestId('close-message')).toContainText('Close requested');

  expect(run(['run', 'worker:once'], { SIGNAL_TEST_CLOCK: T2 })).toMatch(/paper close [0-9a-f-]{36} FILLED filled=\d+ remaining=0 position CLOSED/);
  await page.reload();
  await expect(page.getByTestId('closed-BTCUSDT')).toHaveAttribute('data-reason', 'MANUAL_CLOSE');
  expect(await count(`SELECT count(*) AS n FROM positions WHERE owner_id = ${A} AND status = 'CLOSED' AND close_reason = 'TAKE_PROFIT'`)).toBe(1);
  expect(await count(`SELECT count(*) AS n FROM order_intents WHERE kind = 'CLOSE' AND owner_id = ${B}`)).toBe(1);
  // Ledger and accounts still reconcile for both investors.
  const rec = await sql<{ ok: boolean }>(
    'SELECT bool_and(wallet_balance = ledger_wallet AND position_margin = ledger_position_margin AND order_reserve = ledger_order_reserve) AS ok FROM paper_account_reconciliation'
  );
  expect(rec[0]!.ok).toBe(true);
});
