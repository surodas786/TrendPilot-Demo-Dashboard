'use client';

import React, { useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { CircleAlertIcon, KeyRoundIcon, OctagonPauseIcon, PlugZapIcon, PowerIcon, RefreshCwIcon, ShieldCheckIcon, Trash2Icon } from 'lucide-react';
import { request } from '@/lib/api';
import { Button } from '../ui/Button';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { StatusPill } from '../ui/StatusPill';
import { TextField } from '../ui/TextField';

export interface LiveStatus {
  platform: { transportEnabled: boolean; liveEnabled: boolean; entriesHalted: boolean; haltReason: string | null };
  connection: {
    id: string;
    accountRef: string;
    keyFingerprint: string;
    status: string;
    positionMode: string | null;
    verification: Record<string, unknown>;
    verifiedAt: string | null;
    approved: boolean;
    limits: { maxOrderContracts: string; maxOrderNotionalUsdt: string; maxLeverage: number; maxExposureUsdt: string } | null;
    liveEnabled: boolean;
    entriesHalted: boolean;
    haltReason: string | null;
    lastSyncAt: string | null;
    lastSyncError: string | null;
    drift: unknown[];
  } | null;
  liveContracts: { id: string; symbol: string; exchangeSymbol: string }[];
  entries: { allowed: boolean; reason: string | null; reasonText: string | null };
}

const Row = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <div className="flex items-start justify-between gap-4 border-b border-line py-2 text-sm last:border-0">
    <span className="text-subtle">{label}</span>
    <span className="text-right text-ink">{children}</span>
  </div>
);

const yes = (ok: boolean, on: string, off: string) => <StatusPill tone={ok ? 'gain' : 'neutral'}>{ok ? on : off}</StatusPill>;

