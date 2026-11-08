export type TradingMode = 'paper' | 'live';
export type MarginMode = 'isolated' | 'cross';

/** One take-profit target. Percentages are price movement from entry; close % is of the original filled quantity. */
export interface TakeProfitTarget {
  movePct: number;
  closePct: number;
}

/**
 * A subscriber's per-token order block. One block per subscriber + pair + mode.
 * Settings apply to future entries only; open positions keep the settings captured at entry.
 */
export interface TokenBlock {
  id: string;
  subscriberId: string;
  /** Trading account that funds entries. null = account selection required (blocked). */
  accountId: string | null;
  symbol: string;
  mode: TradingMode;
  packageId: string;
  /** Margin allocated to each new entry, before fees (USDT). */
  orderCost: number;
  leverage: number;
  marginMode: MarginMode;
  stopLossPct: number;
  takeProfits: TakeProfitTarget[];
  trailingEnabled: boolean;
  trailingPct: number;
  allowAdditionalEntries: boolean;
  maxEntriesPerDirection: number;
  allowSimultaneousDirections: boolean;
  /** Days (0 = Sunday … 6 = Saturday, investor's timezone) on which new entries may open. Undefined = every day. */
  tradingDays?: number[];
  /** Explicit subscriber intent. Blocked status is derived separately from current requirements. */
  active: boolean;
  /** Open positions linked to this block — maintained by the execution workflow (next step). */
  openPositions: number;
  version: number;
  createdAt: number;
  updatedAt: number;
}

export interface TargetDraft {
  movePct: string;
  closePct: string;
}

export interface TokenBlockDraft {
  symbol: string;
  mode: TradingMode;
  accountId: string;
  packageId: string;
  orderCost: string;
  leverage: number | null;
  marginMode: MarginMode;
  stopLossPct: string;
  split: boolean;
  targets: TargetDraft[];
  trailingEnabled: boolean;
  trailingPct: string;
  allowAdditionalEntries: boolean;
  maxEntriesPerDirection: string;
  allowSimultaneousDirections: boolean;
  tradingDays: number[];
}

export type BlockStatus = {kind: 'active';} | {kind: 'paused';blockedReason?: string;} | {kind: 'blocked';reason: string;};