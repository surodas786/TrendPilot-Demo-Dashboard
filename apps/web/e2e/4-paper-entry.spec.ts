// M2 slice 2 end to end through the local replay: one shared alert opens a protected paper Long
// for Investor A while Investor B gets DAY_DISABLED; a duplicate alert and a worker crash right
// after the simulated fill still leave one fill, one position and one margin debit.
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import pg from 'pg';

test.describe.configure({ mode: 'serial' });

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const DB_URL = process.env.DATABASE_URL_E2E ?? 'postgres://trendpilot:trendpilot@localhost:5433/trendpilot_e2e';
const PASSWORD = process.env.SEED_PASSWORD ?? 'TrendPilot-dev-only-1';
const CLOCK = '2026-11-08T09:30:03Z'; // same fixed signal clock as the e2e web server (Sunday in Dhaka)
const env = { ...process.env, DATABASE_URL: DB_URL, SIGNAL_TEST_CLOCK: CLOCK, LIVE_ORDER_TRANSPORT: 'disabled' };
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

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

async function signIn(page: Page, email: string) {
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).not.toHaveURL(/sign-in/);
}

const count = async (q: string) => Number((await sql<{ n: string }>(q))[0]!.n);

test('prepare: clear earlier signal/paper state and run the demo setup', async () => {
  // The e2e server's signal clock is fixed, so this spec reuses the same bar as spec 3.
  await sql(
    'TRUNCATE signal_decisions, jobs, signal_rejections, signal_events, position_targets, position_exits, sim_positions, ledger_entries, fills, positions, sim_fills, sim_orders, order_intents, paper_accounts, market_quotes, market_candles RESTART IDENTITY CASCADE'
  );
  const out = run(['run', 'demo:paper', '--', '--at', CLOCK]);
  expect(out).toContain('Investor A: BTC/USDT Paper, ACTIVE, every day');
  expect(out).toContain('Investor B: BTC/USDT Paper, ACTIVE, every day except Sunday -> expect DAY_DISABLED');
  expect(out).toContain('FIXTURE market (up)');
});

test('replay: the shared alert is accepted once; the duplicate returns 200', async ({ baseURL }) => {
  const out = run(['run', 'replay', '--', '--url', baseURL!, '--repeat', '2']);
  expect(out).toMatch(/→ 202 \{"status":"accepted"/);
  expect(out).toMatch(/→ 200 \{"status":"duplicate"/);
});

test('worker crashes right after the simulated fill; the platform has not recorded it yet', async () => {
  let output = '';
  try {
    output = run(['run', 'worker:once'], { PAPER_SIM_CRASH_AFTER_FILL: '1' });
  } catch (e) {
    output = String((e as { stdout?: string }).stdout ?? '');
  }
  expect(output).toMatch(/entriesApproved=1/);
  expect(output).toContain('PAPER_SIM_CRASH_AFTER_FILL: exiting after the simulated fill');
  expect(await count('SELECT count(*) AS n FROM sim_fills')).toBe(1);
  expect(await count('SELECT count(*) AS n FROM fills')).toBe(0);
  expect((await sql<{ state: string }>('SELECT state FROM order_intents'))[0]!.state).toBe('SUBMITTING');
});

test('the same alert again, then a restarted worker reconciles instead of resubmitting', async ({ baseURL }) => {
  expect(run(['run', 'replay', '--', '--url', baseURL!])).toMatch(/→ 200 \{"status":"duplicate"/);
  // The crashed worker's 30 s lease (real time) must expire first; expire it now to keep the test fast.
  await sql("UPDATE jobs SET claim_expires_at = '2000-01-01' WHERE status = 'RUNNING'");
  const out = run(['run', 'worker:once']);
  expect(out).toMatch(/FILLED position=[0-9a-f-]{36} \[reconciled with simulator\]/);
  expect(run(['run', 'worker:once'])).toContain('no runnable jobs');

  const a = "(SELECT id FROM users WHERE email = 'investor.a@trendpilot.local')";
  expect(await count(`SELECT count(*) AS n FROM sim_orders WHERE kind = 'MARKET_OPEN'`)).toBe(1);
  expect(await count(`SELECT count(*) AS n FROM fills WHERE owner_id = ${a}`)).toBe(1);
  expect(await count(`SELECT count(*) AS n FROM positions WHERE owner_id = ${a}`)).toBe(1);
  expect(await count(`SELECT count(*) AS n FROM ledger_entries WHERE owner_id = ${a} AND kind = 'POSITION_MARGIN'`)).toBe(1);
  expect(await count(`SELECT count(*) AS n FROM order_intents WHERE owner_id <> ${a}`)).toBe(0); // B: no order at all
});

test('Investor A sees the protected Long and its stop; B sees DAY_DISABLED and cannot reach A\'s records', async ({ browser }) => {
  const [pos] = await sql<{ id: string; open_intent_id: string }>("SELECT p.id, p.open_intent_id FROM positions p JOIN users u ON u.id = p.owner_id WHERE u.email = 'investor.a@trendpilot.local'");

  const pageA = await (await browser.newContext()).newPage();
  await signIn(pageA, 'investor.a@trendpilot.local');
  await pageA.getByRole('link', { name: 'My Trades' }).click();
  const row = pageA.getByTestId('position-BTCUSDT');
  await expect(row).toHaveAttribute('data-protection', 'PROTECTED');
  await expect(row.getByTestId('avg-entry')).toHaveText('65000.5');
  await expect(row.getByTestId('stop')).toContainText('64025.5');
  await expect(row.getByTestId('stop')).toContainText('Protected · covers 153');
  await row.getByRole('link', { name: 'Details' }).click();
  await expect(pageA.getByTestId('stop-price')).toHaveText('64025.5');
  await expect(pageA.getByTestId('stop-contracts')).toHaveText('153');
  await expect(pageA.getByTestId('fill')).toHaveCount(1);
  await pageA.goto('/signals');
  await expect(pageA.getByTestId('outcome-status').first()).toContainText('Paper Long · filled');

  const pageB = await (await browser.newContext()).newPage();
  await signIn(pageB, 'investor.b@trendpilot.local');
  await pageB.goto('/signals');
  await expect(pageB.getByTestId('signal-outcome').first()).toHaveAttribute('data-reason', 'DAY_DISABLED');
  await pageB.goto('/my-trades');
  await expect(pageB.getByText('No open paper positions')).toBeVisible();
  expect((await pageB.request.get(`/v1/me/trades/${pos!.id}`)).status()).toBe(404);
  expect((await pageB.request.get(`/v1/me/orders/${pos!.open_intent_id}`)).status()).toBe(404);
  await pageB.goto(`/my-trades/${pos!.id}`);
  await expect(pageB.getByText('64025.5')).toHaveCount(0);
});
