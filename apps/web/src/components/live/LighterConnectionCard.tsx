'use client';

import React, { useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { ArrowDownUpIcon, KeyRoundIcon, PlugZapIcon, RefreshCwIcon, ShieldOffIcon, Trash2Icon } from 'lucide-react';
import { request } from '@/lib/api';
import { Button } from '../ui/Button';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { StatusPill } from '../ui/StatusPill';
import { TextField } from '../ui/TextField';

export interface LighterConnectionView {
  id: string;
  accountRef: string;
  keyFingerprint: string;
  status: string;
  verification: Record<string, unknown>;
  verifiedAt: string | null;
  venue: { environment: string; accountIndex: number; apiKeyIndex: number } | null;
  entriesHalted?: boolean;
  haltReason?: string | null;
}

export interface LighterAccountView {
  currency: 'USDC';
  balance: { collateral: string; available: string; totalAssetValue: string | null; atMs: number } | null;
  tradingMode: string | null;
  positions: { marketId: number; symbol: string; side: string | null; size: string; avgEntryPrice: string | null; liquidationPrice: string | null; unrealizedPnl: string | null; fundingPaidOutUsdc: string | null; openOrders: number }[];
  lastSyncAt: string | null;
  lastSyncOkAt: string | null;
  lastSyncError: string | null;
}

const Row = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <div className="flex items-start justify-between gap-4 border-b border-line py-2 text-sm last:border-0">
    <span className="text-subtle">{label}</span>
    <span className="text-right text-ink">{children}</span>
  </div>
);

const BASE = '/v1/me/exchange-connection?exchange=LIGHTER';

const statusLabel = (s: string): { text: string; tone: 'gain' | 'warn' | 'loss' | 'neutral' } =>
  s === 'VERIFIED' ? { text: 'Verified', tone: 'gain' } : s === 'FAILED' ? { text: 'Check failed', tone: 'loss' } : s === 'PENDING' ? { text: 'Key not proven yet', tone: 'warn' } : { text: s, tone: 'neutral' };

/**
 * The investor's own Lighter (USDC perpetuals) API key. Connection check and permission to trade
 * are shown separately: an account can be verified while Lighter Live trading stays off.
 */
