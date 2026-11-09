'use client';

import React, { useState } from 'react';
import type { OperationsDto } from '@trendpilot/db';
import { request } from '@/lib/api';
import { Button } from '../ui/Button';
import { StatusPill, type PillTone } from '../ui/StatusPill';

const fmt = (iso: string | null, tz: string) => (iso ? new Intl.DateTimeFormat('en-GB', { timeZone: tz, dateStyle: 'short', timeStyle: 'medium' }).format(new Date(iso)) : '—');
const svcTone: Record<string, PillTone> = { REPORTING: 'gain', NOT_REPORTING: 'loss', NEVER_STARTED: 'loss', STOPPED: 'neutral' };
const svcLabel: Record<string, string> = { REPORTING: 'Reporting', NOT_REPORTING: 'Not reporting', NEVER_STARTED: 'Never started', STOPPED: 'Stopped' };

function Tile({ label, children, testId }: { label: string; children: React.ReactNode; testId: string }) {
  return (
    <div className="rounded-xl border border-line bg-surface p-4" data-testid={testId}>
      <p className="text-xs text-subtle">{label}</p>
      <div className="mt-1.5 text-sm text-ink">{children}</div>
    </div>
  );
}

/** UI-05 Operations: liveness, queue, failures and feed health, with alerts in text as well as colour. */
export function OperationsAdmin({ initial, timezone }: { initial: OperationsDto; timezone: string }) {
  const [d, setD] = useState(initial);
  const [busy, setBusy] = useState(false);
  const refresh = async () => {
    setBusy(true);
    const r = await request<OperationsDto>('GET', '/v1/admin/operations');
    if (r.ok) setD(r.data);
    setBusy(false);
  };
  const feedStates = d.feed.contracts.filter((c) => c.instrumentStatus === 'PUBLISHED');

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-subtle">
          Checked {fmt(d.checkedAt, timezone)} ({timezone})
        </p>
        <Button variant="secondary" onClick={() => void refresh()} disabled={busy}>
          {busy ? 'Refreshing…' : 'Refresh'}
        </Button>
      </div>

      <section aria-label="Alerts" data-testid="ops-alerts">
        {d.alerts.length === 0 ? (
          <p className="rounded-xl border border-gain/30 bg-gain/5 p-3 text-sm text-gain">All checks passing.</p>
        ) : (
          <ul className="space-y-1.5">
            {d.alerts.map((a, i) => (
              <li key={i} className={`rounded-lg border p-2.5 text-sm ${a.level === 'ERROR' ? 'border-loss/35 bg-loss/5 text-loss' : 'border-warn/35 bg-warn/5 text-warn'}`} data-level={a.level}>
                <span className="font-semibold">{a.level === 'ERROR' ? 'Error' : 'Warning'}:</span> {a.message}
              </li>
            ))}
          </ul>
        )}
      </section>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <Tile label="Mode" testId="ops-mode">
          <StatusPill tone="warn">Paper</StatusPill>
          <p className="mt-1 text-xs text-muted">Live order transport: {d.liveOrderTransport}</p>
        </Tile>
        <Tile label="Database" testId="ops-database">
          <StatusPill tone={d.database.ok ? 'gain' : 'loss'}>{d.database.ok ? 'Up' : 'Down'}</StatusPill>
          <p className="mt-1 text-xs text-muted">{d.database.ok ? `${d.database.latencyMs} ms` : d.database.error}</p>
        </Tile>
        <Tile label="Worker" testId="ops-worker">
          <StatusPill tone={svcTone[d.serviceSummary.worker]!}>{svcLabel[d.serviceSummary.worker]}</StatusPill>
        </Tile>
        <Tile label="Market feed" testId="ops-feed">
          <StatusPill tone={svcTone[d.serviceSummary['market-feed']]!}>{svcLabel[d.serviceSummary['market-feed']]}</StatusPill>
          <p className="mt-1 text-xs text-muted">{feedStates.map((c) => `${c.symbol} ${c.feed?.state ?? 'not started'}`).join(' · ') || 'No published contracts'}</p>
        </Tile>
        <Tile label="Job queue" testId="ops-jobs">
          <span>
            {d.jobs.pending} pending · {d.jobs.running} running ·{' '}
            <span className={d.jobs.dead ? 'font-semibold text-loss' : ''} data-testid="ops-dead">
              {d.jobs.dead} failed
            </span>
          </span>
          <p className="mt-1 text-xs text-muted">
            {d.jobs.dueBacklog} due{d.jobs.oldestDueSeconds !== null ? `, oldest ${d.jobs.oldestDueSeconds} s` : ''} · {d.jobs.retrying} retrying
          </p>
        </Tile>
      </div>

      <section className="space-y-2">
        <h3 className="text-sm font-semibold text-ink">Services</h3>
        <div className="overflow-x-auto rounded-xl border border-line bg-surface">
          <table className="w-full min-w-[720px] text-left text-sm" aria-label="Services">
            <thead className="border-b border-line text-xs text-subtle">
              <tr>
                <th scope="col" className="px-4 py-2 font-medium">Service</th>
                <th scope="col" className="px-4 py-2 font-medium">Instance</th>
                <th scope="col" className="px-4 py-2 font-medium">State</th>
                <th scope="col" className="px-4 py-2 font-medium">Last seen</th>
                <th scope="col" className="px-4 py-2 font-medium">Detail</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line/60">
              {d.services.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-4 py-3 text-xs text-subtle">
                    No service has reported yet.
                  </td>
                </tr>
              ) : (
                d.services.slice(0, 10).map((s) => (
                  <tr key={`${s.service}-${s.instance}`} data-testid={`svc-${s.service}`} data-state={s.state}>
                    <td className="px-4 py-2 font-medium text-ink">{s.service}</td>
                    <td className="px-4 py-2 font-mono text-xs text-muted">{s.instance}</td>
                    <td className="px-4 py-2">
                      <StatusPill tone={svcTone[s.state]!}>{svcLabel[s.state]}</StatusPill>
                    </td>
                    <td className="px-4 py-2 text-xs text-muted">
                      {fmt(s.lastSeenAt, timezone)} ({s.ageSeconds} s ago)
                    </td>
                    <td className="px-4 py-2 font-mono text-[11px] text-subtle">{JSON.stringify(s.detail).slice(0, 160)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="space-y-2">
        <h3 className="text-sm font-semibold text-ink">Recent job failures</h3>
        {d.jobs.recentFailures.length === 0 ? (
          <p className="text-xs text-subtle">No failed or retrying jobs.</p>
        ) : (
          <ul className="divide-y divide-line/60 rounded-xl border border-line bg-surface text-sm" aria-label="Job failures">
            {d.jobs.recentFailures.map((j) => (
              <li key={j.id} className="flex flex-col gap-0.5 px-4 py-2.5 md:flex-row md:gap-4" data-testid="job-failure" data-status={j.status}>
                <span className="w-44 shrink-0 text-xs text-subtle">{fmt(j.updatedAt, timezone)}</span>
                <span className="w-56 shrink-0 font-mono text-xs text-muted">
                  {j.kind} · {j.status === 'DEAD' ? 'failed' : 'retrying'} ({j.attempts}/{j.maxAttempts})
                </span>
                <span className="text-xs text-ink">{j.lastError}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="space-y-2">
        <h3 className="text-sm font-semibold text-ink">Recent feed events</h3>
        {d.feed.events.length === 0 ? (
          <p className="text-xs text-subtle">No feed events yet.</p>
        ) : (
          <ul className="divide-y divide-line/60 rounded-xl border border-line bg-surface text-sm" aria-label="Feed events">
            {d.feed.events.map((e) => (
              <li key={e.id} className="flex flex-col gap-0.5 px-4 py-2.5 md:flex-row md:gap-4" data-testid="feed-event" data-kind={e.kind}>
                <span className="w-44 shrink-0 text-xs text-subtle">{fmt(e.createdAt, timezone)}</span>
                <span className="w-40 shrink-0 font-mono text-xs text-muted">{e.kind}</span>
                <span className="text-xs text-ink">{e.message}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
