import type { Direction } from './trading';

/** A simulated funding settlement. Quantity and price are a snapshot taken at settlement time. */
export interface FundingSettlement {
  id: string;
  accountId: string;
  pair: string;
  positionId: string | null;
  direction: Direction;
  /** True only when the demo records reliably link it to a managed trade. */
  attributed: boolean;
  effectiveAt: number;
  recordedAt: number;
  ratePct: number;
  quantity: number;
  price: number;
  notional: number;
  /** Signed wallet movement in USDT (negative = paid). */
  amount: number;
  ledgerId: string;
  late: boolean;
}

export type SyncStreamId = 'balances' | 'positions' | 'orders' | 'fills' | 'funding' | 'backfill';

export interface SyncStream {
  lastAttemptAt: number | null;
  lastSuccessAt: number | null;
  status: 'ok' | 'failed' | 'partial' | 'never';
  missingPeriod: string | null;
  finding: string;
}

/** Local vs simulated-source difference found during synchronization. */
export interface Discrepancy {
  id: string;
  accountId: string;
  stream: SyncStreamId;
  label: string;
  local: number;
  source: number;
  foundAt: number;
  status: 'open' | 'corrected';
  correctionId?: string;
}

export interface EquitySnapshot {
  id: string;
  accountId: string;
  at: number;
  wallet: number;
  equity: number;
  unrealized: number;
  source: string;
}

export type NotificationCategory = 'fills' | 'signals' | 'protection' | 'risk' | 'connection' | 'sync' | 'reconciliation' | 'test' | 'general';
export type NotificationSeverity = 'critical' | 'warning' | 'info';

export interface NotificationPrefs {
  inApp: Record<NotificationCategory, boolean>;
  email: Record<NotificationCategory, boolean>;
  updatedAt: number;
}

export interface TestNotification {
  id: string;
  userId: string;
  accountId: string | null;
  at: number;
  category: NotificationCategory;
  title: string;
}

export interface EmailFailWindow {
  from: number;
  to: number | null;
}

export type FinanceScenarioId =
'virtual-funds' |
'funding-paid' |
'funding-received' |
'duplicate-funding' |
'late-funding' |
'failed-sync' |
'recon-difference' |
'email-failure';