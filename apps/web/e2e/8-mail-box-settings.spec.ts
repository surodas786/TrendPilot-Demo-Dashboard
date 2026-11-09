// Admin → Settings → Mail Box: reachable from the admin menu, saves and reloads settings with a
// write-only password, and is not reachable by investors. No email is sent (capture mode; the
// test-send button is not pressed here; mocked SMTP sends are covered in test/api/mailBox.test.ts).
import { expect, test, type Page } from '@playwright/test';

test.describe.configure({ mode: 'serial' });

const PASSWORD = process.env.SEED_PASSWORD ?? 'TrendPilot-dev-only-1';
const SMTP_PASSWORD = 'e2e-app-password-Q7x';

async function signIn(page: Page, email: string) {
  await page.context().clearCookies();
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).not.toHaveURL(/sign-in/);
}

test('admin opens Settings → Mail Box from the menu, saves, and the password stays write-only', async ({ page }) => {
  await signIn(page, 'admin@trendpilot.local');
  const nav = page.getByRole('navigation', { name: 'Main' });
  await nav.getByRole('button', { name: 'Settings' }).click();
  await nav.getByRole('link', { name: 'Mail Box' }).click();
  await expect(page).toHaveURL(/\/admin\/settings\/mail-box$/);
  await expect(page.getByRole('heading', { name: 'Mail Box', level: 2 })).toBeVisible();
  await expect(page.getByTestId('mail-mode')).toContainText('Capture mode');
  await expect(page.getByTestId('mail-password-state')).toContainText('No password stored');
  await expect(page.getByRole('button', { name: 'Send Test Email' })).toBeDisabled();

  await page.getByLabel('SMTP host').fill('smtp.e2e.example');
  await page.getByLabel('Username').fill('mailer@e2e.example');
  await page.getByLabel('Password or app password').fill(SMTP_PASSWORD);
  await page.getByLabel('Sender email').fill('no-reply@e2e.example');
  await page.getByRole('button', { name: 'Save Settings' }).click();
  await expect(page.getByText('Mail settings saved')).toBeVisible();
  await expect(page.getByTestId('mail-password-state')).toContainText('Password configured');

  await page.reload();
  await expect(page.getByLabel('SMTP host')).toHaveValue('smtp.e2e.example');
  await expect(page.getByLabel('Password or app password')).toHaveValue('');
  await expect(page.getByTestId('mail-password-state')).toContainText('Password configured');
  expect(await page.content()).not.toContain(SMTP_PASSWORD);
  await expect(page.getByRole('button', { name: 'Send Test Email' })).toBeEnabled();

  // /admin/settings opens the Mail Box.
  await page.goto('/admin/settings');
  await expect(page).toHaveURL(/\/admin\/settings\/mail-box$/);
});

test('investors cannot open the Mail Box page or its API', async ({ page }) => {
  await signIn(page, 'investor.a@trendpilot.local');
  await page.goto('/admin/settings/mail-box');
  await expect(page).not.toHaveURL(/\/admin/);
  const r = await page.request.get('/v1/admin/settings/mail');
  expect(r.status()).toBe(403);
});
