import React, { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useDemo } from '../contexts/DemoContext';
import { PageContainer } from '../components/layout/PageContainer';
import { TabBar } from '../components/ui/TabBar';
import { Button } from '../components/ui/Button';
import { ConfirmDialog } from '../components/ui/ConfirmDialog';
import { StatusPill } from '../components/ui/StatusPill';
import { RouteSettings } from '../components/admin/RouteSettings';
import { SignalComposer } from '../components/admin/SignalComposer';
import { ACTION_LABELS } from '../data/signalRoutes';
import { deliveryCounts } from '../utils/signalTiming';
import { formatDateTime } from '../utils/clock';
import { ownerOf } from '../data/demoUsers';
import type { CentralSignal } from '../types/signals';

type Section = 'overview' | 'routes' | 'compose' | 'feed' | 'users';
const SECTIONS: Section[] = ['overview', 'routes', 'compose', 'feed', 'users'];

/** Strategy-package (token block) results for one central signal, from the shared processor. */
function PackageOutcomes({ signalId, show }: {signalId: string;show: boolean;}) {
  const { state } = useDemo();
  if (!show) return null;
  const rec = state.tokenProcessing.find((r) => r.signalId === signalId);
  const userName = (id: string) => state.users.find((u) => u.id === id)?.name ?? id;
  return (
    <div className="rounded-lg border border-line px-3 py-2 text-xs">
      <p className="font-medium text-ink">Strategy package evaluations</p>
      {!rec ?
      <p className="mt-1 text-muted">Not sent to strategy packages (close actions and older signals are evaluated by subscription only).</p> :

      <>
          <p className="mt-1 text-muted">Entries opened {rec.opened.length} · positions closed {rec.closed.length} · blocks skipped {rec.skipped.length}</p>
          <ul className="mt-1 space-y-0.5 text-muted">
            {rec.skipped.map((s) =>
          <li key={s.blockId}>{userName(s.subscriberId)} · {s.reason}</li>
          )}
            {rec.notes.map((n) =>
          <li key={n}>{n}</li>
          )}
          </ul>
        </>
      }
    </div>);

}

