// Trading mode on existing Trade Settings entries (runs last; uses its own investor, so earlier
// specs' positions and blocks cannot affect it). The MEXC connection is a VERIFIED row written
// directly (mocked: nothing contacts MEXC and no order is placed in this spec). Covers:
//  - New Entry still offers Paper and Live, and names the reason when Live is unavailable;
//  - ETH: an eligible Paper entry switches to Live after an explicit confirmation, settings kept;
//  - BTC: an eligible Live entry switches to Paper; then an entry whose destination exists is
//    blocked with the reason and an "Edit the … entry" action that opens that entry;
//  - an entry managing a position (server answer mocked) offers to copy its settings into a new
//    entry in the other mode, which saves as a separate entry;
//  - without a verified connection, the Edit form shows why Live is unavailable.
import { expect, test, type Page } from '@playwright/test';
import pg from 'pg';

test.describe.configure({ mode: 'serial' });

const DB_URL = process.env.DATABASE_URL_E2E ?? 'postgres://trendpilot:trendpilot@localhost:5433/trendpilot_e2e';
const PASSWORD = process.env.SEED_PASSWORD ?? 'TrendPilot-dev-only-1';
const EMAIL = 'investor.mode@trendpilot.local';

async function sql<T = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> {
  const c = new pg.Client({ connectionString: DB_URL });
  await c.connect();
  try {
    return (await c.query(text, params)).rows as T[];
  } finally {
    await c.end();
  }
}

/** A published, non-archived strategy version approved for the pair. */
async function versionFor(symbol: string): Promise<string> {
  const [v] = await sql<{ id: string }>(
    `SELECT v.id FROM strategy_versions v
       JOIN strategy_packages p ON p.id = v.package_id
       JOIN strategy_version_instruments vi ON vi.version_id = v.id
       JOIN instruments i ON i.id = vi.instrument_id
      WHERE i.symbol = $1 AND v.published_at IS NOT NULL AND p.archived_at IS NULL
      ORDER BY v.published_at DESC LIMIT 1`,
    [symbol]
  );
  if (!v) throw new Error(`no published strategy version for ${symbol}`);
  return v.id;
}

async function signIn(page: Page) {
  await page.context().clearCookies();
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill(EMAIL);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).not.toHaveURL(/sign-in/);
}

const setConnection = (status: 'VERIFIED' | null) =>
  status
    ? sql(
        `INSERT INTO exchange_connections (owner_id, account_ref, api_key_sealed, secret_sealed, key_fingerprint, status, verified_at, position_mode)
         SELECT id, 'UID …0001', 'mock-sealed', 'mock-sealed', 'mock-fp', 'VERIFIED', now(), 'ONE_WAY' FROM users WHERE email = $1
         ON CONFLICT (owner_id) DO UPDATE SET status = 'VERIFIED', verified_at = now()`,
        [EMAIL]
      )
    : sql(`DELETE FROM exchange_connections WHERE owner_id = (SELECT id FROM users WHERE email = $1)`, [EMAIL]);

/** Creates an entry through the API with the signed-in session (custom sizing and trading window). */
async function createEntry(page: Page, symbol: string, mode: 'PAPER' | 'LIVE', orderCostUsdt: string) {
  const [inst] = await sql<{ id: string }>(`SELECT id FROM instruments WHERE symbol = $1`, [symbol]);
  const r = await page.request.post('/v1/me/order-blocks', {
    headers: { origin: new URL(page.url()).origin },
    data: {
      instrumentId: inst!.id,
      mode,
      strategyVersionId: await versionFor(symbol),
      direction: 'BOTH',
      orderCostUsdt,
      leverage: 5,
      marginMode: 'ISOLATED',
      stop: { type: 'PERCENT', value: '1.5', basis: 'MARK' },
      takeProfitLong: { mode: 'FIXED', levels: [{ id: 'L', movePct: '0.6', closePct: '100' }] },
      takeProfitShort: { mode: 'FIXED', levels: [{ id: 'S', movePct: '0.4', closePct: '100' }] },
      trailing: { enabled: false, activationPct: null, distancePct: null, basis: 'MARK' },
      weekdays: ['MON', 'TUE', 'WED', 'THU', 'FRI'],
      tradingWindow: { start: '09:00', end: '17:30' },
      allowAdds: false,
      maxAdds: null,
      risk: { maxOpenPositions: null, maxNotionalUsdt: null, maxStopRiskUsdt: null, dailyLossLimitUsdt: null, cooldownMinutes: null, maxSpreadPct: null, maxPriceDeviationPct: null }
    }
  });
  expect(r.status(), await r.text()).toBe(201);
  return (await r.json()) as { id: string };
}

