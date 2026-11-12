// Live ships switched off. The investor sees their Live Trading page with nothing connected and
// the reason Live entries are not possible; Trade Settings offers Live only after a verified MEXC
// connection; Holdings, My Trades and Dashboard show Paper and Live separately. The admin Live
// Trading page shows the deployment transport disabled, the platform switch Off (and not
// switchable before the order capabilities are recorded) and the contract allowlist.
import { expect, test, type Page } from '@playwright/test';
import pg from 'pg';

test.describe.configure({ mode: 'serial' });

const DB_URL = process.env.DATABASE_URL_E2E ?? 'postgres://trendpilot:trendpilot@localhost:5433/trendpilot_e2e';
const PASSWORD = process.env.SEED_PASSWORD ?? 'TrendPilot-dev-only-1';
const ADMIN = 'admin@trendpilot.local';
const INVESTOR = 'investor.a@trendpilot.local';

async function sql(text: string): Promise<void> {
  const c = new pg.Client({ connectionString: DB_URL });
  await c.connect();
  try {
    await c.query(text);
  } finally {
    await c.end();
  }
}

async function signIn(page: Page, email: string) {
  await page.context().clearCookies();
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).not.toHaveURL(/sign-in/);
}

test('investor: Live Trading page, Off by default, nothing connected', async ({ page }) => {
  await sql(`DELETE FROM exchange_connections; UPDATE live_control SET live_enabled = false, entries_halted = false WHERE id = 1`);
  await signIn(page, INVESTOR);
  await page.getByRole('navigation').getByRole('link', { name: 'Live Trading' }).click();
  await expect(page).toHaveURL(/\/live-trading$/);
  const status = page.getByTestId('live-status');
  await expect(status).toContainText('Live order submission (deployment)');
  await expect(status).toContainText('Not connected');
  await expect(page.getByTestId('live-entries')).toContainText('not possible');
  await expect(page.getByLabel('API key')).toBeVisible();
  await expect(page.getByLabel('Secret key')).toHaveAttribute('type', 'password');
  await expect(page.getByRole('button', { name: 'Save and check' })).toBeDisabled();
});

test('investor: Paper and Live reported separately', async ({ page }) => {
  await signIn(page, INVESTOR);
  for (const path of ['/my-holdings', '/my-trades', '/dashboard']) {
    await page.goto(path);
    const tabs = page.getByTestId('mode-tabs');
    await expect(tabs.getByRole('link', { name: 'Paper' })).toHaveAttribute('aria-current', 'page');
    await tabs.getByRole('link', { name: 'Live' }).click();
    await expect(page).toHaveURL(/mode=live/);
    await expect(page.getByTestId('mode-tabs').getByRole('link', { name: 'Live' })).toHaveAttribute('aria-current', 'page');
  }
  await page.goto('/my-trades?mode=live');
  await expect(page.getByText('No open Live positions')).toBeVisible();
});

test('admin: Live Trading page with the switch Off and not switchable before capability evidence', async ({ page }) => {
  // Earlier specs may have enrolled the admin in MFA; this spec checks the Live page only.
  await sql(`UPDATE users SET mfa_secret_enc = NULL, mfa_pending_secret_enc = NULL, mfa_enabled_at = NULL, mfa_last_step = NULL WHERE email = '${ADMIN}'`);
  await sql(`UPDATE live_control SET capability_evidence = '{}'::jsonb WHERE id = 1`);
  await signIn(page, ADMIN);
  await page.goto('/admin/live');
  const platform = page.getByTestId('live-platform');
  await expect(platform).toContainText('Disabled (LIVE_ORDER_TRANSPORT)');
  await expect(platform).toContainText('Off');
  await expect(platform.getByRole('button', { name: 'Switch Live on' })).toBeDisabled();
  await expect(page.getByTestId('live-capabilities')).toContainText('OPEN_WITH_ATTACHED_STOP');
  await expect(page.getByTestId('live-connections')).toContainText('No investor has connected');
  await expect(page.getByTestId('live-contracts')).toContainText('Paper only');
});
