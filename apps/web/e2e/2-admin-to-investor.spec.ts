// End-to-end M1 flow: admin invitation → pair and strategy publishing → investor activation,
// MFA, Trade Settings with preview → isolation and admin-action denial → version pinning →
// pause/resume persistence across sign-in → stale-tab protection → audit history → suspension.
import { createHmac } from 'node:crypto';
import { expect, test, type Browser, type Page } from '@playwright/test';
import pg from 'pg';

test.describe.configure({ mode: 'serial' });

const DB_URL = process.env.DATABASE_URL_E2E ?? 'postgres://trendpilot:trendpilot@localhost:5433/trendpilot_e2e';
const SEED_PASSWORD = process.env.SEED_PASSWORD ?? 'TrendPilot-dev-only-1';
const ADMIN = 'admin@trendpilot.local';
const C = { name: 'Chloe Rahim', email: 'chloe@trendpilot.local', password: 'Chloe-e2e-password-1' };
const PKG = 'E2E Momentum';

async function sql<T = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> {
  const client = new pg.Client({ connectionString: DB_URL });
  await client.connect();
  try {
    return (await client.query(text, params)).rows as T[];
  } finally {
    await client.end();
  }
}

/** Reads the newest captured email (the local mailbox table) — no real email is sent. */
async function latestToken(to: string, template: 'INVITE' | 'RESET'): Promise<string> {
  const rows = await sql<{ body_text: string }>('SELECT body_text FROM email_outbox WHERE to_email = $1 AND template = $2 ORDER BY created_at DESC LIMIT 1', [to, template]);
  const m = /#token=([A-Za-z0-9_-]+)/.exec(rows[0]?.body_text ?? '');
  if (!m) throw new Error(`no ${template} email for ${to}`);
  return m[1]!;
}