const modeRadio = (page: Page, name: string) => page.getByRole('dialog').getByRole('radiogroup', { name: 'Trading mode' }).getByRole('radio', { name, exact: true });

test.beforeAll(async () => {
  // Second contract: the e2e seed publishes BTC only. Publish ETH (copied from BTC's fixture
  // contract) and, as an administrator would, a new version of the BTC strategy approved for
  // both pairs. Skipped when an earlier spec already made ETH tradable.
  await sql(
    `INSERT INTO instruments
     SELECT (jsonb_populate_record(null::instruments, to_jsonb(i) || jsonb_build_object('id', gen_random_uuid(), 'symbol', 'ETHUSDT', 'base', 'ETH', 'exchange_symbol', 'ETH_USDT'))).*
       FROM instruments i WHERE symbol = 'BTCUSDT'
     ON CONFLICT DO NOTHING`
  );
  await sql(`UPDATE instruments SET status = 'PUBLISHED' WHERE symbol = 'ETHUSDT'`);
  await sql(`DO $$
    DECLARE src uuid; nv uuid := gen_random_uuid(); eth uuid; btc uuid;
    BEGIN
      SELECT id INTO eth FROM instruments WHERE symbol = 'ETHUSDT';
      SELECT id INTO btc FROM instruments WHERE symbol = 'BTCUSDT';
      IF EXISTS (SELECT 1 FROM strategy_versions v JOIN strategy_packages p ON p.id = v.package_id JOIN strategy_version_instruments vi ON vi.version_id = v.id
                  WHERE vi.instrument_id = eth AND v.published_at IS NOT NULL AND p.archived_at IS NULL) THEN RETURN; END IF;
      SELECT v.id INTO src FROM strategy_versions v JOIN strategy_packages p ON p.id = v.package_id JOIN strategy_version_instruments vi ON vi.version_id = v.id
       WHERE vi.instrument_id = btc AND v.published_at IS NOT NULL AND p.archived_at IS NULL ORDER BY v.published_at DESC LIMIT 1;
      INSERT INTO strategy_versions
      SELECT (jsonb_populate_record(null::strategy_versions, to_jsonb(v) || jsonb_build_object('id', nv, 'version', (SELECT max(version) + 1 FROM strategy_versions WHERE package_id = v.package_id), 'published_at', null, 'published_by', null))).*
        FROM strategy_versions v WHERE v.id = src;
      INSERT INTO strategy_version_instruments (version_id, instrument_id) VALUES (nv, btc), (nv, eth);
      UPDATE strategy_versions SET published_at = now() WHERE id = nv;
    END $$`);

  // A dedicated investor with the seed password, no entries and no trading history.
  await sql(`DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE email = $1)`, [EMAIL]);
  await sql(`DELETE FROM exchange_connections WHERE owner_id IN (SELECT id FROM users WHERE email = $1)`, [EMAIL]);
  await sql(`DELETE FROM order_blocks WHERE owner_id IN (SELECT id FROM users WHERE email = $1)`, [EMAIL]);
  await sql(
    `INSERT INTO users (email, name, role, status, password_hash, timezone)
     SELECT $1, 'Mode Tester', role, 'ACTIVE', password_hash, timezone FROM users WHERE email = 'investor.a@trendpilot.local'
     ON CONFLICT (email) DO NOTHING`,
    [EMAIL]
  );
});

test('New Entry: Paper and Live both selectable with a verified connection; the reason shows without one', async ({ page }) => {
  await setConnection('VERIFIED');
  await signIn(page);
  await page.goto('/trade-settings');
  await page.getByRole('button', { name: 'Add Token' }).click();
  await expect(modeRadio(page, 'Paper')).toBeEnabled();
  await expect(modeRadio(page, 'Live (MEXC)')).toBeEnabled();
  await modeRadio(page, 'Live (MEXC)').click();
  await expect(modeRadio(page, 'Live (MEXC)')).toHaveAttribute('aria-checked', 'true');
  await modeRadio(page, 'Paper').click();
  await expect(modeRadio(page, 'Paper')).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByRole('dialog').getByTestId('mode-unavailable')).toHaveCount(0);
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();

  await setConnection(null);
  await page.reload();
  await page.getByRole('button', { name: 'Add Token' }).click();
  await expect(modeRadio(page, 'Live — connect MEXC first')).toBeDisabled();
  await expect(page.getByRole('dialog').getByTestId('mode-unavailable')).toHaveText(/Live unavailable: Connect and verify your MEXC account on the Live Trading page/);
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();
});

