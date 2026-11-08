import { connectionHealth } from './connectionHealth';
import { isWorking, remainingQty, workingStop } from './orders';
import type { ManagedProtection, OrderRecord } from '../types/execution';
import type { DemoAccount, Position } from '../types/trading';

export interface ProtectionInfo {
  status: ManagedProtection;
  label: string;
  note: string;
}

export const PROTECTION_LABELS: Record<ManagedProtection, string> = {
  confirmed: 'Protection confirmed',
  pending: 'Protection pending',
  failed: 'Protection failed',
  unknown: 'Status unknown',
  closed: 'Closed',
  unmanaged: 'Unmanaged'
};

/**
 * Protection derived only from simulated protective-order records and the account's
 * connection health. "Protection confirmed" requires a resting stop record.
 */
export function protectionInfo(p: Position | null, account: DemoAccount | undefined, orders: OrderRecord[]): ProtectionInfo {
  const info = (status: ManagedProtection, note: string): ProtectionInfo => ({ status, label: PROTECTION_LABELS[status], note });
  if (!p) return info('closed', 'Position fully closed · obsolete exit orders cancelled');
  if (p.managed === false) return info('unmanaged', 'Opened outside a managed strategy · no TrendPilot exit plan');

  if (account && !account.disconnected) {
    const h = connectionHealth(account);
    if (h.credentials === 'failed') return info('unknown', 'Credentials rejected — protective orders cannot be read.');
    if (account.scenario === 'exchange-unavailable') return info('unknown', 'Exchange unavailable — last known orders cannot be confirmed.');
    if (h.privateFeed === 'failed') return info('unknown', 'Private feed unavailable — order status cannot be confirmed.');
    if (h.sync === 'failed') return info('unknown', 'Synchronization failed — protective orders not reconciled.');
  }
  if (account?.disconnected) return info('unknown', 'Connection disconnected — order status cannot be confirmed.');

  const stop = workingStop(orders, p.id);
  const linked = orders.filter((o) => o.positionId === p.id && (o.purpose === 'stop-loss' || o.purpose === 'trailing-exit'));
  if (stop) {
    const permissionNote =
    account?.scenario === 'missing-trade-permission' ?
    ' Stops cannot be amended without trade permission.' :
    account?.scenario === 'public-feed-down' ?
    ' Public feed unavailable — trailing and price monitoring paused.' :
    '';
    return info('confirmed', `Stop ${stop.id} resting for ${remainingQty(stop)} ${p.baseAsset} (simulated).${permissionNote}`);
  }
  if (linked.some((o) => o.state === 'pending-submission' || o.state === 'unknown')) return info('pending', 'A protective stop is awaiting simulated confirmation.');
  if (linked.some((o) => o.state === 'rejected')) return info('failed', 'The protective stop was rejected — no resting stop. Close or replace protection.');
  if (linked.length === 0) return info('failed', 'No protective stop record exists for this position.');
  return info('failed', 'No working protective stop.');
}

export function needsAttention(info: ProtectionInfo): boolean {
  return info.status !== 'confirmed' && info.status !== 'closed';
}

export function workingProtectiveCount(orders: OrderRecord[], positionId: string): number {
  return orders.filter((o) => o.positionId === positionId && o.purpose !== 'entry' && isWorking(o)).length;
}