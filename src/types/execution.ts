import type { Direction, Position } from './trading';

export type OrderPurpose = 'entry' | 'stop-loss' | 'take-profit' | 'trailing-exit' | 'manual-close';
export type OrderState = 'pending-submission' | 'submitted' | 'partially-filled' | 'filled' | 'rejected' | 'cancelled' | 'expired' | 'unknown';
/** Conditional trigger state, tracked separately from execution state. */
export type TriggerState = 'untriggered' | 'triggered';

export interface OrderFill {
  id: string;
  at: number;
  price: number;
  quantity: number;
  /** null = fee not recorded in this demo. */
  fee: number | null;
}

/** Simulated order record. Protection status is derived only from these records. */
export interface OrderRecord {
  id: string;
  accountId: string;
  positionId: string | null;
  pair: string;
  baseAsset: string;
  purpose: OrderPurpose;
  side: 'Buy' | 'Sell';
  type: string;
  requestedQty: number;
  filledQty: number;
  /** Limit price, trigger price or (for market closes) the simulated reference price. */
  price: number | null;
  triggerBasis: string | null;
  reduceOnly: boolean;
  state: OrderState;
  triggerState: TriggerState | null;
  createdAt: number;
  updatedAt: number;
  priceDecimals: number;
  quantityDecimals: number;
  fills: OrderFill[];
  note?: string;
  /** Fixture/seed records: submission events were not itemized, so timelines do not invent them. */
  seeded?: boolean;
  /** Entry orders only: leverage used to reserve margin for the unfilled part. */
  leverage?: number;
  /** Entry orders only: planned initial stop risk. null = unknown (never treated as zero). */
  stopRisk?: number | null;
  closeRequestId?: string;
  /** Deterministic outcome a later reconciliation reveals (unknown orders only). */
  reconcileFillPrice?: number;
  /** Entry orders created by a signal delivery. */
  signalContext?: import('./signals').SignalOrderContext;
}

export type CloseItemState = 'requested' | 'submitted' | 'partially-filled' | 'filled' | 'failed' | 'unknown';

export interface CloseRequestItem {
  positionId: string;
  pair: string;
  direction: Direction;
  requestedQty: number;
  filledQty: number;
  fillPrice: number | null;
  referencePrice: number;
  remainingQty: number;
  state: CloseItemState;
  /** States the item passed through, in order. */
  trail: CloseItemState[];
  reason?: string;
  orderId: string | null;
  quantityDecimals: number;
  priceDecimals: number;
  baseAsset: string;
}

export interface CloseRequest {
  id: string;
  accountId: string;
  kind: 'full' | 'partial' | 'all';
  at: number;
  items: CloseRequestItem[];
}

/** One record for a complete position lifecycle, including its partial exits. */
export interface TradeRecord {
  id: string;
  accountId: string;
  exchangeId: string;
  positionId: string;
  pair: string;
  baseAsset: string;
  direction: Direction;
  strategyId: string;
  strategyVersion: string | null;
  entryTime: string;
  exitAt: number;
  avgEntry: number;
  avgExit: number;
  originalQty: number;
  gross: number;
  commissions: number;
  fundingReceived: number;
  fundingPaid: number;
  net: number;
  exitReason: string;
  priceDecimals: number;
  quantityDecimals: number;
  /** Position immediately before the final closing fill (read-only detail view). */
  snapshot: Position;
}

export type CloseBehavior = 'fill' | 'partial-then-cancel' | 'reject' | 'unknown';

export type FixtureId = 'full-close' | 'partial-close' | 'partial-cancel' | 'close-rejected' | 'close-unknown' | 'protection-failed' | 'external';

/** Deterministic simulation behaviour for one account, set by demo fixtures. */
export interface AccountSim {
  closeBehavior: CloseBehavior;
  /** Per-position overrides so close-all can produce mixed results. */
  behaviorByPosition: Record<string, CloseBehavior>;
  protectionReplace: 'confirm' | 'fail';
  fixture: FixtureId | null;
}

export type ManagedProtection = 'confirmed' | 'pending' | 'failed' | 'unknown' | 'closed' | 'unmanaged';