test('ETH: an eligible Paper entry switches to Live after confirmation; settings are kept', async ({ page }) => {
  await setConnection('VERIFIED');
  await signIn(page);
  await page.goto('/trade-settings');
  await createEntry(page, 'ETHUSDT', 'PAPER', '33');
  await page.reload();

  await page.getByRole('button', { name: 'Edit ETH/USDT Paper' }).click();
  const panel = page.getByRole('dialog');
  await expect(panel.getByRole('heading', { name: 'ETH/USDT · Paper' })).toBeVisible();
  await expect(modeRadio(page, 'Live (MEXC)')).toBeEnabled();
  await modeRadio(page, 'Live (MEXC)').click();
  await expect(panel.getByTestId('mode-change-notice')).toContainText('switches this entry from Paper to Live (MEXC) for future entries');
  await panel.getByRole('button', { name: 'Save and switch to Live (MEXC)' }).click();
  const confirm = page.getByRole('alertdialog');
  await expect(confirm.getByText('Your settings are kept and the entry is paused')).toBeVisible();
  await confirm.getByRole('button', { name: 'Switch to Live (MEXC)', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'ETH/USDT · Paper' })).toHaveCount(0);

  await expect(page.getByRole('button', { name: 'Edit ETH/USDT Live' })).toBeVisible();
  await page.getByRole('button', { name: 'Edit ETH/USDT Live' }).click();
  const again = page.getByRole('dialog');
  await expect(again.getByRole('heading', { name: 'ETH/USDT · Live (MEXC)' })).toBeVisible();
  await expect(modeRadio(page, 'Live (MEXC)')).toHaveAttribute('aria-checked', 'true');
  await expect(again.getByLabel('Order cost')).toHaveValue('33');
  await expect(again.getByTestId('tp-LONG').getByLabel('Long target — price move')).toHaveValue('0.6');
  await expect(again.getByTestId('tp-SHORT').getByLabel('Short target — price move')).toHaveValue('0.4');
  await again.getByRole('button', { name: 'Cancel' }).click();
  const [row] = await sql<{ mode: string; status: string; start: string; end: string; cost: string }>(
    `SELECT b.mode, b.status, b.trading_window_start AS start, b.trading_window_end AS end, b.order_cost_usdt::text AS cost
       FROM order_blocks b JOIN users u ON u.id = b.owner_id JOIN instruments i ON i.id = b.instrument_id WHERE u.email = $1 AND i.symbol = 'ETHUSDT'`,
    [EMAIL]
  );
  expect(row).toMatchObject({ mode: 'LIVE', status: 'PAUSED', start: '09:00', end: '17:30' });
  expect(Number(row!.cost)).toBe(33);
});

test('BTC: an eligible Live entry switches to Paper; a Paper entry whose Live entry exists shows why and links to it', async ({ page }) => {
  await signIn(page);
  await page.goto('/trade-settings');
  await createEntry(page, 'BTCUSDT', 'LIVE', '21');
  await page.reload();

  await page.getByRole('button', { name: 'Edit BTC/USDT Live' }).click();
  await expect(modeRadio(page, 'Paper')).toBeEnabled();
  await modeRadio(page, 'Paper').click();
  await page.getByRole('dialog').getByRole('button', { name: 'Save and switch to Paper' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Switch to Paper', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Edit BTC/USDT Paper' })).toBeVisible();

  // A BTC Live entry now exists again: the Paper entry cannot switch to Live.
  const live = await createEntry(page, 'BTCUSDT', 'LIVE', '22');
  await page.reload();
  await page.getByRole('button', { name: 'Edit BTC/USDT Paper' }).click();
  const blocked = page.getByRole('dialog').getByTestId('mode-unavailable');
  await expect(blocked).toHaveAttribute('data-code', 'DESTINATION_EXISTS');
  await expect(blocked).toContainText('You already have a Live (MEXC) entry for BTC/USDT. Edit that entry instead.');
  await expect(modeRadio(page, 'Live (MEXC)')).toBeDisabled();
  await blocked.getByRole('button', { name: 'Edit the Live (MEXC) entry' }).click();
  await expect(page.getByRole('dialog').getByRole('heading', { name: 'BTC/USDT · Live (MEXC)' })).toBeVisible();
  await expect(page.getByRole('dialog').getByLabel('Order cost')).toHaveValue('22');
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();
  expect(live.id).toBeTruthy();
});

