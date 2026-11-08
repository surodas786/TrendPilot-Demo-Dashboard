import type { MarginMode, TradingMode } from './tradeSettings';

export type PositionSide = 'long' | 'short';

export interface PositionTarget {
  movePct: number;
  /** Share of the ORIGINAL filled quantity. */
  closePct: number;
  price: number;
  state: 'open' | 'filled' | 'cancelled';
}

export interface ExitFill {
  id: string;
  at: number;
  price: number;
  qty: number;
  /** Simulated gross P&L for this closed quantity. */
  pnl: number;
  reason: string;
  /** Receipt ID of the signal that caused it, when applicable. */
  receiptId?: string;
}

/**
 * One simulated entry. Each entry has its own internal ID; this does not imply
 * the exchange would maintain separate positions. Config values are captured at entry.
 */
export interface HoldingPosition {
  id: string;
  subscriberId: string;
  blockId: string;
  mode: TradingMode;
  symbol: string;
  side: PositionSide;
  packageId: string;
  packageName: string;
  receiptId: string;
  signalId: string;
  entryPrice: number;
  originalQty: number;
  remainingQty: number;
  orderCost: number;
  leverage: number;
  marginMode: MarginMode;
  stopLossPct: number;
  stopPrice: number;
  targets: PositionTarget[];
  trailingEnabled: boolean;
  trailingPct: number;
  /** Best favorable price since entry (highest for longs, lowest for shorts). */
  bestPrice: number;
  trailingStop: number | null;
  exits: ExitFill[];
  realizedPnl: number;
  status: 'open' | 'closed';
  openedAt: number;
  closedAt?: number;
  closeReason?: string;
}

export interface SkippedBlock {
  subscriberId: string;
  blockId: string;
  mode: TradingMode;
  reason: string;
  accountId?: string | null;
}

/**
 * Percentage exit rules captured from a token block when the entry filled. Stored on the
 * shared Position record; positions with this field never run the legacy exit-plan engine.
 */
export interface TokenRuntime {
  subscriberId: string;
  blockId: string;
  packageId: string;
  packageName: string;
  receiptId: string;
  signalId: string;
  orderCost: number;
  marginMode: MarginMode;
  originalQty: number;
  stopLossPct: number;
  stopPrice: number;
  targets: PositionTarget[];
  trailingEnabled: boolean;
  trailingPct: number;
  bestPrice: number;
  trailingStop: number | null;
  openedAtMs: number;
  closedAtMs?: number;
  closeReason?: string;
}

/** One row on the Holdings page, built from a shared record (token block, original sample, or migrated). */
export interface HoldingView extends HoldingPosition {
  kind: 'token' | 'legacy' | 'migrated';
  accountId: string | null;
  accountLabel: string;
  /** Recorded commissions for this position (entry + exits). 0 for migrated gross-only records. */
  fees: number;
  currentPrice?: number;
}

/** Persisted once per accepted receipt so replays/refreshes never repeat execution. */
export interface SignalProcessing {
  receiptId: string;
  signalId: string;
  at: number;
  opened: string[];
  closed: string[];
  skipped: SkippedBlock[];
  notes: string[];
}

export interface PricePoint {
  t: number;
  price: number;
}