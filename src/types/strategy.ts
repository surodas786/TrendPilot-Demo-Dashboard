import type { Direction } from './trading';

export type DirectionScope = 'long' | 'short' | 'both';

/** Centrally approved strategy template. Parameters are read-only for traders. */
export interface StrategyTemplate {
  id: string;
  name: string;
  version: string;
  market: string;
  exchangeId: string;
  timeframe: string;
  timeframeLabel: string;
  atrLength: number;
  supertrendFactor: number;
  emaLength: number;
  emaFilterAllowed: boolean;
  confirmation: string;
  directions: Direction[];
  /** Strategy-level signal age limit. The stricter of this and the account limit applies. */
  maxSignalAgeSec: number;
  approval: 'approved';
  label: string;
}

export type SubscriptionLifecycle = 'draft' | 'saved' | 'archived';

export interface Subscription {
  id: string;
  label: string;
  strategyId: string;
  version: string;
  accountId: string;
  exchangeId: string;
  pairs: string[];
  directions: DirectionScope;
  emaFilter: boolean;
  orderCost: number;
  leverage: number;
  /** One saved risk policy per account in this demo (the account's Trading & Risk Settings). */
  riskPolicyId: string;
  /** Specific exit-plan version attached; null means none. New versions apply to future entries only. */
  exitPlanId: string | null;
  lifecycle: SubscriptionLifecycle;
  paused: boolean;
  /** Explicitly activated for future simulated signals. Activation never places an order. */
  activated: boolean;
  createdAt: number;
  updatedAt: number;
}

export type SubscriptionStatus = 'draft' | 'setup-incomplete' | 'ready' | 'active' | 'paused' | 'blocked' | 'archived';