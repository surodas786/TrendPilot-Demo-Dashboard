import type { Direction, EventOutcome } from './trading';

export type DailyLossBasis = 'net-realized' | 'net-plus-unrealized';

/** Account-wide risk policy. Applies across every subscription on the account. */
export interface RiskSettings {
  defaultOrderCost: number;
  defaultLeverage: number;
  maxOpenPositions: number;
  maxAggregateNotional: number;
  maxAggregateStopRisk: number;
  maxOrderCost: number;
  dailyLossLimit: number;
  dailyLossBasis: DailyLossBasis;
  freeMarginReserve: number;
  cooldownMinutes: number;
  maxSpreadPct: number;
  maxDeviationPct: number;
  maxSignalAgeSec: number;
}

export type NumericRiskKey = Exclude<keyof RiskSettings, 'dailyLossBasis' | 'defaultLeverage'>;

export interface PlatformLimits {
  maxLeverage: number;
  maxOrderCost: number;
  maxOpenPositions: number;
  maxAggregateNotional: number;
  maxAggregateStopRisk: number;
}

/** Fictional instrument specification. Not an actual exchange specification. */
export interface InstrumentSpec {
  pair: string;
  baseAsset: string;
  contractSize: number;
  quantityStep: number;
  minQuantity: number;
  priceDecimals: number;
  quantityDecimals: number;
}

/** An entry that has been accepted but not filled yet; it reserves margin and exposure. */
export interface PendingEntry {
  id: string;
  accountId: string;
  pair: string;
  direction: Direction;
  orderCost: number;
  leverage: number;
  notional: number;
  stopRisk: number | null;
  /** True when the margin is already reserved in the account's available margin (working entry orders). */
  marginReserved?: boolean;
}

export type AuditCategory = 'settings' | 'subscription' | 'readiness' | 'exit-plan' | 'execution';

/** Shared demo activity log. Never contains sensitive data. */
export interface AuditEntry {
  id: string;
  at: number;
  accountId: string | null;
  subscriptionId?: string;
  category: AuditCategory;
  action: string;
  outcome: EventOutcome;
  detail: string;
}

export type ReadinessState = 'pass' | 'fail' | 'pending';

export interface ReadinessItem {
  id: string;
  label: string;
  state: ReadinessState;
  detail: string;
}

export interface ReadinessDemoInputs {
  signalAgeSec: number;
  spreadPct: number;
  deviationPct: number;
}