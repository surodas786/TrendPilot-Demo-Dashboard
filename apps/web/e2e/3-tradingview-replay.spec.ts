// M2 slice 1 end to end: the replay command posts the exact SRS payload to the running app,
// the real worker routes it, and each investor sees only their own outcome.
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import pg from 'pg';

test.describe.configure({ mode: 'serial' });

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const DB_URL = process.env.DATABASE_URL_E2E ?? 'postgres://trendpilot:trendpilot@localhost:5433/trendpilot_e2e';
const PASSWORD = process.env.SEED_PASSWORD ?? 'TrendPilot-dev-only-1';
// Must match SIGNAL_TEST_CLOCK in playwright.config.ts: Sunday 15:30:03 in Asia/Dhaka.
const CLOCK = '2026-11-08T09:30:03Z';
const env = { ...process.env, DATABASE_URL: DB_URL, SIGNAL_TEST_CLOCK: CLOCK, LIVE_ORDER_TRANSPORT: 'disabled' };

async function sql<T = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> {
  const c = new pg.Client({ connectionString: DB_URL });
  await c.connect();
  try {
    return (await c.query(text, params)).rows as T[];
  } finally {
    await c.end();
  }
}

const run = (args: string[]) => execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, { cwd: ROOT, env, encoding: 'utf8', shell: process.platform === 'win32' });

async function api(request: APIRequestContext, email: string) {
  const r = await request.post('/v1/auth/login', { data: { email, password: PASSWORD } });
  expect(r.status()).toBe(200);
}

async function signIn(page: Page, email: string) {
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).not.toHaveURL(/sign-in/);
}

