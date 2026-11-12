// UI-02, UI-03, AT-01, AT-05: two investors save different settings for the same token
// through the real UI; My Account is fixed to the signed-in investor.
import { expect, test, type Page } from '@playwright/test';

const PASSWORD = process.env.SEED_PASSWORD ?? 'TrendPilot-dev-only-1';
const A = { email: 'investor.a@trendpilot.local', name: 'Nadia Rahman' };
const B = { email: 'investor.b@trendpilot.local', name: 'Omar Siddiqui' };
// Later tests build on the blocks created by earlier ones.
test.describe.configure({ mode: 'serial' });

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

async function signIn(page: Page, email: string) {
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/trade-settings$/);
}

async function expectNoAccountSwitcher(page: Page) {
  await expect(page.getByTestId('account-scope').first()).toBeVisible();
  await expect(page.getByText(/all my accounts/i)).toHaveCount(0);
  await expect(page.getByText(/trading account/i)).toHaveCount(0);
  await expect(page.getByRole('combobox', { name: /account/i })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /switch account|select account/i })).toHaveCount(0);
}

test('two investors keep private, different settings for BTC/USDT', async ({ browser }) => {
  // ── Investor A ─────────────────────────────────────────────
  const ctxA = await browser.newContext();
  const pageA = await ctxA.newPage();
  await signIn(pageA, A.email);

  await expect(pageA.getByTestId('account-scope').first()).toHaveText(`My Account · ${A.name}`);
  await expectNoAccountSwitcher(pageA);
  await expect(pageA.getByText('No order blocks yet')).toBeVisible();

  await pageA.getByRole('button', { name: 'Add Token' }).click();
  const panelA = pageA.getByRole('dialog');
  await expect(panelA.getByLabel('Trading pair')).toHaveValue(/.+/);
  await expect(panelA.getByLabel('Trading pair').locator('option:checked')).toHaveText('BTC/USDT');
  await expect(panelA.getByRole('radio', { name: 'Live — unavailable' })).toBeDisabled();

  // All seven weekday controls, Sunday first, all selected by default.
  const chips = panelA.getByRole('checkbox');
  await expect(chips).toHaveText(DAYS);
  for (const day of DAYS) await expect(panelA.getByRole('checkbox', { name: day })).toHaveAttribute('aria-checked', 'true');
  await expect(panelA.getByText('Timezone: Asia/Dhaka', { exact: true })).toBeVisible();

  // Keyboard: Space toggles Sunday, Tab walks the chips to Saturday.
  await panelA.getByRole('checkbox', { name: 'Sunday' }).focus();
  await pageA.keyboard.press('Space');
  for (let i = 0; i < 6; i++) await pageA.keyboard.press('Tab');
  await expect(panelA.getByRole('checkbox', { name: 'Saturday' })).toBeFocused();
  await pageA.keyboard.press('Space');
  await expect(panelA.getByRole('checkbox', { name: 'Sunday' })).toHaveAttribute('aria-checked', 'false');
  await expect(panelA.getByRole('checkbox', { name: 'Saturday' })).toHaveAttribute('aria-checked', 'false');

  await panelA.getByLabel('Order cost (USDT)').fill('120');
  await panelA.getByLabel('Leverage').selectOption('10');
  await panelA.getByRole('button', { name: 'Save', exact: true }).click();

  const rowA = pageA.getByTestId('order-block-BTCUSDT');
  await expect(rowA).toBeVisible();
  await expect(rowA.getByTestId('trading-days')).toHaveText('Trading days: Mon–Fri · Window: All day · Asia/Dhaka');
  await expect(rowA.getByTestId('order-cost')).toHaveText('120.00 USDT');
  await expect(rowA.getByText('Paused')).toBeVisible();

  // ── Investor B, separate browser context ─────────────────
  const ctxB = await browser.newContext();
  const pageB = await ctxB.newPage();
  await signIn(pageB, B.email);
  await expect(pageB.getByTestId('account-scope').first()).toHaveText(`My Account · ${B.name}`);
  await expectNoAccountSwitcher(pageB);
  await expect(pageB.getByText('No order blocks yet')).toBeVisible();

  await pageB.getByRole('button', { name: 'Add Token' }).click();
  const panelB = pageB.getByRole('dialog');
  await expect(panelB.getByLabel('Trading pair').locator('option:checked')).toHaveText('BTC/USDT');
  for (const day of ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday']) await panelB.getByRole('checkbox', { name: day }).click();
  await panelB.getByLabel('Order cost (USDT)').fill('35');
  await panelB.getByLabel('Leverage').selectOption('3');
  await panelB.getByRole('radio', { name: 'Long only' }).click();
  await panelB.getByLabel('Stop loss').fill('3');
  await panelB.getByRole('button', { name: 'Save & Activate' }).click();

  const rowB = pageB.getByTestId('order-block-BTCUSDT');
  await expect(rowB.getByTestId('trading-days')).toHaveText('Trading days: Sat–Sun · Window: All day · Asia/Dhaka');
  await expect(rowB.getByTestId('order-cost')).toHaveText('35.00 USDT');
  await expect(rowB.getByText('Active — waiting for signal')).toBeVisible();
  await expect(rowB.getByText('Long only')).toBeVisible();
  await expect(rowA.getByText('Long and Short')).toBeVisible();

  // ── A still sees only A's values ───────────────────────────
  await pageA.reload();
  await expect(pageA.getByTestId('order-block-BTCUSDT')).toHaveCount(1);
  await expect(rowA.getByTestId('order-cost')).toHaveText('120.00 USDT');
  await expect(rowA.getByTestId('trading-days')).toHaveText('Trading days: Mon–Fri · Window: All day · Asia/Dhaka');
  await expect(pageA.getByText('35.00 USDT')).toHaveCount(0);

  // ── Direct API requests with A's session cannot reach B's block ──
  const listB = await pageB.request.get('/v1/me/order-blocks');
  const bBlock = (await listB.json()).items[0];
  const getAsA = await pageA.request.get(`/v1/me/order-blocks/${bBlock.id}`);
  expect(getAsA.status()).toBe(404);
  const patchAsA = await pageA.request.patch(`/v1/me/order-blocks/${bBlock.id}`, {
    headers: { 'if-match': `"${bBlock.revision}"` },
    data: { orderCostUsdt: '1', weekdays: [] }
  });
  expect(patchAsA.status()).toBe(404);
  const pauseAsA = await pageA.request.post(`/v1/me/order-blocks/${bBlock.id}/pause`, { headers: { 'if-match': `"${bBlock.revision}"` } });
  expect(pauseAsA.status()).toBe(404);
  const listA = await (await pageA.request.get('/v1/me/order-blocks')).json();
  expect(listA.items.map((x: { id: string }) => x.id)).not.toContain(bBlock.id);

  // B's block is unchanged.
  await pageB.reload();
  await expect(rowB.getByTestId('order-cost')).toHaveText('35.00 USDT');
  await expect(rowB.getByText('Active — waiting for signal')).toBeVisible();

  await ctxA.close();
  await ctxB.close();
});

test('editing all seven days and pausing persists across reloads', async ({ page }) => {
  await signIn(page, A.email);
  const row = page.getByTestId('order-block-BTCUSDT');
  await row.getByRole('button', { name: /^Edit/ }).click();
  const panel = page.getByRole('dialog');
  // Select every day again, then clear them all: an empty set is allowed and blocks entries.
  for (const day of ['Sunday', 'Saturday']) await panel.getByRole('checkbox', { name: day }).click();
  for (const day of DAYS) await expect(panel.getByRole('checkbox', { name: day })).toHaveAttribute('aria-checked', 'true');
  for (const day of DAYS) await panel.getByRole('checkbox', { name: day }).click();
  await expect(panel.getByText('No days selected — this block will not open new trades.')).toBeVisible();
  await panel.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(row.getByTestId('trading-days')).toHaveText('Trading days: No days — entries blocked · Window: All day · Asia/Dhaka');

  await row.getByRole('button', { name: /^Resume/ }).click();
  await expect(row.getByText('Active — waiting for signal')).toBeVisible();
  await page.reload();
  await expect(row.getByText('Active — waiting for signal')).toBeVisible();
  await row.getByRole('button', { name: /^Pause/ }).click();
  await expect(row.getByText('Paused')).toBeVisible();
});

test('My Account shows only the signed-in investor; settings reload after signing in again', async ({ page }) => {
  await signIn(page, B.email);
  await page.getByRole('link', { name: 'My Account', exact: true }).click();
  await expect(page).toHaveURL(/\/my-account$/);
  await expect(page.getByTestId('profile-name')).toHaveText(B.name);
  await expect(page.getByTestId('profile-email')).toHaveText(B.email);
  await expect(page.getByTestId('profile-timezone')).toHaveText('Asia/Dhaka');
  await expect(page.getByText(A.email)).toHaveCount(0);
  await expect(page.getByText(A.name)).toHaveCount(0);
  await expectNoAccountSwitcher(page);

  await page.getByRole('banner').getByRole('button', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/sign-in$/);
  await page.goto('/my-account');
  await expect(page).toHaveURL(/\/sign-in$/);

  // Signing in again reloads B's persisted settings from PostgreSQL.
  await signIn(page, B.email);
  const row = page.getByTestId('order-block-BTCUSDT');
  await expect(row.getByTestId('order-cost')).toHaveText('35.00 USDT');
  await expect(row.getByTestId('trading-days')).toHaveText('Trading days: Sat–Sun · Window: All day · Asia/Dhaka');
  await expect(row.getByText('Active — waiting for signal')).toBeVisible();
  await row.getByRole('button', { name: /^Edit/ }).click();
  const panel = page.getByRole('dialog');
  await expect(panel.getByLabel('Order cost (USDT)')).toHaveValue('35');
  await expect(panel.getByLabel('Leverage')).toHaveValue('3');
  await expect(panel.getByLabel('Stop loss')).toHaveValue('3');
  await expect(panel.getByRole('radio', { name: 'Long only' })).toHaveAttribute('aria-checked', 'true');
  for (const day of DAYS) {
    await expect(panel.getByRole('checkbox', { name: day })).toHaveAttribute('aria-checked', day === 'Sunday' || day === 'Saturday' ? 'true' : 'false');
  }
});

test('signed-out visitors are sent to sign-in; admins land on the admin screen', async ({ page }) => {
  await page.goto('/trade-settings');
  await expect(page).toHaveURL(/\/sign-in$/);
  await page.getByLabel('Email').fill('admin@trendpilot.local');
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/admin$/);
  await expect(page.getByRole('cell', { name: 'investor.a@trendpilot.local' })).toBeVisible();
  await page.goto('/trade-settings');
  await expect(page).toHaveURL(/\/admin$/);
  await page.getByRole('banner').getByRole('button', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/sign-in$/);
});