/** Central signal administration across demo users. Never displays credential secrets. */
export function AdminWorkspace() {
  const { state, setGlobalHalt, setUserEntriesPaused, setUserSuspended } = useDemo();
  const [params, setParams] = useSearchParams();
  const raw = params.get('section') as Section | null;
  const section: Section = raw && SECTIONS.includes(raw) ? raw : 'overview';
  const setSection = (s: Section) => setParams({ section: s });
  const [haltOpen, setHaltOpen] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);

  const deliveries = state.centralSignals.flatMap((c) => c.deliveries);
  const accountName = (id: string) => state.accounts.find((a) => a.id === id)?.name ?? id;
  const userName = (id: string) => state.users.find((u) => u.id === id)?.name ?? id;

  const counts: {label: string;value: number;to: Section;}[] = [
  { label: 'Active demo users', value: state.users.filter((u) => u.status === 'active').length, to: 'users' },
  { label: 'Connected paper accounts', value: state.accounts.filter((a) => !a.disconnected).length, to: 'users' },
  { label: 'Active subscriptions', value: state.subscriptions.filter((s) => s.status === 'active').length, to: 'users' },
  { label: 'Signals accepted', value: state.centralSignals.filter((c) => c.outcome === 'accepted').length, to: 'feed' },
  { label: 'Signals rejected or duplicate', value: state.centralSignals.filter((c) => c.outcome !== 'accepted').length, to: 'feed' },
  { label: 'Account evaluations skipped', value: deliveries.filter((d) => d.state === 'skipped' || d.state === 'rejected').length, to: 'feed' },
  { label: 'Execution failures', value: deliveries.filter((d) => d.state === 'failed' || d.state === 'unknown').length, to: 'feed' }];


  return (
    <PageContainer title="Admin Workspace" description="Central signal routing, paper signal simulation, delivery outcomes and entry controls across demo users." scope="Administrator preview · simulated data · no credential secrets shown">
      <TabBar<Section>
        label="Admin sections"
        value={section}
        onChange={setSection}
        tabs={[
        { id: 'overview', label: 'Overview' },
        { id: 'routes', label: 'Strategies & Signal Routes' },
        { id: 'compose', label: 'Simulate signal' },
        { id: 'feed', label: 'Central Signal Feed' },
        { id: 'users', label: 'Users & Entry Controls' }]
        } />
      

      {section === 'overview' &&
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          {counts.map((c) =>
        <button key={c.label} type="button" onClick={() => setSection(c.to)} className="rounded-xl border border-line bg-surface p-4 text-left transition-colors duration-150 hover:border-line-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60">
              <p className="text-2xl font-bold tabular-nums text-ink">{c.value}</p>
              <p className="mt-1 text-xs text-muted">{c.label}</p>
            </button>
        )}
        </div>
      }

      {section === 'routes' && <RouteSettings />}
      {section === 'compose' && <SignalComposer />}

      {section === 'feed' &&
      <div className="scrollbar-thin overflow-x-auto rounded-xl border border-line bg-surface">
          {state.centralSignals.length === 0 ?
        <p className="px-4 py-10 text-center text-sm text-muted">No central signals yet. Use Simulate signal to dispatch one.</p> :

        <ul className="min-w-[640px] divide-y divide-line">
              {[...state.centralSignals].sort((a, b) => b.receivedAt - a.receivedAt).map((c: CentralSignal) => {
            const n = deliveryCounts(c);
            const open = expanded === c.id;
            return (
              <li key={c.id}>
                    <button type="button" aria-expanded={open} onClick={() => setExpanded(open ? null : c.id)} className="grid w-full grid-cols-[1.4fr_1fr_1fr_1fr_1.6fr] items-center gap-3 px-4 py-3 text-left text-sm hover:bg-inset focus-visible:bg-inset focus-visible:outline-none">
                      <span className="truncate font-mono text-xs text-ink">{c.signalId}</span>
                      <span className="min-w-0 text-ink">
                        {c.pair} · {ACTION_LABELS[c.action]}
                        <span className="block truncate text-xs text-subtle">{c.routeLabel ?? c.routeId} · {c.triggerLabel ?? 'Supertrend'} · {c.payload.interval || c.timeframe}</span>
                      </span>
                      <span className="tabular-nums text-xs text-subtle">{formatDateTime(c.receivedAt)}</span>
                      <span className="flex flex-wrap gap-1">
                        <StatusPill tone={c.outcome === 'accepted' ? 'gain' : c.outcome === 'duplicate' ? 'warn' : 'loss'}>{c.outcome}</StatusPill>
                        {c.infoOnly && <StatusPill tone="neutral">Information only</StatusPill>}
                      </span>
                      <span className="text-xs text-muted">
                        {c.infoOnly ? 'No trading actions' : `Eligible ${n.eligible} · submitted ${n.submitted} · executed ${n.executed} · skipped ${n.skipped} · failed ${n.failed}`}
                        {c.outcome !== 'accepted' && <span className="block truncate text-loss">{c.reason}</span>}
                      </span>
                    </button>
                    {open &&
                <div className="space-y-2 bg-inset/40 px-4 py-3 text-sm">
                        <p className="text-muted">{c.reason}</p>
                        <ul className="divide-y divide-line rounded-lg border border-line">
                          {c.deliveries.length === 0 && <li className="px-3 py-2 text-muted">{c.infoOnly ? 'Information only — no account evaluations, orders or closes.' : 'No subscription evaluations.'}</li>}
                          {c.deliveries.map((d) =>
                    <li key={d.id} className="flex flex-wrap justify-between gap-2 px-3 py-2">
                              <span className="text-ink">{userName(d.userId)} · {accountName(d.accountId)}</span>
                              <span className="text-xs text-muted">{d.state} — {d.reason}</span>
                            </li>
                    )}
                        </ul>
                        <PackageOutcomes signalId={c.signalId} show={c.outcome === 'accepted' && !c.infoOnly} />
                        <ul className="grid gap-1 text-xs sm:grid-cols-2">
                          {c.checks.filter((k) => k.status === 'fail').map((k) =>
                    <li key={k.id} className="text-loss">{k.label}: {k.detail}</li>
                    )}
                        </ul>
                        <pre className="scrollbar-thin overflow-x-auto rounded-lg border border-line bg-inset p-3 font-mono text-xs text-ink">{JSON.stringify(c.payload, null, 2)}</pre>
                      </div>
                }
                  </li>);

          })}
            </ul>
        }
        </div>
      }

      {section === 'users' &&
      <>
          <section className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line bg-surface p-4">
            <div>
              <h3 className="text-sm font-semibold text-ink">Global Entry Halt</h3>
              <p className="mt-0.5 text-xs text-muted">{state.globalHalt ? 'On — no new entries for any user.' : 'Off.'} Releasing it never resumes individually paused users, accounts or subscriptions.</p>
            </div>
            <Button variant={state.globalHalt ? 'secondary' : 'danger'} onClick={() => setHaltOpen(true)}>
              {state.globalHalt ? 'Release halt' : 'Halt all entries'}
            </Button>
          </section>
          <div className="scrollbar-thin overflow-x-auto rounded-xl border border-line bg-surface">
            <table className="w-full min-w-[720px] text-sm">
              <thead>
                <tr className="border-b border-line text-left text-xs text-subtle">
                  {['User', 'Status', 'Accounts', 'Active subscriptions', 'Open positions', 'Entries', ''].map((h) =>
                <th key={h} scope="col" className="px-3 py-2.5 font-medium">{h}</th>
                )}
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {state.users.map((u) => {
                const accts = state.accounts.filter((a) => ownerOf(a) === u.id);
                const ids = new Set(accts.map((a) => a.id));
                return (
                  <tr key={u.id}>
                      <td className="px-3 py-2.5 text-ink">{u.name}<span className="block text-xs text-subtle">{u.email}</span></td>
                      <td className="px-3 py-2.5 capitalize text-muted">{u.status}</td>
                      <td className="px-3 py-2.5 tabular-nums">{accts.length}</td>
                      <td className="px-3 py-2.5 tabular-nums">{state.subscriptions.filter((s) => ids.has(s.accountId) && s.status === 'active').length}</td>
                      <td className="px-3 py-2.5 tabular-nums">{state.positions.filter((p) => ids.has(p.accountId) && p.quantity > 0).length}</td>
                      <td className="px-3 py-2.5">{u.status === 'suspended' ? <StatusPill tone="loss">Suspended</StatusPill> : u.entriesPaused ? <StatusPill tone="warn">Paused</StatusPill> : <StatusPill tone="gain">Allowed</StatusPill>}</td>
                      <td className="px-3 py-2.5">
                        <div className="flex justify-end gap-2">
                          <Button size="sm" disabled={u.status !== 'active' && u.status !== 'suspended'} onClick={() => setUserEntriesPaused(u.id, !u.entriesPaused)}>
                            {u.entriesPaused ? 'Resume entries' : 'Pause entries'}
                          </Button>
                          <Button size="sm" variant={u.status === 'suspended' ? 'secondary' : 'warn'} disabled={u.status === 'invited'} onClick={() => setUserSuspended(u.id, u.status !== 'suspended')}>
                            {u.status === 'suspended' ? 'Restore' : 'Suspend'}
                          </Button>
                        </div>
                      </td>
                    </tr>);

              })}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-subtle">Suspension blocks new entries while protective management and closing actions continue. Account creation and invitations are on the <Link to="/admin/users" className="text-accent hover:underline">Users</Link> page. Every change is recorded in Logs → Audit Trail.</p>
        </>
      }

      <ConfirmDialog
        open={haltOpen}
        title={state.globalHalt ? 'Release the global entry halt?' : 'Halt all new entries?'}
        description={state.globalHalt ? 'New entries resume only where no narrower pause applies. Paused users, accounts and subscriptions stay paused.' : 'Blocks new entries for every demo user. Protective orders, exits and close signals continue.'}
        confirmLabel={state.globalHalt ? 'Release halt' : 'Halt entries'}
        tone={state.globalHalt ? undefined : 'danger'}
        onConfirm={() => {
          setGlobalHalt(!state.globalHalt);
          setHaltOpen(false);
        }}
        onCancel={() => setHaltOpen(false)} />
      
    </PageContainer>);

}