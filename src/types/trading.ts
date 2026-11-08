export type Direction = 'long' | 'short';
export type PreviewRole = 'trader' | 'admin';
export type ProtectionStatus = 'protected' | 'verifying' | 'unprotected';
/** Protection as shown to the user, after accounting for the connection's simulated health. */
export type EffectiveProtection = 'protected' | 'verifying' | 'limited' | 'unverified' | 'unprotected';
export type SignalResult = 'executed' | 'skipped' | 'rejected';
export type ActivityKind =
'entry' |
'protection' |
'take-profit' |
'exit' |
'stop-loss' |
'skip' |
'reject' |
'trailing' |
'close';
export type EquityPeriod = 'today' | '7d' | '30d';
export type NotificationTone = 'info' | 'success' | 'warning';
export type HealthState = 'operational' | 'degraded' | 'down';

export type ConnectionScenario =
'healthy' |
'invalid-credentials' |
'missing-trade-permission' |
'exchange-unavailable' |
'public-feed-down' |
'private-feed-down' |
'sync-failed';
export type ConnectionStatus = 'connected' | 'validation-required' | 'degraded' | 'error' | 'disconnected';
export type HealthDimension = 'ok' | 'failed' | 'off';
export type CheckState = 'pending' | 'running' | 'passed' | 'failed' | 'skipped';
export type EventOutcome = 'success' | 'failure' | 'info';

export interface Exchange {
  id: string;
  name: string;
  enabled: boolean;
}

export interface AccountPreferences {
  allowedPairs: string[];
  positionMode: 'One-way';
  marginMode: 'Isolated';
  leverage: number;
  isDefault: boolean;
}

export interface SyncAttempt {
  at: number;
  ok: boolean;
  reason?: string;
}

/** A simulated exchange connection (paper account). Never stores credential values — only a fictional masked reference. */
export interface DemoAccount {
  id: string;
  name: string;
  descriptor: string;
  exchangeId: string;
  /** Paper simulation, or Live — simulated (linked to the subscriber's simulated MEXC connection). */
  environment: 'paper' | 'live';
  openingEquity: number;
  maxOpenPositions: number;
  maskedKey: string;
  createdAt: number;
  preferences: AccountPreferences;
  scenario: ConnectionScenario;
  disconnected: boolean;
  /** Paused by the user for this account only. */
  entriesPaused: boolean;
  /** Set after recovering to a healthy scenario; cleared by a successful validation + sync. */
  needsRevalidation: boolean;
  lastSyncAt: number | null;
  lastSyncAttempt: SyncAttempt | null;
  lastValidation: SyncAttempt | null;
  /** Owning demo user. Missing = the original demo user. */
  userId?: string;
}

export interface Strategy {
  id: string;
  name: string;
  timeframe: string;
}

export interface Position {
  id: string;
  accountId: string;
  exchangeId: string;
  pair: string;
  baseAsset: string;
  direction: Direction;
  strategyId: string;
  quantity: number;
  closedQuantity: number;
  allocatedCost: number;
  leverage: number;
  entryPrice: number;
  markPrice: number;
  stopLoss: number;
  takeProfit: number;
  /** Initial stop captured in the position's exit snapshot. null = not recorded (risk data incomplete). */
  initialStop: number | null;
  trailingState: string;
  protection: ProtectionStatus;
  marginMode: 'Isolated' | 'Cross';
  triggerBasis: string;
  openedAt: string;
  priceDecimals: number;
  quantityDecimals: number;
  /** false = external position opened outside a managed strategy (no TrendPilot exit plan). */
  managed?: boolean;
  strategyVersion?: string;
  subscriptionLabel?: string;
  /** Immutable exit configuration captured at entry. Missing = not recorded in this demo. */
  exitSnapshot?: PositionExitSnapshot;
  /** Set for positions opened through the central paper signal flow. */
  sourceSignalId?: string;
  subscriptionId?: string;
  exitRuntime?: import('./signals').ExitRuntime;
  /** Set for positions opened by a token block. Uses percentage exit rules only. */
  tokenRuntime?: import('./holdings').TokenRuntime;
}

export interface PositionExitSnapshot {
  planLabel: string;
  mode: string;
  partialTarget: string | null;
  closePct: number | null;
  trailing: string | null;
  bestPrice: number | null;
  oppositeExit: boolean;
}

/**
 * Realized P&L ledger entry. Feeds wallet balance and daily totals.
 * - opening-summary: seeded historical activity without itemized trade records
 * - partial / final: closing fills linked to a position
 * - entry-fee: entry commission charged once when recorded
 */
export interface ClosedTrade {
  id: string;
  accountId: string;
  strategyId: string;
  pair: string;
  direction: Direction;
  closedAt: string;
  grossPnl: number;
  commission: number;
  fundingPaid: number;
  fundingReceived: number;
  kind?: 'opening-summary' | 'partial' | 'final' | 'entry-fee' | 'funding' | 'correction';
  positionId?: string;
  quantity?: number;
  fillPrice?: number;
  /** Effective time (reporting period). */
  at?: number;
  /** When the event was recorded locally. Missing = same as effective time. */
  recordedAt?: number;
  /** Funding settlement this entry books (kind 'funding'). */
  settlementId?: string;
  /** Explicit correction: original event id and reason. Never edits the original. */
  correctsId?: string;
  reason?: string;
}

/** External paper transfer (virtual funds). Not trading P&L. */
export interface PaperTransfer {
  id: string;
  accountId: string;
  amount: number;
  at: number;
}

export interface ActivityEvent {
  id: string;
  kind: ActivityKind;
  title: string;
  detail: string;
  accountId: string;
  strategyId: string;
  pair: string;
  time: string;
  positionId?: string;
}

export interface SignalRecord {
  id: string;
  accountId: string;
  strategyId: string;
  pair: string;
  action: string;
  timeframe: string;
  candleCloseAt: string;
  receivedAt: string;
  result: SignalResult;
  reason: string;
  /** Central signal receipt this account outcome belongs to. */
  centralId?: string;
  deliveryState?: import('./signals').DeliveryState;
  at?: number;
  link?: {to: string;label: string;};
}

export interface NotificationItem {
  id: string;
  title: string;
  detail: string;
  time: string;
  read: boolean;
  tone: NotificationTone;
  /** Owning demo user. Missing = the original demo user. */
  userId?: string;
}

/** Connection audit trail. Never contains credential values. */
export interface ConnectionEvent {
  id: string;
  accountId: string;
  at: number;
  action: string;
  outcome: EventOutcome;
  detail: string;
}

export interface HealthService {
  id: string;
  name: string;
  state: HealthState;
  statusLabel: string;
  detail: string;
}

export type EquitySeriesSet = Record<EquityPeriod, number[]>;

export interface LedgerTotals {
  grossRealized: number;
  commissions: number;
  fundingPaid: number;
  fundingReceived: number;
  netRealized: number;
  unrealized: number;
  usedMargin: number;
  allocatedCost: number;
  openPositions: number;
}

export interface AccountSummary extends LedgerTotals {
  openingEquity: number;
  transfersIn: number;
  walletBalance: number;
  currentEquity: number;
  /** Margin reserved by working entry orders (unfilled part). */
  reservedMargin: number;
  availableMargin: number;
  dayChange: number;
  dayChangePct: number;
}

export interface ChartPoint {
  label: string;
  fullLabel: string;
  equity: number;
}

export interface CheckResult {
  id: string;
  label: string;
  state: CheckState;
  detail?: string;
  reason?: string;
}