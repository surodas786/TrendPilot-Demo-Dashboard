// M2 slice 4 end to end through the local replay: split TP with a partially filled target and
// Trailing Take Profit on the remainder (A) and on the whole position (B), then close-and-reverse (A reverses into a
// protected Short, B stays flat). Every `worker:once` is a new process, so persisted trailing
// state across runs is a real restart.
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import pg from 'pg';

test.describe.configure({ mode: 'serial' });

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const DB_URL = process.env.DATABASE_URL_E2E ?? 'postgres://trendpilot:trendpilot@localhost:5433/trendpilot_e2e';
const PASSWORD = process.env.SEED_PASSWORD ?? 'TrendPilot-dev-only-1';
const CLOCK = '2026-11-08T09:30:03Z'; // the e2e web server's fixed signal clock
const env = { ...process.env, DATABASE_URL: DB_URL, SIGNAL_TEST_CLOCK: CLOCK, LIVE_ORDER_TRANSPORT: 'disabled' };
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const A = "(SELECT id FROM users WHERE email = 'investor.a@trendpilot.local')";
const B = "(SELECT id FROM users WHERE email = 'investor.b@trendpilot.local')";
const RESET =
  'TRUNCATE signal_decisions, jobs, signal_rejections, signal_events, position_targets, position_exits, sim_positions, ledger_entries, fills, positions, sim_fills, sim_orders, order_intents, paper_accounts, market_quotes, market_candles RESTART IDENTITY CASCADE';

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
/** One replayed price, then one worker process at that time. */
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

test('split profile: both investors open a Long from the shared alert', async ({ baseURL }) => {
  await sql(RESET);
  const out = run(['run', 'demo:paper', '--', '--at', CLOCK, '--profile', 'split']);
  expect(out).toContain('split TP 50% @ +2% and 30% @ +4%, trailing take profit on 20%: trail 1% after +3% (mark)');
  expect(run(['run', 'replay', '--', '--url', baseURL!])).toMatch(/→ 202 \{"status":"accepted"/);
  expect(run(['run', 'worker:once'])).toMatch(/entriesApproved=2/);
  const targets = await sql<{ level_id: string; trigger_price: string; planned_contracts: string }>(
    `SELECT level_id, trigger_price::float8::text AS trigger_price, planned_contracts::int::text AS planned_contracts FROM position_targets WHERE owner_id = ${A} ORDER BY ordinal`
  );
  expect(targets).toEqual([
    { level_id: 'tp1', trigger_price: '66300.5', planned_contracts: '76' },
    { level_id: 'tp2', trigger_price: '67600.5', planned_contracts: '45' }
  ]);
});

test('target 1 fills partly (limited liquidity), then resumes for exactly its remainder', async () => {
  let out = priceThenWorker('66400', '2026-11-08T09:30:20Z', ['--liquidity', '50']);
  expect(out).toMatch(/paper close [0-9a-f-]{36} EXPIRED \(PARTIAL_FILL\) filled=50 remaining=103 exit=TAKE_PROFIT target=tp1/);
  out = priceThenWorker('66400', '2026-11-08T09:30:30Z');
  expect(out).toMatch(/FILLED filled=26 remaining=77 exit=TAKE_PROFIT target=tp1/);
  // The same price again: the completed target is not repeated.
  out = priceThenWorker('66400', '2026-11-08T09:30:35Z');
  expect(out).toMatch(/takeProfitsRequested=0/);
  expect(await count(`SELECT count(*) AS n FROM order_intents WHERE kind = 'CLOSE' AND owner_id = ${A}`)).toBe(2);
  const [stop] = await sql<{ contracts: string }>(`SELECT o.contracts::int::text AS contracts FROM positions p JOIN sim_orders o ON o.client_order_id = p.stop_order_ref WHERE p.owner_id = ${A}`);
  expect(stop!.contracts).toBe('77');
});

test('trailing activates for A and survives separate worker processes; target 2 fills', async () => {
  let out = priceThenWorker('67000', '2026-11-08T09:30:40Z');
  expect(out).toMatch(/trailingActivated=1/);
  out = priceThenWorker('67700', '2026-11-08T09:30:50Z'); // a new worker process
  expect(out).toMatch(/FILLED filled=45 remaining=32 exit=TAKE_PROFIT target=tp2/);
  const [a] = await sql<{ watermark: string; level: string; status: string }>(
    `SELECT trailing_watermark::float8::text AS watermark, trailing_stop_price::float8::text AS level, trailing_status AS status FROM positions WHERE owner_id = ${A}`
  );
  expect(a).toEqual({ watermark: '67700', level: '67023', status: 'ACTIVE' });
});

test('A sees target progress, remaining stop coverage and the trailing level', async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await signIn(page, 'investor.a@trendpilot.local');
  await page.goto('/my-trades');
  const row = page.getByTestId('position-BTCUSDT');
  await expect(row.getByTestId('target-progress')).toContainText('2 of 2 targets filled');
  await expect(row.getByTestId('stop')).toContainText('Protected · covers 32');
  await expect(row.getByTestId('trailing')).toContainText('Trailing take profit: Active · closes at 67023 (best 67700) · 32 contracts');
  await row.getByRole('link', { name: 'Details' }).click();
  await expect(page.locator('[data-testid="target"][data-level="tp1"]')).toHaveAttribute('data-status', 'DONE');
  await expect(page.locator('[data-testid="target"][data-level="tp1"]')).toContainText('102'); // requested 76 + 26
  await expect(page.getByTestId('trailing-level')).toHaveText('67023');
  await expect(page.getByTestId('trailing-state')).toHaveText('Active');
  await expect(page.getByTestId('trailing-contracts')).toHaveText('32 contracts');
  await expect(page.getByTestId('remaining')).toHaveText('32 of 153');
});

