import { ownerOf } from '../data/demoUsers';
import { dayTimeToMs } from './clock';
import { PURPOSE_LABELS } from './orders';
import type { DemoState } from '../contexts/demoReducer';

export type LogTab = 'trading' | 'operational' | 'audit';
export type LogSeverity = 'info' | 'warning' | 'critical';
export type LogOutcome = 'success' | 'failure' | 'info' | 'skipped';

export interface LogEvent {
  id: string;
  tab: LogTab;
  at: number;
  accountId: string | null;
  pair: string | null;
  severity: LogSeverity;
  type: string;
  outcome: LogOutcome;
  title: string;
  detail: string;
  refs: string[];
  link?: {to: string;label: string;positionId?: string;};
  operator?: string;
  scope?: string;
  previous?: string;
  next?: string;
  reason?: string;
}

const ACTIVITY_TYPE: Record<string, string> = {
  entry: 'Fill',
  protection: 'Protection change',
  'take-profit': 'Exit',
  exit: 'Exit',
  'stop-loss': 'Exit',
  skip: 'Risk decision',
  reject: 'Risk decision',
  trailing: 'Protection change',
  close: 'Exit'
};

/** Read-only log view derived from shared records. Never includes credential values. */
export function buildLogEvents(state: DemoState, opts: {userId: string;admin: boolean;}): LogEvent[] {
  const owned = new Set(state.accounts.filter((a) => opts.admin || ownerOf(a) === opts.userId).map((a) => a.id));
  const userName = (accountId: string | null) => state.users.find((u) => u.id === ownerOf(state.accounts.find((a) => a.id === accountId)))?.name ?? 'Demo trader';
  const out: LogEvent[] = [];

  state.activity.
  filter((e) => owned.has(e.accountId)).
  forEach((e) => {
    const failure = e.kind === 'reject' || /fail|critical|unprotected/i.test(e.title);
    out.push({ id: `act:${e.id}`, tab: 'trading', at: dayTimeToMs(e.time), accountId: e.accountId, pair: e.pair, severity: /critical|unprotected|rejected/i.test(e.title) ? 'critical' : failure ? 'warning' : 'info', type: /recovery/i.test(e.title + e.detail) ? 'Recovery action' : ACTIVITY_TYPE[e.kind] ?? 'Event', outcome: e.kind === 'skip' ? 'skipped' : failure ? 'failure' : 'success', title: e.title, detail: e.detail, refs: [e.id, e.positionId ?? ''].filter(Boolean), link: e.positionId ? { to: '/positions-orders', label: 'View position', positionId: e.positionId } : undefined });
  });

  state.signals.
  filter((s) => owned.has(s.accountId)).
  forEach((s) =>
  out.push({ id: `sig:${s.id}`, tab: 'trading', at: s.at ?? dayTimeToMs(s.receivedAt), accountId: s.accountId, pair: s.pair, severity: s.deliveryState === 'failed' || s.deliveryState === 'unknown' ? 'warning' : 'info', type: 'Signal evaluation', outcome: s.result === 'executed' ? 'success' : s.result === 'skipped' ? 'skipped' : 'failure', title: `${s.action} · ${s.result}`, detail: s.reason, refs: [s.id, s.centralId ?? ''].filter(Boolean), link: { to: '/signals', label: 'Open signals' } })
  );

  state.orders.
  filter((o) => owned.has(o.accountId)).
  forEach((o) => {
    out.push({ id: `ord:${o.id}`, tab: 'trading', at: o.createdAt, accountId: o.accountId, pair: o.pair, severity: o.state === 'rejected' ? 'warning' : 'info', type: 'Order submission', outcome: o.state === 'rejected' ? 'failure' : 'success', title: `${PURPOSE_LABELS[o.purpose]} order ${o.side}`, detail: `${o.id} · ${o.type} · ${o.requestedQty} ${o.baseAsset}${o.note ? ` · ${o.note}` : ''}`, refs: [o.id, o.positionId ?? ''].filter(Boolean), link: o.positionId ? { to: '/positions-orders?tab=orders', label: 'View orders', positionId: o.positionId } : { to: '/positions-orders?tab=orders', label: 'View orders' } });
    o.fills.forEach((f) => out.push({ id: `fill:${f.id}`, tab: 'trading', at: f.at, accountId: o.accountId, pair: o.pair, severity: 'info', type: 'Fill', outcome: 'success', title: `${PURPOSE_LABELS[o.purpose]} fill`, detail: `${f.quantity} ${o.baseAsset} @ ${f.price}${f.fee !== null ? ` · fee ${f.fee}` : ''}`, refs: [f.id, o.id, o.positionId ?? ''].filter(Boolean), link: o.positionId ? { to: '/positions-orders', label: 'View position', positionId: o.positionId } : undefined }));
    if (o.state === 'unknown') out.push({ id: `unk:${o.id}`, tab: 'operational', at: o.updatedAt ?? o.createdAt, accountId: o.accountId, pair: o.pair, severity: 'critical', type: 'Unknown order result', outcome: 'failure', title: 'Order outcome unknown', detail: `${o.id} · reconcile before any retry`, refs: [o.id], link: { to: '/positions-orders?tab=orders', label: 'Reconcile' } });
  });

  state.connectionEvents.
  filter((e) => owned.has(e.accountId)).
  forEach((e) => {
    const config = /preferences|credential|disconnected|virtual funds|connection created|paused|resumed/i.test(e.action);
    if (config) out.push({ id: `cfg:${e.id}`, tab: 'audit', at: e.at, accountId: e.accountId, pair: null, severity: 'info', type: 'Connection configuration', outcome: e.outcome, title: e.action, detail: e.detail, refs: [e.id], operator: userName(e.accountId), scope: 'Account', link: { to: '/exchange-connections', label: 'Open connection' } });else
    if (e.outcome === 'failure' || /scenario|feed|stale|sync/i.test(e.action))
    out.push({ id: `ops:${e.id}`, tab: 'operational', at: e.at, accountId: e.accountId, pair: null, severity: e.outcome === 'failure' ? 'warning' : 'info', type: /sync/i.test(e.action) ? 'Synchronization' : /feed|scenario/i.test(e.action) ? 'Feed or connection' : 'Connection event', outcome: e.outcome, title: e.action, detail: e.detail, refs: [e.id], link: { to: /sync/i.test(e.action) ? '/funds-funding?tab=sync' : '/exchange-connections', label: 'Open' } });
  });

  state.discrepancies.
  filter((d) => owned.has(d.accountId)).
  forEach((d) => out.push({ id: `dif:${d.id}`, tab: 'operational', at: d.foundAt, accountId: d.accountId, pair: null, severity: 'warning', type: 'Reconciliation difference', outcome: d.status === 'open' ? 'failure' : 'success', title: `Difference ${(d.source - d.local).toFixed(2)} USDT`, detail: `${d.label} · local ${d.local} vs source ${d.source} · ${d.status}`, refs: [d.id, d.correctionId ?? ''].filter(Boolean), link: { to: '/funds-funding?tab=sync', label: 'Inspect' } }));

  state.auditLog.
  filter((e) => e.accountId === null || owned.has(e.accountId)).
  forEach((e) => out.push({ id: `aud:${e.id}`, tab: 'audit', at: e.at, accountId: e.accountId, pair: null, severity: e.outcome === 'failure' ? 'warning' : 'info', type: `Configuration · ${e.category}`, outcome: e.outcome, title: e.action, detail: e.detail, refs: [e.id, e.subscriptionId ?? ''].filter(Boolean), operator: e.accountId ? userName(e.accountId) : 'Demo trader', scope: e.subscriptionId ? 'Subscription' : e.accountId ? 'Account' : 'Workspace', link: { to: e.category === 'exit-plan' ? '/exit-settings' : e.category === 'subscription' ? '/strategies' : e.category === 'execution' ? '/positions-orders' : '/trading-risk', label: 'Open settings' } }));

  const myName = state.users.find((u) => u.id === opts.userId)?.name;
  state.adminLog.
  filter((e) => opts.admin || e.target === myName || e.target === 'All demo users').
  forEach((e) => out.push({ id: `adm:${e.id}`, tab: 'audit', at: e.at, accountId: null, pair: null, severity: 'info', type: 'Administrator action', outcome: 'info', title: e.action, detail: e.target, refs: [e.id], operator: e.operator, scope: e.target, previous: e.previous, next: e.next }));

  return out.sort((a, b) => b.at - a.at || a.id.localeCompare(b.id));
}