/** Live Trading for the signed-in investor: own MEXC connection, activation and halt. Keys go to the server once and are never shown again. */
export function LiveTradingClient({ initial }: { initial: LiveStatus }) {
  const router = useRouter();
  const [status, setStatus] = useState(initial);
  const [form, setForm] = useState({ accountRef: '', apiKey: '', secretKey: '' });
  const [editing, setEditing] = useState(!initial.connection);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<'activate' | 'remove' | null>(null);
  const c = status.connection;

  const reload = async () => {
    const r = await request<LiveStatus>('GET', '/v1/me/live');
    if (r.ok) setStatus(r.data);
    router.refresh();
  };
  const act = async (key: string, method: string, path: string, body?: unknown, ok?: string) => {
    setBusy(key);
    const r = await request<unknown>(method, path, body === undefined ? {} : { body });
    setBusy(null);
    if (!r.ok) {
      toast.error('Not done', { description: r.message });
      return false;
    }
    if (ok) toast.success(ok);
    await reload();
    return true;
  };

  const save = async () => {
    const done = await act('save', 'PUT', '/v1/me/exchange-connection', form);
    // The key and secret leave the browser once; the form is cleared either way.
    setForm({ accountRef: form.accountRef, apiKey: '', secretKey: '' });
    if (done) {
      setEditing(false);
      toast.success('MEXC key saved and checked (read-only). Live stays off until it is approved and you activate it.');
    }
  };

  const verification = (c?.verification ?? {}) as { error?: string; usdt?: { equity: string; available: string } | null; openPositions?: { symbol: string; side: string; contracts: string }[]; orderPermission?: string; checkedAt?: string };

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <section className="rounded-xl border border-line bg-surface p-5" data-testid="live-status">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-ink">
          <ShieldCheckIcon className="h-4 w-4 text-subtle" aria-hidden />
          Live status
        </h3>
        <div className="mt-3">
          <Row label="Live order submission (deployment)">{yes(status.platform.transportEnabled, 'Enabled', 'Off')}</Row>
          <Row label="Platform Live switch">{yes(status.platform.liveEnabled, 'On', 'Off')}</Row>
          <Row label="Platform entries">{status.platform.entriesHalted ? <StatusPill tone="warn">Halted</StatusPill> : <StatusPill tone="neutral">Not halted</StatusPill>}</Row>
          <Row label="Your MEXC connection">{c ? <StatusPill tone={c.status === 'VERIFIED' ? 'gain' : c.status === 'FAILED' ? 'loss' : 'neutral'}>{c.status === 'VERIFIED' ? 'Verified' : c.status === 'FAILED' ? 'Check failed' : 'Pending'}</StatusPill> : <StatusPill tone="neutral">Not connected</StatusPill>}</Row>
          <Row label="Approved by administrator">{yes(!!c?.approved, 'Approved', 'Not yet')}</Row>
          <Row label="Your Live activation">{yes(!!c?.liveEnabled, 'On', 'Off')}</Row>
          <Row label="Your Live entries">{c?.entriesHalted ? <StatusPill tone="warn">Halted</StatusPill> : <StatusPill tone="neutral">Not halted</StatusPill>}</Row>
          <Row label="Contracts allowed for Live">{status.liveContracts.length ? status.liveContracts.map((x) => x.exchangeSymbol || x.symbol).join(', ') : 'None yet'}</Row>
        </div>
        <p className={`mt-3 flex items-start gap-2 rounded-lg px-3 py-2 text-xs ${status.entries.allowed ? 'bg-gain/10 text-gain' : 'bg-inset text-muted'}`} data-testid="live-entries">
          <CircleAlertIcon className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
          {status.entries.allowed ? 'New Live entries are allowed on the contracts above, within your limits.' : `New Live entries are not possible now: ${status.entries.reasonText}`}
        </p>
        {c?.haltReason && c.entriesHalted && <p className="mt-2 text-xs text-warn">Halt reason: {c.haltReason}. An administrator resumes entries after review.</p>}
        <p className="mt-3 text-xs text-subtle">Turning Live off or halting stops new Live entries only. Your stop losses, take profit, trailing take profit, close-on-signal and manual closes keep working on open Live positions.</p>
        {c && (
          <div className="mt-4 flex flex-wrap gap-2">
            {c.liveEnabled ? (
              <Button variant="warn" icon={PowerIcon} loading={busy === 'deactivate'} onClick={() => act('deactivate', 'POST', '/v1/me/live/deactivate', undefined, 'Live trading turned off for your account.')}>
                Turn Live off
              </Button>
            ) : (
              <Button variant="primary" icon={PowerIcon} disabled={c.status !== 'VERIFIED' || !c.approved} onClick={() => setConfirm('activate')}>
                Activate Live trading
              </Button>
            )}
            <Button variant="danger" icon={OctagonPauseIcon} disabled={c.entriesHalted} loading={busy === 'halt'} onClick={() => act('halt', 'POST', '/v1/me/live/halt', { reason: 'investor request' }, 'New Live entries halted.')}>
              Halt new entries
            </Button>
          </div>
        )}
      </section>

      <section className="rounded-xl border border-line bg-surface p-5">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-ink">
          <PlugZapIcon className="h-4 w-4 text-subtle" aria-hidden />
          MEXC Futures connection
        </h3>
        {c && !editing ? (
          <div className="mt-3">
            <Row label="Account reference">{c.accountRef}</Row>
            <Row label="API key">
              <span className="font-mono">{c.keyFingerprint}</span>
            </Row>
            <Row label="Position mode">{c.positionMode === 'ONE_WAY' ? 'One-way' : c.positionMode === 'HEDGE' ? 'Hedge' : '—'}</Row>
            <Row label="Balance (USDT, at check)">{verification.usdt ? `${verification.usdt.equity} equity · ${verification.usdt.available} available` : '—'}</Row>
            <Row label="Last check">{verification.checkedAt ? new Date(verification.checkedAt).toLocaleString() : '—'}</Row>
            <Row label="Last private sync">{c.lastSyncAt ? new Date(c.lastSyncAt).toLocaleString() : '—'}</Row>
            {c.limits && (
              <Row label="Your Live limits">
                {c.limits.maxOrderContracts} contracts · {c.limits.maxOrderNotionalUsdt} USDT per order · ≤ {c.limits.maxLeverage}x · {c.limits.maxExposureUsdt} USDT exposure
              </Row>
            )}
            {verification.error && <p className="mt-2 text-xs text-loss">Check failed: {verification.error}</p>}
            {c.lastSyncError && <p className="mt-2 text-xs text-warn">Last sync error: {c.lastSyncError}</p>}
            {c.drift.length > 0 && <p className="mt-2 text-xs text-loss">MEXC and TrendPilot disagree on this account; an administrator is reviewing it.</p>}
            <p className="mt-3 text-xs text-subtle">{verification.orderPermission ?? 'Order permission is confirmed by the first supervised Live order.'}</p>
            <div className="mt-4 flex flex-wrap gap-2">
              <Button icon={RefreshCwIcon} loading={busy === 'verify'} onClick={() => act('verify', 'POST', '/v1/me/exchange-connection/verify', undefined, 'Connection checked.')}>
                Check again
              </Button>
              <Button icon={KeyRoundIcon} onClick={() => setEditing(true)}>
                Replace key
              </Button>
              <Button variant="danger" icon={Trash2Icon} onClick={() => setConfirm('remove')}>
                Remove key
              </Button>
            </div>
          </div>
        ) : (
          <div className="mt-3 space-y-3">
            <p className="text-xs text-muted">
              Create a MEXC Futures API key with <strong>View Account Details</strong>, <strong>View Order Details</strong> and <strong>Order Placing</strong> only — never withdrawal — and restrict it to the TrendPilot server&apos;s IP. Use one-way position mode. The key is encrypted on the server and never shown again.
            </p>
            <TextField label="Account reference" value={form.accountRef} onChange={(v) => setForm({ ...form, accountRef: v })} hint="Not a key: for example the last digits of your MEXC UID." autoComplete="off" />
            <TextField label="API key" value={form.apiKey} onChange={(v) => setForm({ ...form, apiKey: v })} autoComplete="off" spellCheck={false} />
            <TextField label="Secret key" type="password" value={form.secretKey} onChange={(v) => setForm({ ...form, secretKey: v })} autoComplete="new-password" spellCheck={false} />
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
      </section>

      <ConfirmDialog
        open={confirm === 'activate'}
        title="Activate Live trading?"
        description="Your Active Live settings will place real orders on your MEXC Futures account when signals arrive, each with its stop loss attached, within your approved limits. You can turn Live off or halt new entries at any time; open positions stay protected and can be closed."
        confirmLabel="Activate Live"
        onCancel={() => setConfirm(null)}
        onConfirm={async () => {
          setConfirm(null);
          await act('activate', 'POST', '/v1/me/live/activate', undefined, 'Live trading activated.');
        }}
      />
      <ConfirmDialog
        open={confirm === 'remove'}
        title="Remove the MEXC key?"
        description="TrendPilot deletes the key and switches Live off. This is refused while Live positions are open or Live orders are unresolved."
        confirmLabel="Remove key"
        tone="danger"
        onCancel={() => setConfirm(null)}
        onConfirm={async () => {
          setConfirm(null);
          if (await act('remove', 'DELETE', '/v1/me/exchange-connection', undefined, 'Key removed.')) setEditing(true);
        }}
      />
    </div>
  );
}
