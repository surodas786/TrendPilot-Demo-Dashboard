// Step 9 end to end: two investors on the same token with different sizes and exits. A's 3 % target
// fills; B (6 % target) stays open. Each investor's Dashboard, Holdings, My Trades and Signals show
// only their own balances, trades and decisions, and the totals match the paper fills and ledger.
// Requesting the other investor's trade by ID returns not found (page and API).
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import pg from 'pg';

test.describe.configure({ mode: 'serial' });

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const DB_URL = process.env.DATABASE_URL_E2E ?? 'postgres://trendpilot:trendpilot@localhost:5433/trendpilot_e2e';
const PASSWORD = process.env.SEED_PASSWORD ?? 'TrendPilot-dev-only-1';
const CLOCK = '2026-11-08T09:30:03Z'; // the e2e web server's fixed signal clock (15:30 in Dhaka)
const T1 = '2026-11-08T09:31:00Z'; // replayed price that reaches only A's 3 % target
const env = { ...process.env, DATABASE_URL: DB_URL, SIGNAL_TEST_CLOCK: CLOCK, LIVE_ORDER_TRANSPORT: 'disabled' };
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const EMAIL = { a: 'investor.a@trendpilot.local', b: 'investor.b@trendpilot.local' };
const owner = (email: string) => `(SELECT id FROM users WHERE email = '${email}')`;

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
const num = (v: unknown) => Number(v);

async function signIn(page: Page, email: string) {
  await page.context().clearCookies(); // switch investors: a signed-in session would skip the form
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).not.toHaveURL(/sign-in/);
}

const positionIds: Record<'a' | 'b', string> = { a: '', b: '' };