test('the price falls back to the trailing levels: A and B close by TRAILING_TAKE_PROFIT', async () => {
  const out = priceThenWorker('67000', '2026-11-08T09:31:00Z');
  expect(out).toMatch(/trailingTakeProfitsRequested=2/);
  expect(await count(`SELECT count(*) AS n FROM positions WHERE status = 'CLOSED' AND close_reason = 'TRAILING_TAKE_PROFIT'`)).toBe(2);
  expect(await count('SELECT count(*) AS n FROM sim_positions WHERE contracts <> 0')).toBe(0);
  const rec = await sql<{ ok: boolean }>('SELECT bool_and(wallet_balance = ledger_wallet AND position_margin = ledger_position_margin AND order_reserve = ledger_order_reserve) AS ok FROM paper_account_reconciliation');
  expect(rec[0]!.ok).toBe(true);
});

test('reverse profile: a bearish flip closes both Longs; A reverses into a protected Short, B stays flat', async ({ baseURL }) => {
  await sql(RESET);
  // The e2e server's clock is frozen at 09:30:03 and an opposite flip on the same bar is rejected
  // (CONFLICTING_SAME_BAR), so the Longs open from the previous bar (09:00, closed 09:15). The
  // route's receipt window is widened for that one older alert and restored afterwards.
  const OPEN_AT = '2026-11-08T09:15:03Z';
  await sql('UPDATE signal_routes SET max_signal_age_seconds = 3600');
  try {
    expect(run(['run', 'demo:paper', '--', '--at', OPEN_AT, '--profile', 'reverse'])).toContain('Long only -> its reversal stays flat (DIRECTION_DISABLED)');
    expect(run(['run', 'replay', '--', '--url', baseURL!, '--now', OPEN_AT], { SIGNAL_TEST_CLOCK: OPEN_AT })).toMatch(/→ 202/);
  } finally {
    await sql('UPDATE signal_routes SET max_signal_age_seconds = 120');
  }
  expect(run(['run', 'worker:once'], { SIGNAL_TEST_CLOCK: OPEN_AT })).toMatch(/entriesApproved=2/);

  run(['run', 'market:tick', '--', '--price', '64900', '--at', '2026-11-08T09:30:20Z']);
  expect(run(['run', 'replay', '--', '--url', baseURL!, '--action', 'BEARISH_FLIP'])).toMatch(/→ 202/);
  const out = run(['run', 'worker:once'], { SIGNAL_TEST_CLOCK: '2026-11-08T09:30:20Z' });
  expect(out).toMatch(/exitsRequested=2 exitsHeld=0 reversalsPending=2/);
  expect(out).toMatch(/reversal for close [0-9a-f-]{36} ENTRY_APPROVED/);
  expect(out).toMatch(/reversal for close [0-9a-f-]{36} SKIPPED \(DIRECTION_DISABLED\)/);

  expect(await count(`SELECT count(*) AS n FROM positions WHERE owner_id = ${A} AND side = 'SHORT' AND status = 'OPEN' AND protection_status = 'PROTECTED'`)).toBe(1);
  expect(await count(`SELECT count(*) AS n FROM positions WHERE owner_id = ${A} AND side = 'LONG' AND status = 'CLOSED' AND close_reason = 'REVERSAL_CLOSE'`)).toBe(1);
  expect(await count(`SELECT count(*) AS n FROM positions WHERE owner_id = ${B} AND status = 'OPEN'`)).toBe(0);

  // The same alert again: duplicate; nothing more to run; no extra fill or entry.
  const fills = await count('SELECT count(*) AS n FROM fills');
  expect(run(['run', 'replay', '--', '--url', baseURL!, '--action', 'BEARISH_FLIP'])).toMatch(/→ 200 \{"status":"duplicate"/);
  expect(run(['run', 'worker:once'], { SIGNAL_TEST_CLOCK: '2026-11-08T09:30:20Z' })).toContain('no runnable jobs');
  expect(await count('SELECT count(*) AS n FROM fills')).toBe(fills);
});

test('A and B see each reversal outcome in Signals and on the trade', async ({ browser }) => {
  const pageA = await (await browser.newContext()).newPage();
  await signIn(pageA, 'investor.a@trendpilot.local');
  await pageA.goto('/signals');
  await expect(pageA.getByTestId('reversal-status').first()).toHaveAttribute('data-reversal', 'ENTRY_APPROVED');
  await expect(pageA.getByTestId('reversal-status').first()).toContainText('Reversed · Paper Short filled');
  await pageA.goto('/my-trades');
  await pageA.getByTestId('closed-BTCUSDT').getByRole('link', { name: 'Details' }).click();
  await expect(pageA.getByTestId('reversal')).toHaveAttribute('data-status', 'ENTRY_APPROVED');
  await pageA.getByRole('link', { name: 'View the new position' }).click();
  await expect(pageA.getByTestId('stop-detail')).toContainText('PROTECTED');

  const pageB = await (await browser.newContext()).newPage();
  await signIn(pageB, 'investor.b@trendpilot.local');
  await pageB.goto('/signals');
  const rb = pageB.getByTestId('reversal-status').first();
  await expect(rb).toHaveAttribute('data-reversal', 'SKIPPED');
  await expect(rb).toHaveAttribute('data-reversal-reason', 'DIRECTION_DISABLED');
  await expect(rb).toContainText('Stayed flat · DIRECTION_DISABLED');
});
