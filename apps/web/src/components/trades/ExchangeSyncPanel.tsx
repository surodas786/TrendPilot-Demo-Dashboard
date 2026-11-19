'use client';

import { useSyncExternalStore } from 'react';
import { useRouter } from 'next/navigation';
import { RefreshCwIcon } from 'lucide-react';
import { exchangeLabel } from '@trendpilot/domain';
import { Button } from '@/components/ui/Button';
import { request } from '@/lib/api';

export interface DriftItemView {
  kind: string;
  symbol: string;
  detail: string;
}

/** A Live order TrendPilot submitted whose outcome is not established yet. */
export interface UnresolvedOrderView {
  id: string;
  clientOrderId: string;
  label: string;
  state: string;
  createdAt: string;
  lastReconcileAt: string | null;
  /** Last reconciliation note, job error or state reason: the latest known failure reason. */
  reason: string | null;
  /** e.g. "DEAD after 8/8 attempts" */
  job: string | null;
  exchangeOrderId: string | null;
}

const age = (iso: string, now: number) => {
  const m = Math.max(0, Math.floor((now - new Date(iso).getTime()) / 60_000));
  return m < 60 ? `${m} min` : m < 2880 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${Math.floor(m / 1440)} d`;
};

interface SyncResponse {
  exchange: string;
  result: { exchange: string; ok: boolean; busy: boolean; error: string | null; lines: string[]; drift: DriftItemView[] };
}

const driftLabel = (kind: string, venue: string): string =>
  ({
    SIZE_MISMATCH: 'Size differs',
    UNKNOWN_EXPOSURE: `Position on ${venue} not opened by TrendPilot`,
    SIDE_MISMATCH: `Opposite side open on ${venue}`,
    STOP_MISSING: 'Stop does not cover the position',
    STOP_ORPHANED: 'Stop still active after the close',
    POSITION_MODE_CHANGED: `Position mode changed on ${venue}`
  })[kind] ?? kind;

/**
 * Sync state per tab (mode + exchange), outside the component: a sync started on the MEXC tab
 * keeps its spinner and result on the MEXC tab even if the investor switches to Bitunix while it
 * runs, and nothing from one exchange is ever shown on another exchange's tab.
 */
type TabState = { busy: boolean; message: { tone: 'ok' | 'err'; text: string } | null };
const store = new Map<string, TabState>();
const listeners = new Set<() => void>();
const IDLE: TabState = { busy: false, message: null };
const setTab = (key: string, s: TabState) => {
  store.set(key, s);
  for (const l of listeners) l();
};
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

/**
 * "Sync with <exchange>" on My Trades and My Holdings → Live. Posts to
 * /v1/me/live/sync?exchange=<exchange>: the server syncs only the signed-in investor's own
 * connection to THAT exchange (MEXC: private sync; Bitunix: read-only mirror). Read-only towards the
 * exchange. Exchanges without an investor-triggered sync show the reason instead of a button.
 */
export function ExchangeSyncPanel({
  exchange,
  lastSyncOkAt,
  lastSyncAt,
  lastSyncError,
  drift = [],
  timezone,
  unavailableReason = null,
  unresolved = [],
  renderedAt
}: {
  exchange: string;
  lastSyncOkAt: string | null;
  lastSyncAt: string | null;
  lastSyncError: string | null;
  drift?: DriftItemView[];
  timezone: string;
  /** Set when this exchange has no investor-triggered sync: shown instead of the button. */
  unavailableReason?: string | null;
  /** Live orders on this exchange still unresolved (SUBMITTING etc.): shown with the sync health. */
  unresolved?: UnresolvedOrderView[];
  /** Server render time (ms), so ages render the same on server and client. */
  renderedAt?: number;
}) {
  const router = useRouter();
  const venue = exchangeLabel(exchange);
  const key = `LIVE:${exchange}`;
  const tab = useSyncExternalStore(subscribe, () => store.get(key) ?? IDLE, () => IDLE);
  const fmt = (iso: string) => new Date(iso).toLocaleString('en-GB', { timeZone: timezone, dateStyle: 'medium', timeStyle: 'medium' });
  // The stored error belongs to the latest attempt only when that attempt is newer than the last success.
  const failing = !!lastSyncError && !!lastSyncAt && (!lastSyncOkAt || new Date(lastSyncAt) > new Date(lastSyncOkAt));

  async function sync() {
    const origin = key; // the tab this sync belongs to, fixed when it starts
    setTab(origin, { busy: true, message: null });
    const r = await request<SyncResponse>('POST', `/v1/me/live/sync?exchange=${encodeURIComponent(exchange)}`);
    let message: TabState['message'];
    if (!r.ok) message = { tone: 'err', text: r.message };
    else if (r.data.result.exchange !== exchange) message = { tone: 'err', text: `Unexpected answer for ${exchangeLabel(r.data.result.exchange)}; nothing shown for ${venue}.` };
    else if (r.data.result.busy) message = { tone: 'err', text: r.data.result.error ?? `A ${venue} sync is already running.` };
    else if (!r.data.result.ok) message = { tone: 'err', text: `${venue} sync failed: ${r.data.result.error ?? 'unknown error'}. Positions were left unchanged.` };
    else message = { tone: 'ok', text: r.data.result.lines.length ? r.data.result.lines.join(' · ') : `Positions match ${venue}.` };
    setTab(origin, { busy: false, message });
    router.refresh();
  }

  return (
    <section className="space-y-1.5 rounded-xl border border-line bg-surface px-4 py-3 text-sm" data-testid="exchange-sync" data-exchange={exchange} aria-label={`Private ${venue} position sync`}>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        {unavailableReason ? (
          <span className="text-xs text-muted" data-testid="sync-unavailable">
            {unavailableReason}
          </span>
        ) : (
          <Button size="sm" variant="secondary" icon={RefreshCwIcon} loading={tab.busy} onClick={sync} data-testid="sync-with-exchange">
            Sync with {venue}
          </Button>
        )}
        <span className="text-xs text-muted" data-testid="last-sync">
          {venue} private sync — last successful: {lastSyncOkAt ? fmt(lastSyncOkAt) : 'never'}
        </span>
        {failing && (
          <span className="text-xs text-loss" data-testid="sync-error">
            Latest attempt {fmt(lastSyncAt!)} failed: {lastSyncError}
          </span>
        )}
      </div>
      {drift.length > 0 && (
        <ul className="space-y-0.5 text-xs text-loss" data-testid="sync-drift">
          {drift.map((d, i) => (
            <li key={i}>
              {driftLabel(d.kind, venue)} · {d.symbol}: {d.detail}
            </li>
          ))}
        </ul>
      )}
      {tab.message && (
        <p role="status" className={`text-xs ${tab.message.tone === 'ok' ? 'text-muted' : 'text-loss'}`} data-testid="sync-message">
          {tab.message.text}
          {tab.message.tone === 'ok' && unresolved.length > 0 && ` ${unresolved.length} order(s) still unresolved — see below.`}
        </p>
      )}
      {unresolved.length > 0 && (
        <div className="space-y-1 rounded-lg border border-line bg-inset px-3 py-2 text-xs" data-testid="unresolved-orders">
          <p className="font-medium text-loss">
            {unresolved.length} unresolved {venue} submission{unresolved.length === 1 ? '' : 's'}: the outcome is not confirmed yet, and the reservation stays held until {venue} shows whether the order was accepted.
          </p>
          <ul className="space-y-1">
            {unresolved.map((o) => (
              <li key={o.id} data-testid="unresolved-order" data-state={o.state} className="text-muted">
                <span className="text-ink">{o.label}</span> · {o.state} for {age(o.createdAt, renderedAt ?? Date.now())} · last reconciliation {o.lastReconcileAt ? fmt(o.lastReconcileAt) : 'never'}
                {o.job && <> · submit job {o.job}</>}
                {o.exchangeOrderId && (
                  <>
                    {' '}
                    · {venue} order {o.exchangeOrderId}
                  </>
                )}
                {o.reason && <span className="block break-words text-subtle">Reason: {o.reason}</span>}
                <span className="block font-mono text-subtle">clientId {o.clientOrderId}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