test('an entry managing a position keeps its mode and offers to copy its settings into a separate entry', async ({ page }) => {
  await signIn(page);
  await page.goto('/trade-settings');
  // The server's answer for an entry with an open position (the API test covers the real check).
  await page.route('**/v1/me/order-blocks/*/mode-change?to=PAPER', (route) =>
    route.fulfill({
      json: {
        from: 'LIVE',
        to: 'PAPER',
        allowed: false,
        blocker: { code: 'BLOCK_IN_USE', openPositions: 1, pendingOrders: 0, message: 'This entry is managing 1 open position in Live (MEXC), which stays in Live (MEXC). Copy its settings into a separate Paper entry instead.' }
      }
    })
  );
  await page.getByRole('button', { name: 'Edit ETH/USDT Live' }).click();
  const blocked = page.getByRole('dialog').getByTestId('mode-unavailable');
  await expect(blocked).toHaveAttribute('data-code', 'BLOCK_IN_USE');
  await expect(blocked).toContainText('managing 1 open position in Live (MEXC)');
  await expect(modeRadio(page, 'Paper')).toBeDisabled();
  await blocked.getByRole('button', { name: 'Copy saved settings to a new Paper entry' }).click();

  const copy = page.getByRole('dialog');
  await expect(copy.getByRole('heading', { name: 'ETH/USDT · new Paper entry' })).toBeVisible();
  await expect(copy.getByTestId('copy-notice')).toContainText('saved settings of your Live (MEXC) entry');
  await expect(modeRadio(page, 'Paper')).toHaveAttribute('aria-checked', 'true');
  await expect(copy.getByLabel('Order cost')).toHaveValue('33');
  await copy.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Edit ETH/USDT Paper' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Edit ETH/USDT Live' })).toBeVisible();
  const rows = await sql<{ mode: string; cost: string }>(
    `SELECT b.mode, b.order_cost_usdt::text AS cost FROM order_blocks b JOIN users u ON u.id = b.owner_id JOIN instruments i ON i.id = b.instrument_id
      WHERE u.email = $1 AND i.symbol = 'ETHUSDT' ORDER BY b.mode`,
    [EMAIL]
  );
  expect(rows.map((r) => [r.mode, Number(r.cost)]).sort()).toEqual([
    ['LIVE', 33],
    ['PAPER', 33]
  ]);
});

test('without a verified connection the Edit form names why Live is unavailable', async ({ page }) => {
  await setConnection(null);
  await signIn(page);
  await page.goto('/trade-settings');
  await page.getByRole('button', { name: 'Edit ETH/USDT Paper' }).click();
  const blocked = page.getByRole('dialog').getByTestId('mode-unavailable');
  await expect(blocked).toHaveAttribute('data-code', 'LIVE_UNAVAILABLE');
  await expect(blocked).toContainText('Connect and verify your MEXC account on the Live Trading page to use Live.');
  await expect(blocked.getByRole('link', { name: 'Open Live Trading' })).toHaveAttribute('href', '/live-trading');
  await expect(modeRadio(page, 'Live (MEXC)')).toBeDisabled();
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();
});

test('My Account shows the same MEXC connection state as Live Trading, including the One-way requirement', async ({ page }) => {
  await setConnection('VERIFIED');
  await sql(`UPDATE exchange_connections SET position_mode = 'HEDGE' WHERE owner_id = (SELECT id FROM users WHERE email = $1)`, [EMAIL]);
  await signIn(page);

  await page.goto('/live-trading');
  const live = page.getByTestId('live-status');
  await expect(live).toContainText('Verified');
  await expect(live.getByTestId('live-position-mode')).toHaveText('Hedge — One-way required');
  await expect(live.getByTestId('live-blockers').locator('[data-reason="LIVE_POSITION_MODE"]')).toContainText('One-way position mode required');

  await page.goto('/my-account');
  const account = page.getByTestId('account-connection');
  await expect(account).toContainText('Verified');
  await expect(account).not.toContainText('Not connected');
  await expect(page.getByTestId('account-position-mode')).toHaveText('Hedge — One-way required');
  await expect(page.getByTestId('account-live-entries').locator('[data-reason="LIVE_POSITION_MODE"]')).toContainText('One-way position mode required');
  await expect(page.getByText('not part of this release')).toHaveCount(0);

  await sql(`UPDATE exchange_connections SET position_mode = 'ONE_WAY' WHERE owner_id = (SELECT id FROM users WHERE email = $1)`, [EMAIL]);
  await page.reload();
  await expect(page.getByTestId('account-position-mode')).toHaveText('One-way');
  await expect(page.getByTestId('account-live-entries').locator('[data-reason="LIVE_POSITION_MODE"]')).toHaveCount(0);
});