test('setup: Investor A active on BTCUSDT every day, Investor B paused', async ({ playwright, baseURL }) => {
  const a = await playwright.request.newContext({ baseURL });
  await api(a, 'investor.a@trendpilot.local');
  let [blk] = (await (await a.get('/v1/me/order-blocks')).json()).items.filter((x: { symbol: string }) => x.symbol === 'BTCUSDT');
  const patched = await a.patch(`/v1/me/order-blocks/${blk.id}`, {
    headers: { 'if-match': `"${blk.revision}"` },
    data: { weekdays: ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'], direction: 'BOTH' }
  });
  expect(patched.status()).toBe(200);
  blk = await patched.json();
  if (blk.status !== 'ACTIVE') expect((await a.post(`/v1/me/order-blocks/${blk.id}/resume`, { headers: { 'if-match': `"${blk.revision}"` } })).status()).toBe(200);

  const b = await playwright.request.newContext({ baseURL });
  await api(b, 'investor.b@trendpilot.local');
  const [bBlk] = (await (await b.get('/v1/me/order-blocks')).json()).items.filter((x: { symbol: string }) => x.symbol === 'BTCUSDT');
  if (bBlk.status !== 'PAUSED') expect((await b.post(`/v1/me/order-blocks/${bBlk.id}/pause`, { headers: { 'if-match': `"${bBlk.revision}"` } })).status()).toBe(200);
  await a.dispose();
  await b.dispose();
});

test('replay: the exact SRS payload is accepted once, the duplicate returns 200', async ({ baseURL }) => {
  const out = run(['run', 'replay', '--', '--url', baseURL!, '--repeat', '2']);
  expect(out).toContain('"action": "BULLISH_FLIP"');
  expect(out).toContain('"source_symbol": "BTCUSDT.P"');
  expect(out).toContain('"bar_open_utc": "2026-11-08T09:15:00Z"');
  expect(out).toMatch(/#1 POST .*\(redacted\)\n→ 202 \{"status":"accepted"/);
  expect(out).toMatch(/#2 POST .*\(redacted\)\n→ 200 \{"status":"duplicate"/);
  expect(out).not.toContain(process.env.DEV_INGRESS_TOKEN ?? 'tvw_dev_only_local_fixture_token_not_for_production_0001');
  const events = await sql<{ id: string; status: string }>("SELECT id, status FROM signal_events WHERE stream_key = 'MEXC|BTCUSDT.P|15'");
  expect(events).toHaveLength(1);
  expect(await sql('SELECT 1 FROM jobs')).toHaveLength(1);
});

test('worker: one outcome per investor, and a retried job adds none', async () => {
  const first = run(['run', 'worker:once']);
  expect(first).toMatch(/evaluated=2 new=2 ready=1 skipped=1/);
  await sql("UPDATE jobs SET status = 'PENDING', claim_token = NULL, run_after = '2000-01-01'");
  const retry = run(['run', 'worker:once']);
  expect(retry).toMatch(/evaluated=2 new=0/);
  expect(run(['run', 'worker:once'])).toMatch(/no runnable jobs/);
  const rows = await sql<{ email: string; status: string; reason: string | null }>(
    "SELECT u.email, d.status, d.reason FROM signal_decisions d JOIN users u ON u.id = d.owner_id WHERE d.step = 'ENTRY_SCREEN_V1' ORDER BY u.email"
  );
  expect(rows).toEqual([
    { email: 'investor.a@trendpilot.local', status: 'READY_FOR_EVALUATION', reason: null },
    { email: 'investor.b@trendpilot.local', status: 'SKIPPED', reason: 'PAUSED' }
  ]);
});

test('each investor sees only their own outcome, in the UI and through the API', async ({ browser }) => {
  const [bDecision] = await sql<{ id: string }>("SELECT d.id FROM signal_decisions d JOIN users u ON u.id = d.owner_id WHERE u.email = 'investor.b@trendpilot.local' AND d.step = 'ENTRY_SCREEN_V1'");

  const pageA = await (await browser.newContext()).newPage();
  await signIn(pageA, 'investor.a@trendpilot.local');
  await pageA.getByRole('link', { name: 'Signals' }).click();
  const rowsA = pageA.getByTestId('signal-outcome');
  await expect(rowsA).toHaveCount(1);
  await expect(rowsA.first()).toHaveAttribute('data-status', 'READY_FOR_EVALUATION');
  // No market fixtures in this spec: A passes routing but the entry check finds no fresh quote.
  await expect(rowsA.first()).toContainText('Entry skipped · FEED_STALE');
  await expect(pageA.getByText('PAUSED')).toHaveCount(0);
  expect((await pageA.request.get(`/v1/me/signals/${bDecision!.id}`)).status()).toBe(404);

  const pageB = await (await browser.newContext()).newPage();
  await signIn(pageB, 'investor.b@trendpilot.local');
  await pageB.goto('/signals');
  const rowsB = pageB.getByTestId('signal-outcome');
  await expect(rowsB).toHaveCount(1);
  await expect(rowsB.first()).toHaveAttribute('data-reason', 'PAUSED');
  await expect(rowsB.first()).toContainText('This order block is paused.');
});

test('operations view shows counts only, never investors', async ({ browser }) => {
  const admin = await (await browser.newContext()).newPage();
  await signIn(admin, 'admin@trendpilot.local');
  await admin.getByRole('link', { name: 'TradingView Webhook & Routes' }).click();
  const ev = admin.getByTestId('ops-event').first();
  await expect(ev).toContainText('BULLISH_FLIP · MEXC:BTCUSDT.P · 15m');
  await expect(ev).toContainText('READY_FOR_EVALUATION ×1');
  await expect(ev).toContainText('SKIPPED:PAUSED ×1');
  await expect(admin.getByText('investor.a@trendpilot.local')).toHaveCount(0);
  // Only a short hint of the token is ever shown; never the token or its 12-char lookup prefix.
  const html = await admin.content();
  expect(html).not.toContain(process.env.DEV_INGRESS_TOKEN ?? 'tvw_dev_only_local_fixture_token_not_for_production_0001');
  expect(html).not.toContain('tvw_dev_only');
  await expect(admin.getByText('tvw_dev_…', { exact: false })).toBeVisible();
});