/** RFC 6238 TOTP for a given 30-second step, computed independently of the app code. */
function totpAt(secret: string, step: number): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const ch of secret.replace(/=+$/, '')) bits += alphabet.indexOf(ch).toString(2).padStart(5, '0');
  const key = Buffer.from(bits.match(/.{8}/g)!.map((b) => parseInt(b, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = createHmac('sha1', key).update(counter).digest();
  const o = mac[mac.length - 1]! & 15;
  return ((mac.readUInt32BE(o) & 0x7fffffff) % 1_000_000).toString().padStart(6, '0');
}

const nowStep = () => Math.floor(Date.now() / 30000);
/** The app rejects reused steps (replay protection), so each code must use a newer step. */
let lastStep = -1;
async function freshCode(page: Page, secret: string): Promise<string> {
  for (;;) {
    const step = Math.max(nowStep() - 1, lastStep + 1);
    if (step <= nowStep() + 1) {
      lastStep = step;
      return totpAt(secret, step);
    }
    await page.waitForTimeout(2000);
  }
}

async function signIn(page: Page, email: string, password: string, mfaSecret?: string) {
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  if (mfaSecret) {
    await page.getByLabel('Authentication code').fill(await freshCode(page, mfaSecret));
    await page.getByRole('button', { name: 'Verify' }).click();
  }
  await expect(page).not.toHaveURL(/sign-in/);
}

async function signOut(page: Page) {
  await page.getByRole('banner').getByRole('button', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/sign-in$/);
}

let browser: Browser;
let admin: Page;
let chloe: Page;
let mfaSecret: string;

test.beforeAll(async ({ browser: b }) => {
  browser = b;
  admin = await (await browser.newContext()).newPage();
  await signIn(admin, ADMIN, SEED_PASSWORD);
});

test('admin invites an investor (captured locally)', async () => {
  await expect(admin).toHaveURL(/\/admin$/);
  await admin.getByLabel('Full name').fill(C.name);
  await admin.getByLabel('Email').fill(C.email);
  await admin.getByRole('button', { name: 'Send invitation' }).click();
  const row = admin.getByTestId(`user-row-${C.email}`);
  await expect(row).toBeVisible();
  await expect(row.getByText('Invited')).toBeVisible();
  // Only the hash is stored; the link lives in the captured email.
  const tokens = await sql<{ token_hash: string; expires_at: Date }>("SELECT token_hash, expires_at FROM user_tokens t JOIN users u ON u.id = t.user_id WHERE u.email = $1 AND t.kind = 'INVITE'", [C.email]);
  expect(tokens).toHaveLength(1);
  expect(tokens[0]!.token_hash).toMatch(/^[0-9a-f]{64}$/);
});

test('admin validates ETHUSDT against the fixture contracts and publishes it', async () => {
  await admin.getByRole('link', { name: 'Trading Pairs & Defaults' }).click();
  await admin.getByLabel('MEXC Futures ticker').fill('NOTAREALUSDT');
  await admin.getByRole('button', { name: 'Validate' }).click();
  await expect(admin.getByText(/not in the local MEXC contract fixtures/)).toBeVisible();
  await admin.getByLabel('MEXC Futures ticker').fill('ETHUSDT');
  await admin.getByRole('button', { name: 'Validate' }).click();
  const card = admin.getByTestId('validated-contract');
  await expect(card.getByText(/Local MEXC contract fixture/)).toBeVisible();
  await card.getByLabel('Suggested stop').fill('2');
  await card.getByRole('button', { name: 'Publish pair' }).click();
  const row = admin.getByTestId('pair-row-ETHUSDT');
  await expect(row.getByText('Published')).toBeVisible();
  await expect(row.getByText('Fixture contract')).toBeVisible();
});

test('admin creates a package and publishes v1 (5m, EMA 200, close and reverse) for ETH/USDT', async () => {
  await admin.getByRole('link', { name: 'Strategy Packages' }).click();
  await admin.getByLabel('New strategy package').fill(PKG);
  await admin.getByRole('button', { name: 'Create package' }).click();
  const pkg = admin.getByTestId(`package-${PKG}`);
  await pkg.getByRole('button', { name: 'New version' }).click();
  await pkg.getByRole('radio', { name: '5m', exact: true }).click();
  await pkg.getByRole('radio', { name: 'EMA 200' }).click();
  await pkg.getByRole('radio', { name: 'Close and reverse' }).click();
  await pkg.getByLabel('Supertrend ATR length').fill('14');
  await pkg.getByLabel('Supertrend factor').fill('2.5');
  // Approve ETH/USDT only.
  if ((await pkg.getByRole('checkbox', { name: 'BTC/USDT' }).getAttribute('aria-checked')) === 'true') await pkg.getByRole('checkbox', { name: 'BTC/USDT' }).click();
  if ((await pkg.getByRole('checkbox', { name: 'ETH/USDT' }).getAttribute('aria-checked')) !== 'true') await pkg.getByRole('checkbox', { name: 'ETH/USDT' }).click();
  await pkg.getByRole('button', { name: 'Save draft' }).click();
  await expect(pkg.getByTestId('version-1').getByText('Draft')).toBeVisible();
  await pkg.getByRole('button', { name: 'Publish v1' }).click();
  await admin.getByRole('alertdialog').getByRole('button', { name: 'Publish' }).click();
  await expect(pkg.getByTestId('version-1').getByText('Published · latest')).toBeVisible();
  await expect(pkg.getByTestId('version-1')).toContainText('5m · ATR 14 × 2.5 · EMA 200');
});

test('the investor accepts the single-use invite and the link cannot be reused', async () => {
  const token = await latestToken(C.email, 'INVITE');
  chloe = await (await browser.newContext()).newPage();
  await chloe.goto(`/account/invite#token=${token}`);
  await expect(chloe.getByText(`Welcome, ${C.name}`)).toBeVisible();
  // The token is removed from the address bar immediately.
  expect(chloe.url()).not.toContain(token);
  await chloe.getByLabel('New password').fill(C.password);
  await chloe.getByLabel('Confirm password').fill(C.password);
  await chloe.getByRole('button', { name: 'Set password and activate' }).click();
  await expect(chloe.getByText('Your password is set and your account is active.')).toBeVisible();

  const second = await (await browser.newContext()).newPage();
  await second.goto(`/account/invite#token=${token}`);
  await expect(second.getByText('This link is invalid, expired or already used.')).toBeVisible();
  await second.context().close();
});

test('the investor signs in, sees only their own profile and turns on MFA', async () => {
  await signIn(chloe, C.email, C.password);
  await expect(chloe).toHaveURL(/\/trade-settings$/);
  await expect(chloe.getByTestId('account-scope').first()).toHaveText(`My Account · ${C.name}`);
  await chloe.getByRole('link', { name: 'My Account', exact: true }).click();
  await expect(chloe.getByTestId('profile-email')).toHaveText(C.email);

  await chloe.getByRole('button', { name: 'Set up two-step sign-in' }).click();
  mfaSecret = (await chloe.getByTestId('mfa-secret').textContent())!.trim();
  await chloe.getByLabel('Authentication code').fill(await freshCode(chloe, mfaSecret));
  await chloe.getByRole('button', { name: 'Turn on' }).click();
  await expect(chloe.getByTestId('mfa-status')).toHaveText('On');
  const stored = await sql<{ mfa_secret_enc: string }>('SELECT mfa_secret_enc FROM users WHERE email = $1', [C.email]);
  expect(stored[0]!.mfa_secret_enc).toMatch(/^v1\./);
  expect(stored[0]!.mfa_secret_enc).not.toContain(mfaSecret);

  await signOut(chloe);
  await signIn(chloe, C.email, C.password, mfaSecret);
  await expect(chloe).toHaveURL(/\/trade-settings$/);
});

test('the investor configures ETH/USDT, previews the order with fixture data and activates', async () => {
  await chloe.getByRole('button', { name: 'Add Token' }).click();
  const panel = chloe.getByRole('dialog');
  await panel.getByLabel('Trading pair').selectOption({ label: 'ETH/USDT' });
  await expect(panel.getByLabel('Strategy').locator('option:checked')).toHaveText(`${PKG} · v1`);
  await panel.getByRole('radio', { name: 'Long only' }).click();
  await panel.getByLabel('Order cost (USDT)').fill('40');
  await panel.getByLabel('Leverage').selectOption('5');
  await panel.getByLabel('Stop loss', { exact: true }).fill('2');
  await panel.getByRole('checkbox', { name: 'Saturday' }).click();
  await panel.getByRole('button', { name: 'Preview order' }).click();
  const preview = panel.getByTestId('order-preview');
  await expect(preview.getByText('Fixture data')).toBeVisible();
  // 40 × 5 = 200 USDT at the 3200.11 fixture ask, 0.01 ETH per contract → 6 contracts.
  await expect(preview.getByTestId('preview-LONG-contracts')).toHaveText('6');
  await expect(preview.getByTestId('preview-SHORT-contracts')).toHaveCount(0);
  await panel.getByRole('button', { name: 'Save & Activate' }).click();
  const row = chloe.getByTestId('order-block-ETHUSDT');
  await expect(row.getByText('Active — waiting for signal')).toBeVisible();
  await expect(row).toContainText(`${PKG} · v1 · Long only`);
  await expect(row.getByTestId('trading-days')).toHaveText('Trading days: Sun, Mon, Tue, Wed, Thu, Fri · Asia/Dhaka');
});

test('the investor cannot use admin actions or reach another investor\'s settings', async () => {
  for (const [method, path] of [
    ['GET', '/v1/admin/users'],
    ['POST', '/v1/admin/users'],
    ['POST', '/v1/admin/instruments/validate'],
    ['GET', '/v1/admin/audit']
  ] as const) {
    const r = await chloe.request.fetch(path, { method, data: method === 'POST' ? { name: 'X', email: 'x@y.z', symbol: 'BTCUSDT' } : undefined });
    expect(r.status(), `${method} ${path}`).toBe(403);
  }
  await chloe.goto('/admin');
  await expect(chloe).toHaveURL(/\/trade-settings$/);

  // Investor B's block (created by the first spec) is invisible and immutable to Chloe.
  const [bBlock] = await sql<{ id: string; revision: number; order_cost_usdt: string }>(
    "SELECT b.id, b.revision, b.order_cost_usdt FROM order_blocks b JOIN users u ON u.id = b.owner_id WHERE u.email = 'investor.b@trendpilot.local' LIMIT 1"
  );
  expect(bBlock).toBeTruthy();
  expect((await chloe.request.get(`/v1/me/order-blocks/${bBlock!.id}`)).status()).toBe(404);
  expect((await chloe.request.patch(`/v1/me/order-blocks/${bBlock!.id}`, { headers: { 'if-match': `"${bBlock!.revision}"` }, data: { orderCostUsdt: '1' } })).status()).toBe(404);
  expect((await chloe.request.post(`/v1/me/order-blocks/${bBlock!.id}/pause`, { headers: { 'if-match': `"${bBlock!.revision}"` } })).status()).toBe(404);
  expect((await chloe.request.post(`/v1/me/order-blocks/${bBlock!.id}/preview`)).status()).toBe(404);
  const own = await (await chloe.request.get('/v1/me/order-blocks')).json();
  expect(own.items.map((x: { symbol: string }) => x.symbol)).toEqual(['ETHUSDT']);
  const [after] = await sql<{ revision: number; order_cost_usdt: string }>('SELECT revision, order_cost_usdt FROM order_blocks WHERE id = $1', [bBlock!.id]);
  expect(after).toEqual({ revision: bBlock!.revision, order_cost_usdt: bBlock!.order_cost_usdt });
});

test('publishing v2 leaves the investor pinned to v1', async () => {
  await admin.getByRole('link', { name: 'Strategy Packages' }).click();
  const pkg = admin.getByTestId(`package-${PKG}`);
  await pkg.getByRole('button', { name: 'New version' }).click();
  await pkg.getByRole('radio', { name: '15m', exact: true }).click();
  await pkg.getByRole('radio', { name: 'Keep position open' }).click();
  await pkg.getByRole('button', { name: 'Save draft' }).click();
  await pkg.getByRole('button', { name: 'Publish v2' }).click();
  await admin.getByRole('alertdialog').getByRole('button', { name: 'Publish' }).click();
  await expect(pkg.getByTestId('version-2').getByText('Published · latest')).toBeVisible();
  await expect(pkg.getByTestId('version-1').getByText('Published', { exact: true })).toBeVisible();

  await chloe.reload();
  const row = chloe.getByTestId('order-block-ETHUSDT');
  await expect(row).toContainText(`${PKG} · v1 (pinned)`);
  await row.getByRole('button', { name: /^Edit/ }).click();
  await expect(chloe.getByTestId('pinned-notice')).toContainText('Version 2 is published');
  await chloe.getByRole('button', { name: 'Cancel' }).click();
  const [stored] = await sql<{ version: number }>(
    'SELECT v.version FROM order_blocks b JOIN strategy_versions v ON v.id = b.strategy_version_id JOIN users u ON u.id = b.owner_id WHERE u.email = $1',
    [C.email]
  );
  expect(stored!.version).toBe(1);
});

test('pause and resume persist after signing in again', async () => {
  const row = () => chloe.getByTestId('order-block-ETHUSDT');
  await row().getByRole('button', { name: /^Pause/ }).click();
  await expect(row().getByText('Paused')).toBeVisible();
  await signOut(chloe);
  await signIn(chloe, C.email, C.password, mfaSecret);
  await expect(row().getByText('Paused')).toBeVisible();
  await row().getByRole('button', { name: /^Resume/ }).click();
  await expect(row().getByText('Active — waiting for signal')).toBeVisible();
  await signOut(chloe);
  await signIn(chloe, C.email, C.password, mfaSecret);
  await expect(row().getByText('Active — waiting for signal')).toBeVisible();
});

test('a stale tab cannot silently overwrite a newer edit', async () => {
  const tab2 = await chloe.context().newPage();
  await tab2.goto('/trade-settings');
  await chloe.reload();

  await chloe.getByTestId('order-block-ETHUSDT').getByRole('button', { name: /^Edit/ }).click();
  await tab2.getByTestId('order-block-ETHUSDT').getByRole('button', { name: /^Edit/ }).click();

  await tab2.getByRole('dialog').getByLabel('Order cost (USDT)').fill('45');
  await tab2.getByRole('dialog').getByRole('button', { name: 'Save', exact: true }).click();
  await expect(tab2.getByTestId('order-block-ETHUSDT').getByTestId('order-cost')).toHaveText('45.00 USDT');

  await chloe.getByRole('dialog').getByLabel('Order cost (USDT)').fill('99');
  await chloe.getByRole('dialog').getByRole('button', { name: 'Save', exact: true }).click();
  await expect(chloe.getByRole('dialog').getByText(/changed in another window/)).toBeVisible();
  const [row] = await sql<{ order_cost_usdt: string }>('SELECT b.order_cost_usdt FROM order_blocks b JOIN users u ON u.id = b.owner_id WHERE u.email = $1', [C.email]);
  expect(Number(row!.order_cost_usdt)).toBe(45);
  await tab2.close();
  await chloe.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();
});

test('the audit log shows actor, time and action for admin and settings changes', async () => {
  await admin.getByRole('link', { name: 'Audit Log' }).click();
  const rows = admin.getByTestId('audit-row');
  await expect(rows.first()).toBeVisible();
  for (const [action, actor] of [
    ['ADMIN_USER_INVITE', ADMIN],
    ['ADMIN_INSTRUMENT_CREATE', ADMIN],
    ['ADMIN_STRATEGY_PUBLISH', ADMIN],
    ['ACCOUNT_INVITE_ACCEPT', C.email],
    ['ACCOUNT_MFA_ENABLE', C.email],
    ['ORDER_BLOCK_CREATE', C.email],
    ['ORDER_BLOCK_UPDATE', C.email],
    ['ORDER_BLOCK_PAUSE', C.email]
  ]) {
    await expect(rows.filter({ hasText: action }).filter({ hasText: actor }).first(), action).toBeVisible();
  }
  await admin.getByLabel('Show').selectOption('ADMIN_');
  await expect(rows.filter({ hasText: 'ORDER_BLOCK_' })).toHaveCount(0);
});

test('suspending the investor ends their session immediately', async () => {
  await admin.getByRole('link', { name: 'Users' }).click();
  await admin.getByTestId(`user-row-${C.email}`).getByRole('button', { name: 'Suspend' }).click();
  await admin.getByRole('alertdialog').getByRole('button', { name: 'Suspend' }).click();
  await expect(admin.getByTestId(`user-row-${C.email}`).getByText('Suspended')).toBeVisible();
  await chloe.reload();
  await expect(chloe).toHaveURL(/\/sign-in$/);
  const r = await chloe.request.post('/v1/auth/login', { data: { email: C.email, password: C.password } });
  expect(r.status()).toBe(401);
});
