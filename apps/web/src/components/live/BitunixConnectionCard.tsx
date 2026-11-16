'use client';

import React, { useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { ArrowDownUpIcon, KeyRoundIcon, OctagonPauseIcon, PlugZapIcon, PowerIcon, RefreshCwIcon, Trash2Icon } from 'lucide-react';
import { request } from '@/lib/api';
import { Button } from '../ui/Button';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { StatusPill } from '../ui/StatusPill';
import { TextField } from '../ui/TextField';
import { connectionStatusLabel, positionModeLabel } from './connectionLabels';

export interface BitunixConnectionView {
  id: string;
  accountRef: string;
  keyFingerprint: string;
  status: string;
  positionMode: string | null;
  verification: Record<string, unknown>;
  verifiedAt: string | null;
  approved?: boolean;
  liveEnabled?: boolean;
  entriesHalted?: boolean;
  haltReason?: string | null;
}

export interface BitunixAccountView {
  accountState: { balance?: { available: string | null; equity?: string | null; atMs: number; source: string }; pendingOrders?: unknown[]; tpsl?: unknown[]; excludedSubAccountRows?: number };
  streamState: { state?: string; auth?: string | null; authError?: string | null; readyAt?: string | null; lastMessageAt?: string | null; reconnects?: number; lastError?: string | null; updatedAt?: string };
  lastSyncAt: string | null;
  lastSyncOkAt: string | null;
  lastSyncError: string | null;
  positions: { positionId: string; symbol: string; side: string; qty: string; avgOpenPrice: string | null; liqPrice: string | null; unrealizedPnl: string | null; status: string; closeCheck: string; closePrice: string | null; closedAt: string | null; origin: string }[];
}

const streamLabel = (s: BitunixAccountView['streamState'] | undefined): { text: string; tone: 'gain' | 'warn' | 'loss' | 'neutral' } => {
  if (!s?.state) return { text: 'Not started', tone: 'neutral' };
  if (s.auth === 'AUTH_FAILED') return { text: 'Login rejected', tone: 'loss' };
  if (s.auth === 'AUTHENTICATED' && s.state === 'OPEN') return { text: 'Connected', tone: 'gain' };
  if (s.state === 'STOPPED') return { text: 'Stopped', tone: 'neutral' };
  return { text: 'Reconnecting', tone: 'warn' };
};

const Row = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <div className="flex items-start justify-between gap-4 border-b border-line py-2 text-sm last:border-0">
    <span className="text-subtle">{label}</span>
    <span className="text-right text-ink">{children}</span>
  </div>
);

const BASE = '/v1/me/exchange-connection?exchange=BITUNIX';

