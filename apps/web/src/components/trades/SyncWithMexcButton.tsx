'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { RefreshCwIcon } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { request } from '@/lib/api';

interface SyncResult {
  sync: {
    ok: boolean;
    busy?: boolean;
    error?: string;
    exitsRecorded: number;
    closes: { symbol: string; result: 'FULL' | 'FULL_FILLS_PENDING' | 'FILLS_BACKFILLED' | 'PARTIAL' | 'FILLS_PENDING'; platformContracts: string; exchangeContracts: string; stopCoverage?: string; stopContracts?: string | null; pendingContracts?: string }[];
    skipped: { symbol: string; reason: string }[];
    drift: { kind: string; symbol: string; detail: string }[];
  };
}

export interface DriftItemView {
  kind: string;
  symbol: string;
  detail: string;
}

const DRIFT_LABEL: Record<string, string> = {
  SIZE_MISMATCH: 'Size differs',
  UNKNOWN_EXPOSURE: 'Position on MEXC not opened by TrendPilot',
  SIDE_MISMATCH: 'Opposite side open on MEXC',
  STOP_MISSING: 'Stop does not cover the position',
  STOP_ORPHANED: 'Stop still active after the close'
};

function summary(s: SyncResult['sync']): string {
  const parts: string[] = [];
  for (const c of s.closes) {
    if (c.result === 'FULL') parts.push(`${c.symbol}: closed on MEXC — moved to closed positions`);
    else if (c.result === 'FULL_FILLS_PENDING') parts.push(`${c.symbol}: closed on MEXC — moved to closed positions · fill details pending${c.pendingContracts ? ` (${c.pendingContracts} contracts)` : ''}`);
    else if (c.result === 'FILLS_BACKFILLED') parts.push(`${c.symbol}: exit price, fees and P&L filled in from MEXC`);
    else if (c.result === 'PARTIAL')
      parts.push(`${c.symbol}: ${c.platformContracts} contracts remain; stop ${c.stopCoverage === 'FULL' ? `covers them (${c.stopContracts})` : c.stopCoverage === 'PARTIAL' ? `covers only ${c.stopContracts}` : 'does not cover them'}`);
    else parts.push(`${c.symbol}: ${c.exchangeContracts === '0' ? 'closed on MEXC' : `MEXC holds ${c.exchangeContracts}`} · fill details pending`);
  }
  for (const k of s.skipped) parts.push(`${k.symbol}: not reconciled yet (${k.reason})`);
  return parts.length ? parts.join(' · ') : 'TrendPilot matches MEXC.';
}

/**
 * "Sync with MEXC" (My Holdings and My Trades → Live): runs the private sync for the signed-in
 * investor's own account and refreshes the page. Read-only towards MEXC: no order is placed,
 * cancelled or retried. Shows the private position sync — separate from public price freshness —
 * with the last successful run, the latest error, and any remaining drift with its reason.
 */
export function SyncWithMexcButton({
  lastSyncOkAt,
  lastSyncAt,
  lastSyncError,
  drift = [],
  timezone
}: {
  lastSyncOkAt: string | null;
  lastSyncAt: string | null;
  lastSyncError: string | null;
  drift?: DriftItemView[];
  timezone: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null);
  const fmt = (iso: string) => new Date(iso).toLocaleString('en-GB', { timeZone: timezone, dateStyle: 'medium', timeStyle: 'medium' });
  // The stored error belongs to the latest attempt only when that attempt is newer than the last success.
  const failing = !!lastSyncError && !!lastSyncAt && (!lastSyncOkAt || new Date(lastSyncAt) > new Date(lastSyncOkAt));

  async function sync() {
    setBusy(true);
    const r = await request<SyncResult>('POST', '/v1/me/live/sync');
    setBusy(false);
    if (!r.ok) setMessage({ tone: 'err', text: r.message });
    else if (r.data.sync.busy) setMessage({ tone: 'err', text: r.data.sync.error ?? 'A sync is already running.' });
    else if (!r.data.sync.ok) setMessage({ tone: 'err', text: `Sync failed: ${r.data.sync.error ?? 'unknown error'}. Positions were left unchanged.` });
    else setMessage({ tone: 'ok', text: summary(r.data.sync) });
    router.refresh();
  }

  return (
    <section className="space-y-1.5 rounded-xl border border-line bg-surface px-4 py-3 text-sm" data-testid="mexc-sync" aria-label="Private MEXC position sync">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <Button size="sm" variant="secondary" icon={RefreshCwIcon} loading={busy} onClick={sync} data-testid="sync-with-mexc">
          Sync with MEXC
        </Button>
        <span className="text-xs text-muted" data-testid="last-sync">
          Private position sync — last successful: {lastSyncOkAt ? fmt(lastSyncOkAt) : 'never'}
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
              {DRIFT_LABEL[d.kind] ?? d.kind} · {d.symbol}: {d.detail}
            </li>
          ))}
        </ul>
      )}
      {message && (
        <p role="status" className={`text-xs ${message.tone === 'ok' ? 'text-muted' : 'text-loss'}`} data-testid="sync-message">
          {message.text}
        </p>
      )}
    </section>
  );
}
