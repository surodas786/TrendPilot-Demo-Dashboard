// Per-side Take Profit in Trade Settings (runs last: it saves A's BTC Paper block).
// Long and Short sections are independent; only the applicable section shows for a one-sided
// direction and the other side's saved values survive; Backspace keeps the editor open with an
// inline message on Save; the order preview shows each side's own targets (Long above entry,
// Short below) sharing the quantity left after Trailing Take Profit.
import { expect, test, type Page } from '@playwright/test';

const PASSWORD = process.env.SEED_PASSWORD ?? 'TrendPilot-dev-only-1';

async function signIn(page: Page, email: string) {
  await page.context().clearCookies();
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).not.toHaveURL(/sign-in/);
}

test('independent Long and Short Take Profit: edit, direction change, Backspace, preview, save', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await signIn(page, 'investor.a@trendpilot.local');
  await page.goto('/trade-settings');
  await page.getByRole('button', { name: 'Edit BTC/USDT Paper' }).click();
  const panel = page.getByRole('dialog');
  const long = panel.getByTestId('tp-LONG');
  const short = panel.getByTestId('tp-SHORT');

  await panel.getByRole('radio', { name: 'Long and Short' }).click();
  await expect(long).toBeVisible();
  await expect(short).toBeVisible();

  // Long: Fixed +2 %. Short: Split −1 % / −2 %, 50/50 of the Take Profit share.
  await long.getByRole('radio', { name: 'Fixed' }).click();
  await long.getByLabel('Long target — price move').fill('2');
  await short.getByRole('radio', { name: 'Split' }).click();
  await short.getByLabel('Short target 1 — move').fill('1');
  await short.getByLabel('Short target 2 — move').fill('2');
  await expect(short.getByTestId('split-shares')).toContainText('Shares 100% of 100%');

  // 40 % to Trailing Take Profit: each side's Take Profit manages the other 60 %.
  const trailing = panel.getByTestId('trailing-take-profit');
  if (!(await trailing.getByLabel('Position to close (%)').isVisible())) await trailing.getByRole('switch', { name: /Trailing take profit/ }).click();
  await trailing.getByLabel('Position to close (%)').fill('40');
  await trailing.getByLabel('Activate after profit (%)').fill('5');
  await trailing.getByLabel('Trail distance (%)').fill('1');
  await expect(long.getByTestId('exit-allocation')).toContainText('Take profit 60% · Trailing take profit 40%');
  await expect(short.getByTestId('exit-allocation')).toContainText('Take profit 60% · Trailing take profit 40%');

  // Long only: just the Long section; back to both: the Short split is still there.
  await panel.getByRole('radio', { name: 'Long only' }).click();
  await expect(long).toBeVisible();
  await expect(short).toHaveCount(0);
  await panel.getByRole('radio', { name: 'Long and Short' }).click();
  await expect(panel.getByTestId('tp-SHORT').getByLabel('Short target 2 — move')).toHaveValue('2');

  // Backspace clears a Short target; the editor stays open and Save shows the message inline.
  const s2 = panel.getByTestId('tp-SHORT').getByLabel('Short target 2 — move');
  await s2.click();
  await s2.press('End');
  await s2.press('Backspace');
  await expect(s2).toHaveValue('');
  await expect(panel).toBeVisible();
  await panel.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(panel.getByText('Fix the highlighted fields before saving.')).toBeVisible();
  await s2.fill('2');

  // Preview: each side with its own plan and targets.
  await panel.getByRole('button', { name: 'Preview order' }).click();
  const preview = panel.getByTestId('order-preview');
  await expect(preview.getByTestId('preview-LONG-tp')).toHaveText('Fixed · manages 60%');
  await expect(preview.getByTestId('preview-SHORT-tp')).toHaveText('Split · manages 60%');
  await expect(preview.getByTestId('preview-LONG-target')).toHaveCount(1);
  await expect(preview.getByTestId('preview-SHORT-target')).toHaveCount(2);
  await expect(preview.getByText(/Target 1 \(100% of TP, above entry\)/)).toBeVisible();
  await expect(preview.getByText(/Target 2 \(50% of TP, below entry\)/)).toBeVisible();

  await panel.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(panel).toHaveCount(0);

  // Reopen: both sides were saved independently.
  await page.getByRole('button', { name: 'Edit BTC/USDT Paper' }).click();
  const again = page.getByRole('dialog');
  await expect(again.getByTestId('tp-LONG').getByRole('radio', { name: 'Fixed' })).toHaveAttribute('aria-checked', 'true');
  await expect(again.getByTestId('tp-LONG').getByLabel('Long target — price move')).toHaveValue('2');
  await expect(again.getByTestId('tp-SHORT').getByRole('radio', { name: 'Split' })).toHaveAttribute('aria-checked', 'true');
  await expect(again.getByTestId('tp-SHORT').getByLabel('Short target 1 — move')).toHaveValue('1');
  await again.getByRole('button', { name: 'Cancel' }).click();
  expect(errors).toEqual([]);
});