/** The investor's own Bitunix Futures key: read-only check only (position mode and USDT balance). */
export function BitunixConnectionCard({ initial, account: initialAccount }: { initial: BitunixConnectionView | null; account?: BitunixAccountView | null }) {
  const router = useRouter();
  const [c, setC] = useState(initial);
  const [account, setAccount] = useState(initialAccount ?? null);
  const [form, setForm] = useState({ accountRef: '', apiKey: '', secretKey: '' });
  const [editing, setEditing] = useState(!initial);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [confirmActivate, setConfirmActivate] = useState(false);

  const act = async (key: string, method: string, path: string, body?: unknown, ok?: string) => {
    setBusy(key);
    const r = await request<{ connection: BitunixConnectionView; account?: BitunixAccountView | null }>(method, path, body === undefined ? {} : { body });
    setBusy(null);
    if (!r.ok) {
      toast.error('Not done', { description: r.message });
      return null;
    }
    if (ok) toast.success(ok);
    if (r.data.account !== undefined) setAccount(r.data.account ?? null);
    router.refresh();
    return r.data.connection;
  };

  const save = async () => {
    const saved = await act('save', 'PUT', BASE, { ...form, exchange: 'BITUNIX' });
    setForm({ accountRef: form.accountRef, apiKey: '', secretKey: '' });
    if (saved) {
      setC(saved);
      setEditing(false);
      toast.success(saved.status === 'VERIFIED' ? 'Bitunix key saved and checked (read-only).' : 'Bitunix key saved, but the check failed. See the details.');
    }
  };

  const v = (c?.verification ?? {}) as { error?: string; checkedAt?: string; positionModeNote?: string; usdt?: { equity: string; available: string } | null; liveTrading?: string };

  return (
    <section className="rounded-xl border border-line bg-surface p-5" data-testid="bitunix-connection">
      <h3 className="flex items-center gap-2 text-sm font-semibold text-ink">
        <PlugZapIcon className="h-4 w-4 text-subtle" aria-hidden />
        Bitunix Futures connection <StatusPill tone={c?.liveEnabled ? 'warn' : 'neutral'}>{c?.liveEnabled ? 'Live on' : 'Live off'}</StatusPill>
      </h3>
      {c && !editing ? (
        <div className="mt-3">
          <Row label="Status">
            <StatusPill tone={connectionStatusLabel(c.status).tone}>{connectionStatusLabel(c.status).text}</StatusPill>
          </Row>
          <Row label="Approved by administrator">{c.approved ? 'Approved' : 'Not yet'}</Row>
          <Row label="Your Bitunix Live activation">{c.liveEnabled ? 'On' : 'Off'}</Row>
          {c.entriesHalted && <Row label="Bitunix Live entries">{`Halted${c.haltReason ? ` (${c.haltReason})` : ''}`}</Row>}
          <Row label="Account reference">{c.accountRef}</Row>
          <Row label="API key">
            <span className="font-mono">{c.keyFingerprint}</span>
          </Row>
          <Row label="Position mode (reported by Bitunix)">
            <span data-testid="bitunix-position-mode">
              <StatusPill tone={positionModeLabel(c.positionMode).tone}>{positionModeLabel(c.positionMode).text}</StatusPill>
            </span>
          </Row>
          <Row label="Balance (USDT)">
            {account?.accountState.balance
              ? `${account.accountState.balance.equity ?? '—'} equity · ${account.accountState.balance.available ?? '—'} available (${account.accountState.balance.source === 'WS' ? 'live push' : 'last sync'})`
              : v.usdt
                ? `${v.usdt.equity} equity · ${v.usdt.available} available (at check)`
                : '—'}
          </Row>
          <Row label="Last check">{v.checkedAt ? new Date(v.checkedAt).toLocaleString() : '—'}</Row>
          <Row label="Private account stream">
            <span data-testid="bitunix-stream">
              <StatusPill tone={streamLabel(account?.streamState).tone}>{streamLabel(account?.streamState).text}</StatusPill>
            </span>
          </Row>
          <Row label="Account sync — last successful">
            <span data-testid="bitunix-last-sync-ok">{account?.lastSyncOkAt ? new Date(account.lastSyncOkAt).toLocaleString() : 'never'}</span>
          </Row>
          {account?.lastSyncError && (!account.lastSyncOkAt || (account.lastSyncAt && account.lastSyncAt > account.lastSyncOkAt)) && <p className="mt-2 text-xs text-warn">Latest sync failed: {account.lastSyncError}. Positions keep their last confirmed state.</p>}
          {account?.streamState.authError && <p className="mt-2 text-xs text-loss">Bitunix rejected the private login: {account.streamState.authError}. Replace the key to retry.</p>}
          {account && account.positions.some((p) => p.status === 'OPEN') && (
            <div className="mt-3 overflow-x-auto" data-testid="bitunix-positions">
              <table className="w-full text-left text-xs">
                <thead className="text-subtle">
                  <tr>
                    <th className="py-1 pr-2 font-normal">Contract</th>
                    <th className="py-1 pr-2 font-normal">Side</th>
                    <th className="py-1 pr-2 font-normal">Qty</th>
                    <th className="py-1 pr-2 font-normal">Entry</th>
                    <th className="py-1 pr-2 font-normal">Liq.</th>
                    <th className="py-1 font-normal">Note</th>
                  </tr>
                </thead>
                <tbody>
                  {account.positions
                    .filter((p) => p.status === 'OPEN')
                    .map((p) => (
                      <tr key={p.positionId} className="border-t border-line">
                        <td className="py-1 pr-2 text-ink">{p.symbol}</td>
                        <td className="py-1 pr-2">{p.side === 'LONG' ? 'Long' : 'Short'}</td>
                        <td className="py-1 pr-2 font-mono">{p.qty}</td>
                        <td className="py-1 pr-2 font-mono">{p.avgOpenPrice ?? '—'}</td>
                        <td className="py-1 pr-2 font-mono">{p.liqPrice ?? '—'}</td>
                        <td className="py-1 text-subtle">{p.closeCheck === 'PENDING' ? 'Close reported; confirming with Bitunix history' : p.origin === 'EXCHANGE' ? 'Opened on Bitunix' : 'TrendPilot'}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          )}
          {v.error && <p className="mt-2 text-xs text-loss">Check failed: {v.error}</p>}
          <p className="mt-3 text-xs text-subtle">Bitunix Live orders need Hedge mode, an administrator&apos;s approval and your activation. Every entry carries its stop loss; TrendPilot never changes your position mode, leverage or margin mode — set them in Bitunix to match your Live settings.</p>
          <div className="mt-4 flex flex-wrap gap-2">
            <Button
              icon={RefreshCwIcon}
              loading={busy === 'verify'}
              onClick={async () => {
                const u = await act('verify', 'POST', '/v1/me/exchange-connection/verify?exchange=BITUNIX', undefined, 'Bitunix connection checked.');
                if (u) setC(u);
              }}
            >
              Check again
            </Button>
            <Button
              icon={ArrowDownUpIcon}
              loading={busy === 'sync'}
              disabled={c.status !== 'VERIFIED'}
              onClick={() => act('sync', 'POST', '/v1/me/exchange-connection/sync?exchange=BITUNIX', undefined, 'Bitunix account synced (read-only).')}
            >
              Sync
            </Button>
            {c.liveEnabled ? (
              <Button variant="warn" icon={PowerIcon} loading={busy === 'deactivate'} onClick={async () => { const u = await act('deactivate', 'POST', '/v1/me/live/deactivate?exchange=BITUNIX', undefined, 'Bitunix Live trading turned off.'); if (u) setC(u); }}>
                Turn Bitunix Live off
              </Button>
            ) : (
              <Button variant="primary" icon={PowerIcon} disabled={c.status !== 'VERIFIED' || !c.approved || c.positionMode !== 'HEDGE'} onClick={() => setConfirmActivate(true)}>
                Activate Bitunix Live
              </Button>
            )}
            <Button variant="danger" icon={OctagonPauseIcon} disabled={!!c.entriesHalted} loading={busy === 'halt'} onClick={async () => { const u = await act('halt', 'POST', '/v1/me/live/halt?exchange=BITUNIX', { reason: 'investor request' }, 'New Bitunix Live entries halted.'); if (u) setC(u); }}>
              Halt new entries
            </Button>
            <Button icon={KeyRoundIcon} onClick={() => setEditing(true)}>
              Replace key
            </Button>
            <Button variant="danger" icon={Trash2Icon} onClick={() => setConfirmRemove(true)}>
              Remove key
            </Button>
          </div>
        </div>
      ) : (
        <div className="mt-3 space-y-3">
          <p className="text-xs text-muted">
            Create a Bitunix Futures API key with <strong>read</strong> permission — never withdrawal — and restrict it to the TrendPilot server&apos;s IP. TrendPilot checks the key read-only: it reads your futures position mode and USDT balance and changes nothing. The key is encrypted on the server and never shown again.
          </p>
          <TextField label="Account reference" value={form.accountRef} onChange={(x) => setForm({ ...form, accountRef: x })} hint="Not a key: for example the last digits of your Bitunix UID." autoComplete="off" />
          <TextField label="API key" value={form.apiKey} onChange={(x) => setForm({ ...form, apiKey: x })} autoComplete="off" spellCheck={false} />
          <TextField label="Secret key" type="password" value={form.secretKey} onChange={(x) => setForm({ ...form, secretKey: x })} autoComplete="new-password" spellCheck={false} />
          <div className="flex gap-2">
            <Button variant="primary" icon={PlugZapIcon} loading={busy === 'save'} disabled={!form.accountRef.trim() || !form.apiKey.trim() || !form.secretKey.trim()} onClick={save}>
              Save and check
            </Button>
            {c && (
              <Button variant="ghost" onClick={() => setEditing(false)}>
                Cancel
              </Button>
            )}
          </div>
        </div>
      )}
      <ConfirmDialog
        open={confirmActivate}
        title="Activate Bitunix Live trading?"
        description="Your Active Live settings on Bitunix contracts will place real market orders on your Bitunix Futures account (Hedge mode), each with its stop loss attached, within your approved limits. You can turn it off or halt new entries at any time; open positions stay protected and can be closed."
        confirmLabel="Activate Bitunix Live"
        onCancel={() => setConfirmActivate(false)}
        onConfirm={async () => {
          setConfirmActivate(false);
          const u = await act('activate', 'POST', '/v1/me/live/activate?exchange=BITUNIX', undefined, 'Bitunix Live trading activated.');
          if (u) setC(u);
        }}
      />
      <ConfirmDialog
        open={confirmRemove}
        title="Remove the Bitunix key?"
        description="TrendPilot deletes the Bitunix key. Your MEXC connection is not affected."
        confirmLabel="Remove key"
        tone="danger"
        onCancel={() => setConfirmRemove(false)}
        onConfirm={async () => {
          setConfirmRemove(false);
          if (await act('remove', 'DELETE', BASE, undefined, 'Bitunix key removed.')) {
            setC(null);
            setEditing(true);
          }
        }}
      />
    </section>
  );
}
