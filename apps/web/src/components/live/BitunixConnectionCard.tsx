'use client';

import React, { useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { KeyRoundIcon, PlugZapIcon, RefreshCwIcon, Trash2Icon } from 'lucide-react';
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
}

const Row = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <div className="flex items-start justify-between gap-4 border-b border-line py-2 text-sm last:border-0">
    <span className="text-subtle">{label}</span>
    <span className="text-right text-ink">{children}</span>
  </div>
);

const BASE = '/v1/me/exchange-connection?exchange=BITUNIX';

/** The investor's own Bitunix Futures key: read-only check only (position mode and USDT balance). */
export function BitunixConnectionCard({ initial }: { initial: BitunixConnectionView | null }) {
  const router = useRouter();
  const [c, setC] = useState(initial);
  const [form, setForm] = useState({ accountRef: '', apiKey: '', secretKey: '' });
  const [editing, setEditing] = useState(!initial);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);

  const act = async (key: string, method: string, path: string, body?: unknown, ok?: string) => {
    setBusy(key);
    const r = await request<{ connection: BitunixConnectionView }>(method, path, body === undefined ? {} : { body });
    setBusy(null);
    if (!r.ok) {
      toast.error('Not done', { description: r.message });
      return null;
    }
    if (ok) toast.success(ok);
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
        Bitunix Futures connection <StatusPill tone="neutral">Read-only</StatusPill>
      </h3>
      {c && !editing ? (
        <div className="mt-3">
          <Row label="Status">
            <StatusPill tone={connectionStatusLabel(c.status).tone}>{connectionStatusLabel(c.status).text}</StatusPill>
          </Row>
          <Row label="Account reference">{c.accountRef}</Row>
          <Row label="API key">
            <span className="font-mono">{c.keyFingerprint}</span>
          </Row>
          <Row label="Position mode (reported by Bitunix)">
            <span data-testid="bitunix-position-mode">
              <StatusPill tone={positionModeLabel(c.positionMode).tone}>{positionModeLabel(c.positionMode).text}</StatusPill>
            </span>
          </Row>
          <Row label="Balance (USDT, at check)">{v.usdt ? `${v.usdt.equity} equity · ${v.usdt.available} available` : '—'}</Row>
          <Row label="Last check">{v.checkedAt ? new Date(v.checkedAt).toLocaleString() : '—'}</Row>
          {v.error && <p className="mt-2 text-xs text-loss">Check failed: {v.error}</p>}
          <p className="mt-3 text-xs text-subtle">{v.liveTrading ?? 'Bitunix Live trading is not available yet; this connection is read-only.'} TrendPilot never changes your position mode.</p>
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
