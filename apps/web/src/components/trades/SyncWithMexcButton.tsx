'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { RefreshCwIcon } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { request } from '@/lib/api';

interface SyncResult {
  sync: {
    ok: boolean;
    error?: string;
    exitsRecorded: number;
    closes: { symbol: string; result: 'FULL' | 'PARTIAL' | 'FILLS_PENDING'; platformContracts: string; exchangeContracts: string; stopCoverage?: string }[];
    skipped: { symbol: string; reason: string }[];
    drift: { kind: string; symbol: string }[];
  };
}

function summary(s: SyncResult['sync']): string {
  const parts: string[] = [];
  for (const c of s.closes) {
    if (c.result === 'FULL') parts.push(`${c.symbol}: closed on MEXC, moved to closed trades`);
    else if (c.result === 'PARTIAL') parts.push(`${c.symbol}: reduced on MEXC to ${c.platformContracts} contracts, stop ${c.stopCoverage === 'FULL' ? 'covers it' : c.stopCoverage === 'PARTIAL' ? 'covers only part of it' : 'does not cover it'}`);
    else parts.push(`${c.symbol}: MEXC confirms ${c.exchangeContracts === '0' ? 'closed' : `${c.exchangeContracts} contracts left`}; fill details pending`);
  }
  for (const k of s.skipped) parts.push(`${k.symbol}: not reconciled (${k.reason})`);
  return parts.length ? parts.join(' · ') : 'Up to date with MEXC.';
}

/**
 * "Sync with MEXC" (My Trades → Live): runs the private sync for the signed-in investor's own
 * account now and refreshes the page. Read-only towards MEXC: no order is sent or cancelled.
 */
export function SyncWithMexcButton({ lastSyncOkAt, lastSyncAt, lastSyncError, timezone }: { lastSyncOkAt: string | null; lastSyncAt: string | null; lastSyncError: string | null; timezone: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null);
  const fmt = (iso: string) => new Date(iso).toLocaleString('en-GB', { timeZone: timezone, dateStyle: 'medium', timeStyle: 'medium' });
  // The stored error belongs to the latest attempt only when that attempt is newer than the last success.
  const failing = !!lastSyncError && !!lastSyncAt && (!lastSyncOkAt || lastSyncAt > lastSyncOkAt);

  async function sync() {
    setBusy(true);
    const r = await request<SyncResult>('POST', '/v1/me/live/sync');
    setBusy(false);
    if (!r.ok) setMessage({ tone: 'err', text: r.message });
    else if (!r.data.sync.ok) setMessage({ tone: 'err', text: `Sync failed: ${r.data.sync.error ?? 'unknown error'}. Nothing was changed.` });
    else setMessage({ tone: 'ok', text: summary(r.data.sync) });
    router.refresh();
  }

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-xl border border-line bg-surface px-4 py-3 text-sm" data-testid="mexc-sync">
      <Button size="sm" variant="secondary" icon={RefreshCwIcon} loading={busy} onClick={sync} data-testid="sync-with-mexc">
        Sync with MEXC
      </Button>
      <span className="text-xs text-muted" data-testid="last-sync">
        Last successful sync: {lastSyncOkAt ? fmt(lastSyncOkAt) : 'never'}
      </span>
      {failing && (
        <span className="text-xs text-loss" data-testid="sync-error">
          Last attempt {fmt(lastSyncAt!)} failed: {lastSyncError}
        </span>
      )}
      {message && (
        <span role="status" className={`basis-full text-xs ${message.tone === 'ok' ? 'text-muted' : 'text-loss'}`} data-testid="sync-message">
          {message.text}
        </span>
      )}
    </div>
  );
}
