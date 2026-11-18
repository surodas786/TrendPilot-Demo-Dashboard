'use client';


import { exchangeLabel } from '@trendpilot/domain';
import React, { useState } from 'react';
import { toast } from 'sonner';
import { CheckCircle2Icon, OctagonPauseIcon, PlayIcon, PowerIcon, RefreshCwIcon } from 'lucide-react';
import { request } from '@/lib/api';
import { Button } from '../ui/Button';
import { StatusPill } from '../ui/StatusPill';
import { TextField } from '../ui/TextField';

type Cap = { state: 'VERIFIED' | 'PILOT_ACCEPTED' | 'PENDING'; evidence: string; by: string; at: string };
type Limits = { maxOrderContracts: string; maxOrderNotionalUsdt: string; maxLeverage: number; maxExposureUsdt: string };
export interface LiveAdminData {
  control: { transportEnabled: boolean; liveEnabled: boolean; entriesHalted: boolean; haltReason: string | null; capabilities: Record<string, Cap>; note: string | null };
  capabilities: { id: string; exchange: string; summary: string; documented: string; mock: string; readOnly: string; gaps: string[] }[];
  /** Per exchange: what blocks regular (signal-driven) Live entries there, with capability records as recorded. */
  exchanges: {
    exchange: string;
    label: string;
    capabilities: { id: string; state: 'VERIFIED' | 'PILOT_ACCEPTED' | 'PENDING' }[];
    pilotAccepted: string[];
    allowlisted: string[];
    readyAccounts: number;
    accounts: number;
    blocking: { reason: string; text: string }[];
  }[];
  connections: {
    id: string;
    exchange: string;
    owner: { email: string; name: string };
    accountRef: string;
    keyFingerprint: string;
    status: string;
    positionMode: string | null;
    approved: boolean;
    limits: Limits | null;
    liveEnabled: boolean;
    entriesHalted: boolean;
    haltReason: string | null;
    lastSyncAt: string | null;
    lastSyncError: string | null;
    drift: { kind: string; symbol: string; detail: string }[];
    /** Every condition blocking a regular Live entry on this account's exchange (empty = ready). */
    blockers: { reason: string; text: string }[];
  }[];
  contracts: { id: string; exchange: string; symbol: string; exchangeSymbol: string; status: string; isFixture: boolean; liveAllowed: boolean }[];
}

const ORDER_CAPS = ['OPEN_WITH_ATTACHED_STOP', 'REDUCE_ONLY_CLOSE', 'STOP_RESIZE_AFTER_PARTIAL_CLOSE', 'CANCEL_STOP'];
const Card = ({ title, children, testId }: { title: string; children: React.ReactNode; testId?: string }) => (
  <section className="rounded-xl border border-line bg-surface p-5" data-testid={testId}>
    <h3 className="text-sm font-semibold text-ink">{title}</h3>
    <div className="mt-3">{children}</div>
  </section>
);