test('prepare: same alert, two sizes (A 100 × 10, B 50 × 5); only A’s target fills', async ({ baseURL }) => {
  await sql(
    'TRUNCATE paper_funding, funding_rates, signal_decisions, jobs, signal_rejections, signal_events, position_targets, position_exits, sim_positions, ledger_entries, fills, positions, sim_fills, sim_orders, order_intents, paper_accounts, market_quotes, market_candles RESTART IDENTITY CASCADE'
  );
  run(['run', 'demo:paper', '--', '--at', CLOCK, '--profile', 'exits']);
  expect(run(['run', 'replay', '--', '--url', baseURL!])).toMatch(/→ 202 \{"status":"accepted"/);
  expect(run(['run', 'worker:once'])).toMatch(/entriesApproved=2/);
  // A's 3 % target: the first touch arms it, the pullback through it closes.
  const T0 = new Date(new Date(T1).getTime() - 5000).toISOString();
  run(['run', 'market:tick', '--', '--price', '67000', '--at', T0]);
  expect(run(['run', 'worker:once'], { SIGNAL_TEST_CLOCK: T0 })).toMatch(/takeProfitsRequested=0 .*targetsArmed=1/);
  run(['run', 'market:tick', '--', '--price', '66900', '--at', T1]);
  expect(run(['run', 'worker:once'], { SIGNAL_TEST_CLOCK: T1 })).toMatch(/position CLOSED exit=TAKE_PROFIT/);
  for (const k of ['a', 'b'] as const) positionIds[k] = (await sql<{ id: string }>(`SELECT id FROM positions WHERE owner_id = ${owner(EMAIL[k])}`))[0]!.id;
  const sizes = await sql<{ email: string; initial_contracts: string; status: string }>(
    'SELECT u.email, p.initial_contracts, p.status FROM positions p JOIN users u ON u.id = p.owner_id ORDER BY u.email'
  );
  expect(sizes.map((s) => [s.email, num(s.initial_contracts), s.status])).toEqual([
    [EMAIL.a, 153, 'CLOSED'],
    [EMAIL.b, 38, 'OPEN']
  ]);
});

for (const who of ['a', 'b'] as const) {
  test(`investor ${who.toUpperCase()}: dashboard totals equal their own fills and ledger`, async ({ page }) => {
    await signIn(page, EMAIL[who]);
    const api = await (await page.request.get('/v1/me/dashboard')).json();
    const [acct] = await sql<{ wallet_balance: string; position_margin: string; order_reserve: string }>(`SELECT * FROM paper_accounts WHERE owner_id = ${owner(EMAIL[who])}`);
    const [ex] = await sql<{ pnl: string; fee: string; n: string }>(
      `SELECT coalesce(sum(realized_pnl),0) pnl, coalesce(sum(fee),0) fee, count(*) n FROM position_exits WHERE owner_id = ${owner(EMAIL[who])}`
    );
    const [en] = await sql<{ fee: string }>(
      `SELECT coalesce(sum(f.fee),0) fee FROM fills f JOIN order_intents i ON i.id = f.intent_id WHERE f.owner_id = ${owner(EMAIL[who])} AND i.kind = 'OPEN'`
    );
    expect(api.mode).toBe('PAPER');
    expect(api.day).toMatchObject({ date: '2026-11-08', isToday: true });
    expect(num(api.account.walletUsdt)).toBe(num(acct!.wallet_balance));
    expect(num(api.account.usedMarginUsdt)).toBe(num(acct!.position_margin));
    expect(num(api.account.availableUsdt)).toBeCloseTo(num(acct!.wallet_balance) - num(acct!.position_margin) - num(acct!.order_reserve), 8);
    expect(num(api.daily.grossRealizedUsdt)).toBe(num(ex!.pnl));
    expect(num(api.daily.feesUsdt)).toBeCloseTo(num(ex!.fee) + num(en!.fee), 8);
    expect(api.daily.exitFills).toBe(Number(ex!.n));
    expect(api.daily.funding).toMatchObject({ status: 'NONE_DUE', amountUsdt: '0' });
    expect(api.reconciliation.ok).toBe(true);
    // Wallet change since the opening balance = today's net realized (all trading happened today).
    expect(num(api.account.walletUsdt) - num(api.reconciliation.lifetime.openingBalanceUsdt)).toBeCloseTo(num(api.daily.netRealizedUsdt), 8);

    await page.goto('/dashboard');
    await expect(page.getByRole('heading', { level: 2, name: 'Dashboard' })).toBeVisible();
    await expect(page.getByTestId('dashboard-status')).toContainText('Paper');
    await expect(page.getByTestId('reconciliation')).toHaveAttribute('data-ok', 'true');
    await expect(page.getByTestId('daily-funding')).toHaveAttribute('data-status', 'NONE_DUE');
    if (who === 'a') {
      expect(num(api.daily.grossRealizedUsdt)).toBeGreaterThan(0);
      expect(api.positions.open).toBe(0);
      await expect(page.getByTestId('daily-fills')).toContainText('1 entry · 1 exit (0 partial)');
      await expect(page.getByTestId('daily-gross')).toContainText('+');
    } else {
      expect(num(api.daily.grossRealizedUsdt)).toBe(0);
      expect(api.positions.open).toBe(1);
      expect(api.unrealized.status).toBe('OK');
      await expect(page.getByTestId('daily-fills')).toContainText('1 entry · 0 exit');
      await expect(page.getByTestId('price-freshness')).toHaveText('Prices fresh');
      await expect(page.getByTestId('unrealized')).not.toHaveText('Unavailable');
    }
  });
}

test('Holdings in My Account: B sees its own open position; A sees none', async ({ page }) => {
  await signIn(page, EMAIL.b);
  await page.goto('/my-account');
  const rows = page.getByTestId('holding');
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toHaveAttribute('data-symbol', 'BTCUSDT');
  await expect(rows.first().getByTestId('holding-remaining')).toContainText('38 of 38');
  await expect(rows.first().getByTestId('holding-stop')).toContainText('Covers 38');
  await expect(rows.first().getByTestId('holding-price')).toHaveAttribute('data-freshness', 'FRESH');
  await expect(rows.first().getByTestId('holding-liquidation')).toContainText('Estimated');
  await expect(page.getByTestId('holdings-freshness')).toContainText('Last price update');

  await signIn(page, EMAIL.a);
  await page.goto('/my-account');
  await expect(page.getByTestId('holding')).toHaveCount(0);
  await expect(page.getByText('No open paper positions.')).toBeVisible();
});

test("A's trade: fills, exit reason, fees, funding and the triggering signal", async ({ page }) => {
  await signIn(page, EMAIL.a);
  await page.goto(`/my-trades/${positionIds.a}`);
  await expect(page.getByTestId('exit-reason')).toHaveText('Take profit');
  await expect(page.getByTestId('exit')).toHaveCount(1);
  await expect(page.getByTestId('funding-total')).toHaveText('None booked');
  await expect(page.getByTestId('trade-signal')).toContainText('bullish flip');
  await expect(page.getByTestId('market-source')).toContainText('Fixture');
});

test("neither investor can read the other's trade, holdings or signal decisions", async ({ page }) => {
  await signIn(page, EMAIL.a);
  expect((await page.request.get(`/v1/me/trades/${positionIds.b}`)).status()).toBe(404);
  expect((await page.request.get(`/v1/me/trades/${positionIds.a}`)).status()).toBe(200);
  const res = await page.goto(`/my-trades/${positionIds.b}`);
  expect(res?.status()).toBe(404);
  const holdingsA = await (await page.request.get('/v1/me/holdings')).json();
  expect(holdingsA.positions).toEqual([]);
  const sigA = (await (await page.request.get('/v1/me/signals')).json()).items;
  const blocksA = (await sql<{ id: string }>(`SELECT id FROM order_blocks WHERE owner_id = ${owner(EMAIL.a)}`)).map((r) => r.id);
  expect(sigA.length).toBeGreaterThan(0);
  expect(sigA.every((o: { orderBlockId: string }) => blocksA.includes(o.orderBlockId))).toBe(true);

  await signIn(page, EMAIL.b);
  expect((await page.request.get(`/v1/me/trades/${positionIds.a}`)).status()).toBe(404);
  expect((await page.request.post(`/v1/me/positions/${positionIds.a}/close`, { headers: { 'idempotency-key': 'e2e-cross-owner' } })).status()).toBe(404);
  const dashB = await (await page.request.get(`/v1/me/dashboard?ownerId=${positionIds.a}`)).json();
  expect(dashB.positions.open).toBe(1); // still B's own data
  await page.goto('/signals');
  const sigB = (await (await page.request.get('/v1/me/signals')).json()).items;
  await expect(page.getByTestId('signal-outcome')).toHaveCount(sigB.length);
  expect(await sql(`SELECT 1 FROM positions WHERE id = '${positionIds.a}' AND status = 'CLOSED'`)).toHaveLength(1);
});
