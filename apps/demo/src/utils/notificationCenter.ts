import { CRITICAL_CATEGORIES } from '../data/financeConfig';
import { prefsFor, streamsFor } from '../contexts/financeReducer';
import { effectiveAt } from './ledger';
import { protectionInfo } from './protection';
import type { DemoState } from '../contexts/demoReducer';
import type { NotificationCategory, NotificationSeverity } from '../types/finance';

export type EmailState = 'Queued' | 'Delivered in simulation' | 'Failed in simulation';

export interface NotificationGroup {
  key: string;
  category: NotificationCategory;
  severity: NotificationSeverity;
  title: string;
  detail: string;
  accountId: string | null;
  link: {to: string;label: string;positionId?: string;};
  occurrences: number[];
  firstAt: number;
  lastAt: number;
  /** Issue status is independent of read status. */
  issue: 'open' | 'resolved' | 'none';
  read: boolean;
  visible: boolean;
  email: EmailState | null;
}

type Draft = Omit<NotificationGroup, 'firstAt' | 'lastAt' | 'read' | 'visible' | 'email'>;

/**
 * Notification groups derived from shared records (grouped by account, event type and related record).
 * Derived, not stored — re-rendering or navigating can never create duplicates.
 */
export function buildNotificationGroups(state: DemoState, userId: string, dailyLossBlocked: Record<string, boolean>, now: number): NotificationGroup[] {
  const accounts = state.accounts.filter((a) => (a.userId ?? 'user-1') === userId);
  const ids = new Set(accounts.map((a) => a.id));
  const name = (id: string) => state.accounts.find((a) => a.id === id)?.name ?? id;
  const drafts = new Map<string, Draft>();
  const add = (d: Draft, at: number) => {
    const cur = drafts.get(d.key);
    if (cur) cur.occurrences.push(at);else
    drafts.set(d.key, { ...d, occurrences: [at] });
  };

  state.orders.
  filter((o) => ids.has(o.accountId) && o.purpose === 'entry').
  forEach((o) => o.fills.forEach((f) => add({ key: `fill-entry:${o.id}`, category: 'fills', severity: 'info', title: 'Entry filled', detail: `${o.pair} ${o.side} · ${name(o.accountId)} · order ${o.id}`, accountId: o.accountId, link: { to: '/positions-orders', label: 'View position', positionId: o.positionId ?? undefined }, occurrences: [], issue: 'none' }, f.at)));

  state.closedTrades.
  filter((t) => ids.has(t.accountId) && (t.kind === 'partial' || t.kind === 'final') && t.positionId).
  forEach((t) => add({ key: `fill-exit:${t.positionId}`, category: 'fills', severity: 'info', title: 'Exit filled', detail: `${t.pair} · ${name(t.accountId)} · position ${t.positionId}`, accountId: t.accountId, link: { to: '/trade-history', label: 'View trade', positionId: t.positionId }, occurrences: [], issue: 'none' }, effectiveAt(t)));

  state.signals.
  filter((s) => ids.has(s.accountId) && (s.result === 'rejected' || s.deliveryState === 'failed' || s.deliveryState === 'unknown')).
  forEach((s) => add({ key: `signal:${s.accountId}:${s.centralId ?? s.id}`, category: 'signals', severity: 'warning', title: s.deliveryState === 'unknown' ? 'Signal outcome unknown' : s.deliveryState === 'failed' ? 'Account evaluation failed' : 'Signal rejected', detail: `${s.action} ${s.pair} · ${name(s.accountId)} · ${s.reason}`, accountId: s.accountId, link: { to: '/signals', label: 'Open signal' }, occurrences: [], issue: 'none' }, s.at ?? state.lastRefreshAt));

  // Protection: rejected stops and currently failed/unknown protection.
  state.orders.
  filter((o) => ids.has(o.accountId) && o.purpose === 'stop-loss' && o.state === 'rejected' && o.positionId).
  forEach((o) => {
    const p = state.positions.find((x) => x.id === o.positionId);
    const info = p ? protectionInfo(p, state.accounts.find((a) => a.id === p.accountId), state.orders) : null;
    const open = Boolean(info && (info.status === 'failed' || info.status === 'unknown'));
    add({ key: `protection:${o.positionId}`, category: 'protection', severity: 'critical', title: open ? 'Protection failed — exposure unresolved' : 'Protection failed', detail: `${o.pair} · ${name(o.accountId)} · ${open ? info?.note : 'Position no longer exposed'}`, accountId: o.accountId, link: { to: '/positions-orders', label: open ? 'Resolve exposure' : 'View records', positionId: o.positionId ?? undefined }, occurrences: [], issue: open ? 'open' : 'resolved' }, o.updatedAt ?? o.createdAt);
  });
  state.positions.
  filter((p) => ids.has(p.accountId) && p.managed !== false && !drafts.has(`protection:${p.id}`)).
  forEach((p) => {
    const info = protectionInfo(p, state.accounts.find((a) => a.id === p.accountId), state.orders);
    if (info.status === 'failed' || info.status === 'unknown')
    add({ key: `protection:${p.id}`, category: 'protection', severity: 'critical', title: 'Protection not confirmed', detail: `${p.pair} · ${name(p.accountId)} · ${info.note}`, accountId: p.accountId, link: { to: '/positions-orders', label: 'Resolve exposure', positionId: p.id }, occurrences: [], issue: 'open' }, state.lastRefreshAt);
  });

  accounts.forEach((a) => {
    const events = state.connectionEvents.filter((e) => e.accountId === a.id);
    const lastEventAt = events.reduce((m, e) => Math.max(m, e.at), a.createdAt);
    if (dailyLossBlocked[a.id]) {
      const lastLoss = state.closedTrades.filter((t) => t.accountId === a.id).reduce((m, t) => Math.max(m, effectiveAt(t)), a.createdAt);
      add({ key: `risk:${a.id}:daily-loss`, category: 'risk', severity: 'warning', title: 'Daily loss limit reached', detail: `${a.name} · new entries blocked until the next reporting day`, accountId: a.id, link: { to: '/trading-risk', label: 'Open risk settings' }, occurrences: [], issue: 'open' }, lastLoss);
    }
    if (a.disconnected) add({ key: `connection:${a.id}:disconnected`, category: 'connection', severity: 'warning', title: 'Account disconnected', detail: `${a.name} · feeds stopped`, accountId: a.id, link: { to: '/exchange-connections', label: 'Open connection' }, occurrences: [], issue: 'open' }, lastEventAt);else
    if (a.scenario === 'public-feed-down' || a.scenario === 'private-feed-down' || a.scenario === 'exchange-unavailable')
    add({ key: `connection:${a.id}:${a.scenario}`, category: 'connection', severity: 'warning', title: a.scenario === 'public-feed-down' ? 'Public market feed stale' : a.scenario === 'private-feed-down' ? 'Private account feed stale' : 'Exchange unavailable (simulated)', detail: a.name, accountId: a.id, link: { to: '/exchange-connections', label: 'Open connection' }, occurrences: [], issue: 'open' }, lastEventAt);else
    if (a.scenario === 'invalid-credentials' || a.scenario === 'missing-trade-permission')
    add({ key: `connection:${a.id}:${a.scenario}`, category: 'connection', severity: 'warning', title: a.scenario === 'invalid-credentials' ? 'Credentials invalid' : 'Trade permission missing', detail: `${a.name} · replace the simulated credentials`, accountId: a.id, link: { to: '/exchange-connections', label: 'Open connection' }, occurrences: [], issue: 'open' }, lastEventAt);
    const syncFails = events.filter((e) => e.action === 'Synchronization failed');
    if (syncFails.length) {
      const failing = streamsFor(state, a.id).balances.status === 'failed' || a.lastSyncAttempt?.ok === false;
      syncFails.forEach((e) => add({ key: `sync:${a.id}`, category: 'sync', severity: 'warning', title: 'Synchronization failed', detail: `${a.name} · ${e.detail}`, accountId: a.id, link: { to: '/funds-funding?tab=sync', label: 'Open synchronization' }, occurrences: [], issue: failing ? 'open' : 'resolved' }, e.at));
    }
  });

  state.discrepancies.
  filter((d) => ids.has(d.accountId)).
  forEach((d) => add({ key: `recon:${d.id}`, category: 'reconciliation', severity: 'warning', title: 'Reconciliation difference found', detail: `${name(d.accountId)} · ${d.label} · local ${d.local.toFixed(2)} vs source ${d.source.toFixed(2)} USDT`, accountId: d.accountId, link: { to: '/funds-funding?tab=sync', label: 'Inspect difference' }, occurrences: [], issue: d.status === 'open' ? 'open' : 'resolved' }, d.foundAt));

  state.testNotifications.
  filter((t) => t.userId === userId).
  forEach((t) => add({ key: `test:${t.id}`, category: t.category, severity: t.category === 'protection' ? 'critical' : 'info', title: t.title, detail: 'Test notification — no underlying issue', accountId: t.accountId, link: { to: '/settings', label: 'Notification settings' }, occurrences: [], issue: 'none' }, t.at));

  const prefs = prefsFor(state, userId);
  return [...drafts.values()].
  map((d) => {
    const occ = [...d.occurrences].sort((a, b) => a - b);
    const lastAt = occ[occ.length - 1];
    const failed = state.emailFailWindows.some((w) => lastAt >= w.from && (w.to === null || lastAt < w.to));
    return {
      ...d,
      occurrences: occ,
      firstAt: occ[0],
      lastAt,
      read: (state.notificationReads[d.key] ?? -1) >= lastAt,
      visible: prefs.inApp[d.category] || CRITICAL_CATEGORIES.includes(d.category) || d.issue === 'open' && d.severity === 'critical',
      email: prefs.email[d.category] ? failed ? 'Failed in simulation' : now - lastAt < 5000 ? 'Queued' : 'Delivered in simulation' : null
    } as NotificationGroup;
  }).
  sort((a, b) => b.lastAt - a.lastAt);
}