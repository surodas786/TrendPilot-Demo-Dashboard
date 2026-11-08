import type { FinanceScenarioId, NotificationCategory, NotificationPrefs, SyncStreamId } from '../types/finance';

/** Fictional simulation inputs — not MEXC's current rates or intervals. */
export const SIM_FUNDING_RATES: Record<string, number> = {
  BTCUSDT: 0.01,
  ETHUSDT: -0.005,
  SOLUSDT: 0.015
};

/** Assumed settlement interval for this simulation (UTC boundaries). */
export const FUNDING_INTERVAL_MS = 8 * 3600 * 1000;

/** Rounding tolerance for reconciliation, in USDT. */
export const RECON_TOLERANCE = 0.01;

export function lastFundingSlot(now: number): number {
  return Math.floor(now / FUNDING_INTERVAL_MS) * FUNDING_INTERVAL_MS;
}

export function nextFundingSlot(now: number): number {
  return lastFundingSlot(now) + FUNDING_INTERVAL_MS;
}

export const SYNC_STREAMS: {id: SyncStreamId;label: string;}[] = [
{ id: 'balances', label: 'Balances' },
{ id: 'positions', label: 'Positions' },
{ id: 'orders', label: 'Open orders' },
{ id: 'fills', label: 'Fills and commissions' },
{ id: 'funding', label: 'Funding settlements' },
{ id: 'backfill', label: 'Historical backfill' }];


export const BACKFILL_GAP = 'Before Nov 4, 2026 00:00 (Asia/Dhaka) — history not available in this demo';

export const CATEGORY_LABELS: Record<NotificationCategory, string> = {
  fills: 'Entry and exit fills',
  signals: 'Signal rejections and failed evaluations',
  protection: 'Protection failures and unresolved exposure',
  risk: 'Daily loss limit',
  connection: 'Feed and credential problems',
  sync: 'Synchronization failures',
  reconciliation: 'Reconciliation differences',
  test: 'Test notifications',
  general: 'Other account events'
};

/** Categories that can never be hidden in-app. */
export const CRITICAL_CATEGORIES: NotificationCategory[] = ['protection'];

const all = (v: boolean) =>
({ fills: v, signals: v, protection: v, risk: v, connection: v, sync: v, reconciliation: v, test: v, general: v }) as Record<NotificationCategory, boolean>;

export const DEFAULT_NOTIFICATION_PREFS: NotificationPrefs = {
  inApp: all(true),
  email: { ...all(false), protection: true, risk: true },
  updatedAt: 0
};

export const financeScenarios: {id: FinanceScenarioId;label: string;scope: string;}[] = [
{ id: 'virtual-funds', label: 'Virtual funds increase equity, not trading P&L', scope: 'Adds a 500.00 USDT external paper transfer to the selected account.' },
{ id: 'funding-paid', label: 'Funding paid', scope: 'Applies a simulated settlement where an open position on the selected account pays funding.' },
{ id: 'funding-received', label: 'Funding received', scope: 'Applies a simulated settlement where an open position on the selected account receives funding.' },
{ id: 'duplicate-funding', label: 'Duplicate funding settlement ignored', scope: 'Re-applies the latest settlement ID on the selected account. No wallet movement is expected.' },
{ id: 'late-funding', label: 'Late funding updates an earlier report', scope: 'Records a settlement effective Nov 3 20:00 (Asia/Dhaka), received now, as unallocated account-level funding.' },
{ id: 'failed-sync', label: 'Failed synchronization keeps the last success', scope: 'Sets the selected account’s simulated connection to “sync failed” and runs a synchronization.' },
{ id: 'recon-difference', label: 'Reconciliation difference stays visible', scope: 'Makes the simulated source report 1.84 USDT less funding than local records, then runs a synchronization.' },
{ id: 'email-failure', label: 'Notification delivery fails, protection continues', scope: 'Turns on simulated email failure and sends a protection test alert. Protective orders are not touched.' }];