export function LighterConnectionCard({ initial, account: initialAccount, trade }: { initial: LighterConnectionView | null; account?: LighterAccountView | null; trade: { allowed: boolean; reasons: string[] } }) {
  const router = useRouter();
  const [c, setC] = useState(initial);
  const [account, setAccount] = useState(initialAccount ?? null);
  const [form, setForm] = useState({ accountIndex: '', apiKeyIndex: '', apiPrivateKey: '' });
  const [editing, setEditing] = useState(!initial);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);

  const act = async (key: string, method: string, path: string, body?: unknown, ok?: string) => {
    setBusy(key);
    const r = await request<{ connection: LighterConnectionView; account?: LighterAccountView | null }>(method, path, body === undefined ? {} : { body });
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
    const saved = await act('save', 'PUT', BASE, { exchange: 'LIGHTER', environment: 'MAINNET', ...form });
    setForm({ accountIndex: form.accountIndex, apiKeyIndex: form.apiKeyIndex, apiPrivateKey: '' });
    if (saved) {
      setC(saved);
      setEditing(false);
      toast.success(saved.status === 'VERIFIED' ? 'Lighter key saved and verified.' : saved.status === 'PENDING' ? 'Lighter key saved: account and key index found; the key itself is not proven yet.' : 'Lighter key saved, but the check failed. See the details.');
    }
  };

  const v = (c?.verification ?? {}) as { error?: string; note?: string; checkedAt?: string; account?: { found: boolean; tradingMode?: string | null; collateralUsdc?: string; availableUsdc?: string }; apiKey?: { registered: boolean; keyMatch: string } };
  const st = c ? statusLabel(c.status) : null;

  return (
    <section className="rounded-xl border border-line bg-surface p-5" data-testid="lighter-connection">
      <h3 className="flex items-center gap-2 text-sm font-semibold text-ink">
        <PlugZapIcon className="h-4 w-4 text-subtle" aria-hidden />
        Lighter connection (USDC perpetuals) <StatusPill tone="neutral">Live off</StatusPill>
      </h3>
      {c && !editing ? (
        <div className="mt-3">
          <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-subtle">Connection check</p>
          <Row label="Status">
            <span data-testid="lighter-status">
              <StatusPill tone={st!.tone}>{st!.text}</StatusPill>
            </span>
          </Row>
          <Row label="Account">{c.venue ? `${c.venue.environment === 'MAINNET' ? 'Mainnet' : c.venue.environment} · account ${c.venue.accountIndex}` : c.accountRef}</Row>
          <Row label="API key index">{c.venue?.apiKeyIndex ?? '—'}</Row>
          <Row label="Key registered on Lighter">{v.apiKey ? (v.apiKey.registered ? 'Yes' : 'No') : '—'}</Row>
          <Row label="Saved key is that key">{v.apiKey?.keyMatch === 'MATCH' ? 'Proven' : v.apiKey?.keyMatch === 'MISMATCH' ? 'No — wrong key' : 'Not proven yet'}</Row>
          <Row label="Balance (USDC)">
            {account?.balance ? `${account.balance.collateral} collateral · ${account.balance.available} available (last sync)` : v.account?.collateralUsdc ? `${v.account.collateralUsdc} collateral · ${v.account.availableUsdc} available (at check)` : '—'}
          </Row>
          <Row label="Last check">{v.checkedAt ? new Date(v.checkedAt).toLocaleString() : '—'}</Row>
          <Row label="Account sync — last successful">
            <span data-testid="lighter-last-sync-ok">{account?.lastSyncOkAt ? new Date(account.lastSyncOkAt).toLocaleString() : 'never'}</span>
          </Row>
          {v.note && <p className="mt-2 text-xs text-warn">{v.note}</p>}
          {v.error && <p className="mt-2 text-xs text-loss">Check failed: {v.error}</p>}
          {account?.lastSyncError && <p className="mt-2 text-xs text-warn">Latest sync failed: {account.lastSyncError}. Positions keep their last confirmed state.</p>}
          {account && account.positions.length > 0 && (
            <div className="mt-3 overflow-x-auto" data-testid="lighter-positions">
              <table className="w-full text-left text-xs">
                <thead className="text-subtle">
                  <tr>
                    <th className="py-1 pr-2 font-normal">Market</th>
                    <th className="py-1 pr-2 font-normal">Side</th>
                    <th className="py-1 pr-2 font-normal">Size</th>
                    <th className="py-1 pr-2 font-normal">Entry</th>
                    <th className="py-1 pr-2 font-normal">Liq.</th>
                    <th className="py-1 font-normal">Funding paid (USDC)</th>
                  </tr>
                </thead>
                <tbody>
                  {account.positions.map((p) => (
                    <tr key={p.marketId} className="border-t border-line">
                      <td className="py-1 pr-2 text-ink">{p.symbol || p.marketId}</td>
                      <td className="py-1 pr-2">{p.side === 'LONG' ? 'Long' : p.side === 'SHORT' ? 'Short' : `— (${p.openOrders} order${p.openOrders === 1 ? '' : 's'})`}</td>
                      <td className="py-1 pr-2 font-mono">{p.size}</td>
                      <td className="py-1 pr-2 font-mono">{p.avgEntryPrice ?? '—'}</td>
                      <td className="py-1 pr-2 font-mono">{p.liquidationPrice ?? '—'}</td>
                      <td className="py-1 font-mono">{p.fundingPaidOutUsdc ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <p className="mb-1 mt-4 text-xs font-semibold uppercase tracking-wide text-subtle">Permission to trade</p>
          <div className="rounded-lg border border-line p-3 text-xs" data-testid="lighter-trade-permission">
            <p className="flex items-center gap-2 font-medium text-ink">
              <ShieldOffIcon className="h-4 w-4 text-subtle" aria-hidden />
              Lighter Live trading: {trade.allowed ? 'allowed' : 'off'}
            </p>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-subtle">
              {trade.reasons.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
          </div>

          <div className="mt-4 flex flex-wrap gap-2">
            <Button
              icon={RefreshCwIcon}
              loading={busy === 'verify'}
              onClick={async () => {
                const u = await act('verify', 'POST', '/v1/me/exchange-connection/verify?exchange=LIGHTER', undefined, 'Lighter connection checked.');
                if (u) setC(u);
              }}
            >
              Check again
            </Button>
            <Button icon={ArrowDownUpIcon} loading={busy === 'sync'} disabled={c.status !== 'VERIFIED'} onClick={() => act('sync', 'POST', '/v1/me/exchange-connection/sync?exchange=LIGHTER', undefined, 'Lighter account synced.')}>
              Sync
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
            Create an API key for your Lighter account (index 4–254) in the Lighter app and enter its <strong>API private key</strong>. Never enter your wallet private key or seed phrase: TrendPilot does not need them and has no deposits, withdrawals or transfers. The key is encrypted on the server, used only there, and never shown again.
          </p>
          <TextField label="Lighter account index" value={form.accountIndex} onChange={(x) => setForm({ ...form, accountIndex: x })} hint="Your account's number on Lighter (mainnet)." autoComplete="off" inputMode="numeric" />
          <TextField label="API key index" value={form.apiKeyIndex} onChange={(x) => setForm({ ...form, apiKeyIndex: x })} hint="4–254 (0–3 are reserved for Lighter's apps)." autoComplete="off" inputMode="numeric" />
          <TextField label="API private key" type="password" value={form.apiPrivateKey} onChange={(x) => setForm({ ...form, apiPrivateKey: x })} hint="80 hexadecimal characters, with or without 0x." autoComplete="new-password" spellCheck={false} />
          <div className="flex gap-2">
            <Button variant="primary" icon={PlugZapIcon} loading={busy === 'save'} disabled={!form.accountIndex.trim() || !form.apiKeyIndex.trim() || !form.apiPrivateKey.trim()} onClick={save}>
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
        title="Remove the Lighter key?"
        description="TrendPilot deletes the Lighter API key. It is refused while TrendPilot manages Lighter positions or a Lighter order is still being confirmed. Your MEXC and Bitunix connections are not affected."
        confirmLabel="Remove key"
        tone="danger"
        onCancel={() => setConfirmRemove(false)}
        onConfirm={async () => {
          setConfirmRemove(false);
          if (await act('remove', 'DELETE', BASE, undefined, 'Lighter key removed.')) {
            setC(null);
            setEditing(true);
          }
        }}
      />
    </section>
  );
}
