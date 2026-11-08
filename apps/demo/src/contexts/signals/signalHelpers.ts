import { formatClock } from '../../utils/clock';
import { ownerOf } from '../../data/demoUsers';
import type { DemoState } from '../demoReducer';
import type { CentralSignal, Delivery, DeliveryState } from '../../types/signals';
import type { ActivityEvent, NotificationItem, SignalResult } from '../../types/trading';

let seq = 0;
export function nextSignalId(prefix: string, at: number): string {
  seq += 1;
  return `${prefix}-${at.toString(36).slice(-5).toUpperCase()}${seq}`;
}

export function makeActivity(
base: {accountId: string;strategyId: string;pair: string;positionId?: string;},
at: number,
kind: ActivityEvent['kind'],
title: string,
detail: string)
: ActivityEvent {
  return { id: nextSignalId('act', at), kind, title, detail, accountId: base.accountId, strategyId: base.strategyId, pair: base.pair, time: formatClock(at), positionId: base.positionId };
}

export function makeNotification(state: DemoState, accountId: string, at: number, title: string, detail: string, tone: NotificationItem['tone']): NotificationItem {
  const userId = ownerOf(state.accounts.find((a) => a.id === accountId));
  return { id: nextSignalId('ntf', at), title, detail, time: formatClock(at), read: false, tone, userId };
}

export function resultFor(state: DeliveryState): SignalResult {
  if (state === 'executed' || state === 'partially-filled' || state === 'submitted') return 'executed';
  if (state === 'skipped' || state === 'pending' || state === 'evaluating') return 'skipped';
  return 'rejected';
}

export const DELIVERY_LABELS: Record<DeliveryState, string> = {
  pending: 'Pending',
  evaluating: 'Evaluating',
  skipped: 'Skipped',
  rejected: 'Rejected',
  submitted: 'Submitted',
  'partially-filled': 'Partially filled',
  executed: 'Executed',
  failed: 'Failed',
  unknown: 'Outcome unknown'
};

/** Updates one delivery and its per-account signal record together. */
export function patchDelivery(state: DemoState, centralId: string, deliveryId: string, patch: Partial<Delivery>): DemoState {
  let updated: Delivery | undefined;
  const centralSignals: CentralSignal[] = state.centralSignals.map((c) =>
  c.id !== centralId ?
  c :
  {
    ...c,
    deliveries: c.deliveries.map((d) => {
      if (d.id !== deliveryId) return d;
      updated = { ...d, ...patch };
      return updated;
    })
  }
  );
  if (!updated) return state;
  const u = updated;
  return {
    ...state,
    centralSignals,
    signals: state.signals.map((r) =>
    r.centralId === centralId && r.accountId === u.accountId ? { ...r, deliveryState: u.state, result: resultFor(u.state), reason: u.reason, link: u.link } : r
    )
  };
}

export function findDelivery(state: DemoState, centralId: string, deliveryId: string): Delivery | undefined {
  return state.centralSignals.find((c) => c.id === centralId)?.deliveries.find((d) => d.id === deliveryId);
}