/** Admin → Live Trading: platform switch and halt, order capability evidence, account approvals and limits, contract allowlist. */
export function LiveAdmin({ initial }: { initial: LiveAdminData }) {
  const [d, setD] = useState(initial);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [limits, setLimits] = useState<Record<string, Limits>>(() =>
    Object.fromEntries(initial.connections.map((c) => [c.id, c.limits ?? { maxOrderContracts: '', maxOrderNotionalUsdt: '', maxLeverage: 3, maxExposureUsdt: '' }]))
  );

  const reload = async () => {
    const r = await request<LiveAdminData>('GET', '/v1/admin/live');
    if (r.ok) setD(r.data);
  };
  const post = async (key: string, path: string, body: unknown, ok: string) => {
    setBusy(key);
    const r = await request<unknown>('POST', path, { body });
    setBusy(null);
    if (!r.ok) return toast.error('Not done', { description: r.message });
    toast.success(ok);
    await reload();
  };
  const needNote = () => {
    if (note.trim()) return true;
    toast.error('Enter an operator note first (who, why, evidence reference).');
    return false;
  };
  const c = d.control;
  const capsReady = ORDER_CAPS.every((id) => ['VERIFIED', 'PILOT_ACCEPTED'].includes(c.capabilities[id]?.state ?? ''));

  return (
    <div className="space-y-4">
      <Card title="Platform Live switch" testId="live-platform">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-subtle">Deployment order transport:</span>
          <StatusPill tone={c.transportEnabled ? 'warn' : 'neutral'}>{c.transportEnabled ? 'Enabled' : 'Disabled (LIVE_ORDER_TRANSPORT)'}</StatusPill>
          <span className="ml-3 text-subtle">Platform Live:</span>
          <StatusPill tone={c.liveEnabled ? 'warn' : 'neutral'}>{c.liveEnabled ? 'On' : 'Off'}</StatusPill>
          <span className="ml-3 text-subtle">New Live entries:</span>
          <StatusPill tone={c.entriesHalted ? 'loss' : 'neutral'}>{c.entriesHalted ? `Halted — ${c.haltReason}` : 'Not halted'}</StatusPill>
        </div>
        <TextField className="mt-4 max-w-xl" label="Operator note" value={note} onChange={setNote} hint="Required for every change below; stored in the audit log." />
        <div className="mt-3 flex flex-wrap gap-2">
          {c.liveEnabled ? (
            <Button variant="warn" icon={PowerIcon} loading={busy === 'off'} onClick={() => needNote() && post('off', '/v1/admin/live/platform', { enabled: false, note }, 'Platform Live switched off.')}>
              Switch Live off
            </Button>
          ) : (
            <Button variant="primary" icon={PowerIcon} disabled={!capsReady} loading={busy === 'on'} onClick={() => needNote() && post('on', '/v1/admin/live/platform', { enabled: true, note }, 'Platform Live switched on.')}>
              Switch Live on
            </Button>
          )}
          {c.entriesHalted ? (
            <Button icon={PlayIcon} loading={busy === 'resume'} onClick={() => needNote() && post('resume', '/v1/admin/live/resume', { note }, 'New Live entries resumed.')}>
              Resume new entries
            </Button>
          ) : (
            <Button variant="danger" icon={OctagonPauseIcon} loading={busy === 'halt'} onClick={() => needNote() && post('halt', '/v1/admin/live/halt', { reason: note }, 'All new Live entries halted.')}>
              Halt all new Live entries
            </Button>
          )}
        </div>
        <p className="mt-3 text-xs text-subtle">
          Halting or switching Live off stops new Live entries only; stop losses, take profits, trailing take profit, close-on-signal, manual and emergency closes keep running. Setting LIVE_ORDER_TRANSPORT=disabled stops all order traffic, including closes — use it only as a last resort (runbook §6).
          {!capsReady && ' Switching Live on (for every exchange) needs the four MEXC order capabilities below recorded as VERIFIED or PILOT_ACCEPTED.'}
        </p>
      </Card>

      <Card title="Live readiness by exchange" testId="live-readiness">
        <div className="grid gap-3 lg:grid-cols-3">
          {d.exchanges.map((x) => (
            <div key={x.exchange} className="rounded-lg border border-line p-3" data-testid={`live-readiness-${x.exchange}`}>
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span className="font-semibold text-ink">{x.label}</span>
                <StatusPill tone={x.blocking.length ? 'loss' : 'gain'}>{x.blocking.length ? 'Regular Live use blocked' : 'Ready for Live entries'}</StatusPill>
              </div>
              <p className="mt-1 text-xs text-subtle">
                Allowlisted: {x.allowlisted.length ? x.allowlisted.join(', ') : 'none'} · accounts ready {x.readyAccounts}/{x.accounts}
              </p>
              <p className="mt-1 text-xs text-subtle">Capabilities: {x.capabilities.map((cap) => `${cap.id.replace(/^(BITUNIX|LIGHTER)_/, '')} ${cap.state}`).join(' · ')}</p>
              {x.pilotAccepted.length > 0 && (
                <p className="mt-1 text-xs text-warn" data-testid={`live-pilot-${x.exchange}`}>
                  {x.pilotAccepted.length} {x.pilotAccepted.length === 1 ? 'capability is' : 'capabilities are'} PILOT_ACCEPTED, not VERIFIED. The adapter sends these order types, so this status alone does not block entries.
                </p>
              )}
              {x.blocking.length > 0 && (
                <ul className="mt-2 list-disc space-y-0.5 pl-5 text-xs text-loss" data-testid={`live-blocking-${x.exchange}`}>
                  {x.blocking.map((b, i) => (
                    <li key={i} data-reason={b.reason}>
                      {b.text}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ))}
        </div>
      </Card>

      {d.exchanges.map((ex) => {
        const rows = d.capabilities.filter((cap) => cap.exchange === ex.exchange);
        if (!rows.length) return null;
        return (
          <Card key={ex.exchange} title={`${ex.label} order capabilities (evidence)`} testId={`live-capabilities-${ex.exchange}`}>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[860px] text-sm">
                <thead className="text-left text-xs text-subtle">
                  <tr>
                    <th className="py-2 pr-3 font-medium">Capability</th>
                    <th className="py-2 pr-3 font-medium">Docs</th>
                    <th className="py-2 pr-3 font-medium">Mock</th>
                    <th className="py-2 pr-3 font-medium">Operator record</th>
                    <th className="py-2 font-medium" />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((cap) => {
                    const rec = c.capabilities[cap.id];
                    return (
                      <tr key={cap.id} className="border-t border-line align-top" data-testid={`cap-${cap.id}`}>
                        <td className="py-2 pr-3">
                          <div className="font-mono text-xs text-ink">{cap.id}</div>
                          <div className="text-xs text-subtle">{cap.summary}</div>
                        </td>
                        <td className="py-2 pr-3 text-xs">{cap.documented}</td>
                        <td className="py-2 pr-3 text-xs">{cap.mock}</td>
                        <td className="py-2 pr-3 text-xs">
                          <StatusPill tone={rec?.state === 'VERIFIED' ? 'gain' : rec?.state === 'PILOT_ACCEPTED' ? 'warn' : 'neutral'}>{rec?.state ?? 'PENDING'}</StatusPill>
                          {rec && <div className="mt-1 text-subtle">{rec.evidence}</div>}
                        </td>
                        <td className="py-2 text-right">
                          <div className="flex justify-end gap-1">
                            <Button size="sm" loading={busy === `cap-v-${cap.id}`} onClick={() => needNote() && post(`cap-v-${cap.id}`, '/v1/admin/live/capabilities', { capability: cap.id, state: 'VERIFIED', evidence: note }, `${cap.id}: VERIFIED`)}>
                              Verified
                            </Button>
                            <Button size="sm" loading={busy === `cap-p-${cap.id}`} onClick={() => needNote() && post(`cap-p-${cap.id}`, '/v1/admin/live/capabilities', { capability: cap.id, state: 'PILOT_ACCEPTED', evidence: note }, `${cap.id}: accepted for the supervised pilot`)}>
                              Pilot
                            </Button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <p className="mt-2 text-xs text-subtle">
              VERIFIED: observed on a real {ex.label} account
              {ex.exchange === 'BITUNIX' ? ' (cite bitunix-pilot:<sha256> from ops:bitunix-pilot --execute)' : ex.exchange === 'LIGHTER' ? ' (cite lighter-tx:<hash>)' : ' (record the order IDs)'}. Pilot: accepted for the supervised first trades, which are themselves
              the evidence.
            </p>
          </Card>
        );
      })}

      <Card title="Investor exchange accounts" testId="live-connections">
        {d.connections.length === 0 ? (
          <p className="text-sm text-muted">No investor has connected an exchange account yet.</p>
        ) : (
          <div className="space-y-4">
            {d.connections.map((x) => {
              const l = limits[x.id] ?? { maxOrderContracts: '', maxOrderNotionalUsdt: '', maxLeverage: 3, maxExposureUsdt: '' };
              const setL = (patch: Partial<Limits>) => setLimits({ ...limits, [x.id]: { ...l, ...patch } });
              return (
                <div key={x.id} className="rounded-lg border border-line p-4" data-testid="live-connection" data-exchange={x.exchange}>
                  <div className="flex flex-wrap items-center gap-2 text-sm">
                    <span className="font-semibold text-ink">{x.owner.name}</span>
                    <span className="text-subtle">{x.owner.email}</span>
                    <StatusPill tone="neutral">{x.exchange === 'BITUNIX' ? 'Bitunix (Hedge mode)' : exchangeLabel(x.exchange)}</StatusPill>
                    <span className="text-subtle">· {x.accountRef} · key {x.keyFingerprint} · {x.positionMode ?? 'mode unknown'}</span>
                    <StatusPill tone={x.status === 'VERIFIED' ? 'gain' : x.status === 'FAILED' ? 'loss' : 'neutral'}>{x.status}</StatusPill>
                    <StatusPill tone={x.approved ? 'gain' : 'neutral'}>{x.approved ? 'Approved' : 'Not approved'}</StatusPill>
                    <StatusPill tone={x.liveEnabled ? 'warn' : 'neutral'}>{x.liveEnabled ? 'Investor: Live on' : 'Investor: Live off'}</StatusPill>
                    {x.entriesHalted && <StatusPill tone="loss">Halted: {x.haltReason}</StatusPill>}
                  </div>
                  <div className="mt-2 text-xs" data-testid="live-connection-blockers">
                    {x.blockers.length === 0 ? (
                      <span className="text-gain">{exchangeLabel(x.exchange)} Live entries: no blocking condition.</span>
                    ) : (
                      <>
                        <span className="font-medium text-loss">{exchangeLabel(x.exchange)} Live entries blocked by:</span>
                        <ul className="mt-0.5 list-disc pl-5 text-loss">
                          {x.blockers.map((b, i) => (
                            <li key={i} data-reason={b.reason}>
                              {b.text}
                            </li>
                          ))}
                        </ul>
                      </>
                    )}
                  </div>
                  {x.drift.length > 0 && (
                    <ul className="mt-2 list-disc pl-5 text-xs text-loss">
                      {x.drift.map((dr, i) => (
                        <li key={i}>
                          {dr.kind} {dr.symbol}: {dr.detail}
                        </li>
                      ))}
                    </ul>
                  )}
                  <p className="mt-1 text-xs text-subtle">
                    Last sync {x.lastSyncAt ? new Date(x.lastSyncAt).toLocaleString() : 'never'}
                    {x.lastSyncError ? ` — error: ${x.lastSyncError}` : ''}
                  </p>
                  {x.exchange === 'BITUNIX' && (
                    <p className="mt-2 text-xs text-subtle" data-testid="bitunix-connection-note">
                      Bitunix orders need the account in Hedge mode and the Bitunix capabilities recorded above. Quantities are in the base coin (BTC, XAU); TrendPilot never changes the account&apos;s position mode, leverage or margin mode.
                    </p>
                  )}
                  <div className="mt-3 grid gap-3 sm:grid-cols-4">
                    <TextField label="Max contracts / order" value={l.maxOrderContracts} onChange={(v) => setL({ maxOrderContracts: v })} />
                    <TextField label="Max notional / order (USDT)" value={l.maxOrderNotionalUsdt} onChange={(v) => setL({ maxOrderNotionalUsdt: v })} />
                    <TextField label="Max leverage" value={String(l.maxLeverage)} onChange={(v) => setL({ maxLeverage: Number(v) || 0 })} />
                    <TextField label="Max exposure (USDT)" value={l.maxExposureUsdt} onChange={(v) => setL({ maxExposureUsdt: v })} />
                  </div>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <Button size="sm" variant="primary" icon={CheckCircle2Icon} disabled={x.status !== 'VERIFIED'} loading={busy === `ap-${x.id}`} onClick={() => post(`ap-${x.id}`, `/v1/admin/live/connections/${x.id}/approve`, l, x.approved ? 'Limits updated.' : 'Account approved for Live.')}>
                      {x.approved ? 'Update limits' : 'Approve with these limits'}
                    </Button>
                    {x.approved && (
                      <Button size="sm" loading={busy === `un-${x.id}`} onClick={() => post(`un-${x.id}`, `/v1/admin/live/connections/${x.id}/unapprove`, {}, 'Approval removed; Live off for this account.')}>
                        Remove approval
                      </Button>
                    )}
                    {x.entriesHalted ? (
                      <Button size="sm" icon={PlayIcon} loading={busy === `re-${x.id}`} onClick={() => needNote() && post(`re-${x.id}`, `/v1/admin/live/connections/${x.id}/resume`, { note }, 'Entries resumed for this account.')}>
                        Resume entries
                      </Button>
                    ) : (
                      <Button size="sm" variant="danger" icon={OctagonPauseIcon} loading={busy === `ha-${x.id}`} onClick={() => post(`ha-${x.id}`, `/v1/admin/live/connections/${x.id}/halt`, { reason: note || 'operator' }, 'Entries halted for this account.')}>
                        Halt entries
                      </Button>
                    )}
                    {x.drift.length > 0 && (
                      <Button size="sm" loading={busy === `dr-${x.id}`} onClick={() => needNote() && post(`dr-${x.id}`, `/v1/admin/live/connections/${x.id}/clear-drift`, { note }, 'Drift cleared.')}>
                        Clear reviewed drift
                      </Button>
                    )}
                    <Button size="sm" icon={RefreshCwIcon} loading={busy === `sy-${x.id}`} onClick={() => post(`sy-${x.id}`, `/v1/admin/live/connections/${x.id}/sync`, {}, x.exchange === 'BITUNIX' ? 'Synced with Bitunix (read-only).' : 'Synced with MEXC.')}>
                      Sync now
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Card>

      <Card title="Contracts allowed for Live" testId="live-contracts">
        <div className="flex flex-wrap gap-2">
          {d.contracts
            .filter((x) => x.status === 'PUBLISHED')
            .map((x) => (
              <Button
                key={x.id}
                size="sm"
                variant={x.liveAllowed ? 'warn' : 'secondary'}
                disabled={!x.liveAllowed && x.isFixture}
                title={x.isFixture ? 'Fixture metadata: validate and publish the pair against MEXC first.' : undefined}
                loading={busy === `ct-${x.id}`}
                onClick={() => post(`ct-${x.id}`, `/v1/admin/live/contracts/${x.id}`, { allowed: !x.liveAllowed }, `${exchangeLabel(x.exchange)} ${x.symbol} ${x.liveAllowed ? 'removed from Live.' : 'allowed for Live.'}`)}
              >
                {exchangeLabel(x.exchange)} {x.exchangeSymbol || x.symbol}: {x.liveAllowed ? 'Live allowed' : x.exchange === 'MEXC' ? 'Paper only' : 'not allowed for Live'}
              </Button>
            ))}
        </div>
      </Card>
    </div>
  );
}
