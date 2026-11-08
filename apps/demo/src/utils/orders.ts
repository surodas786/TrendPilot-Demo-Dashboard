import { round2 } from './accountMath';
import type { PendingEntry } from '../types/risk';
import type { OrderPurpose, OrderRecord, OrderState } from '../types/execution';

export const WORKING_STATES: OrderState[] = ['pending-submission', 'submitted', 'partially-filled', 'unknown'];

export const PURPOSE_LABELS: Record<OrderPurpose, string> = {
  entry: 'Entry',
  'stop-loss': 'Stop loss',
  'take-profit': 'Take profit',
  'trailing-exit': 'Trailing exit',
  'manual-close': 'Manual close'
};

export const STATE_LABELS: Record<OrderState, string> = {
  'pending-submission': 'Pending submission',
  submitted: 'Submitted',
  'partially-filled': 'Partially filled',
  filled: 'Filled',
  rejected: 'Rejected',
  cancelled: 'Cancelled',
  expired: 'Expired',
  unknown: 'Unknown'
};

export function isWorking(o: OrderRecord): boolean {
  return WORKING_STATES.includes(o.state);
}

export function roundQty(value: number, decimals: number): number {
  return Number(value.toFixed(decimals));
}

export function remainingQty(o: OrderRecord): number {
  return roundQty(Math.max(0, o.requestedQty - o.filledQty), o.quantityDecimals);
}

/** Protective exits: never cancellable on their own. */
export function isProtective(o: OrderRecord): boolean {
  return o.purpose === 'stop-loss' || o.purpose === 'take-profit' || o.purpose === 'trailing-exit';
}

/** The confirmed, resting stop for a position (submitted and untriggered). */
export function workingStop(orders: OrderRecord[], positionId: string): OrderRecord | undefined {
  return orders.find(
    (o) => o.positionId === positionId && (o.purpose === 'stop-loss' || o.purpose === 'trailing-exit') && (o.state === 'submitted' || o.state === 'partially-filled')
  );
}

export function accountWorkingOrders(orders: OrderRecord[], accountId: string): OrderRecord[] {
  return orders.filter((o) => o.accountId === accountId && isWorking(o));
}

/** Margin reserved by the unfilled part of working entry orders. */
export function reservedMarginFor(orders: OrderRecord[], accountId: string): number {
  return round2(
    orders.
    filter((o) => o.accountId === accountId && o.purpose === 'entry' && isWorking(o) && o.price !== null && o.leverage).
    reduce((acc, o) => acc + remainingQty(o) * (o.price as number) / (o.leverage as number), 0)
  );
}

/** Working entry orders expressed as pending entries for the risk engine. */
export function pendingEntriesFromOrders(orders: OrderRecord[], accountId: string): PendingEntry[] {
  return orders.
  filter((o) => o.accountId === accountId && o.purpose === 'entry' && isWorking(o) && o.price !== null && o.leverage).
  map((o) => {
    const notional = round2(remainingQty(o) * (o.price as number));
    return {
      id: o.id,
      accountId: o.accountId,
      pair: o.pair,
      direction: o.side === 'Buy' ? 'long' : 'short',
      orderCost: round2(notional / (o.leverage as number)),
      leverage: o.leverage as number,
      notional,
      stopRisk: o.stopRisk === undefined ? null : o.stopRisk,
      marginReserved: true
    };
  });
}

type OrderInit = Omit<OrderRecord, 'filledQty' | 'fills' | 'updatedAt' | 'triggerState' | 'reduceOnly' | 'triggerBasis'> &
Partial<Pick<OrderRecord, 'filledQty' | 'fills' | 'updatedAt' | 'triggerState' | 'reduceOnly' | 'triggerBasis'>>;

export function makeOrder(init: OrderInit): OrderRecord {
  const conditional = init.purpose === 'stop-loss' || init.purpose === 'trailing-exit';
  return {
    filledQty: 0,
    fills: [],
    updatedAt: init.createdAt,
    triggerState: conditional ? 'untriggered' : null,
    reduceOnly: init.purpose !== 'entry',
    triggerBasis: conditional ? 'Mark price' : null,
    ...init
  };
}