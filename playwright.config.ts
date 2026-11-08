import { randomBytes } from 'node:crypto';
import { defineConfig, devices } from '@playwright/test';

const PORT = 3100;
const E2E_DB = process.env.DATABASE_URL_E2E ?? 'postgres://trendpilot:trendpilot@localhost:5433/trendpilot_e2e';
const SEED_PASSWORD = process.env.SEED_PASSWORD ?? 'TrendPilot-dev-only-1';
// Throwaway key for this run: the production build refuses to seal MFA secrets without one.
const DATA_ENCRYPTION_KEY = randomBytes(32).toString('base64');

export default defineConfig({
  testDir: 'apps/web/e2e',
  globalSetup: './apps/web/e2e/globalSetup.ts',
  fullyParallel: false,
  workers: 1,
  timeout: 120_000,
  expect: { timeout: 10_000 },
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'retain-on-failure'
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    // Production build: realistic and avoids dev-mode first-compile latency.
    command: `npx next build && npx next start --port ${PORT}`,
    cwd: 'apps/web',
    url: `http://localhost:${PORT}/sign-in`,
    timeout: 300_000,
    reuseExistingServer: false,
    env: {
      DATABASE_URL: E2E_DB,
      SEED_PASSWORD,
      DATA_ENCRYPTION_KEY,
      APP_BASE_URL: `http://localhost:${PORT}`,
      // Controlled signal clock for the TradingView replay spec (Sunday 15:30:03 Asia/Dhaka).
      SIGNAL_TEST_CLOCK: '2026-11-08T09:30:03Z',
      ALLOW_SIGNAL_TEST_CLOCK: 'true',
      LIVE_ORDER_TRANSPORT: 'disabled',
      NEXT_TELEMETRY_DISABLED: '1'
    }
  }
});
