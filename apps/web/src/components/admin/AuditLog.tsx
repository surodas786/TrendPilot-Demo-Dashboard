'use client';

import React, { useState } from 'react';
import type { AuditEventDto } from '@trendpilot/db';
import { request } from '@/lib/api';
import { Button } from '../ui/Button';
import { FilterSelect } from '../ui/FilterSelect';
import { StatusPill } from '../ui/StatusPill';

const FILTERS = [
  { value: '', label: 'All actions' },
  { value: 'ADMIN_', label: 'Admin changes' },
  { value: 'ORDER_BLOCK_', label: 'Trade settings' },
  { value: 'ACCOUNT_', label: 'Account security' },
  { value: 'AUTH_', label: 'Sign-in' }
];

const resultTone = { SUCCESS: 'gain', DENIED: 'loss', FAILED: 'warn' } as const;

/** OPS-04: append-only audit history with actor, time and action. */
export function AuditLog({ initial, timezone }: { initial: { items: AuditEventDto[]; nextCursor: string | null }; timezone: string }) {
  const [items, setItems] = useState(initial.items);
  const [cursor, setCursor] = useState(initial.nextCursor);
  const [filter, setFilter] = useState('');
  const [open, setOpen] = useState<string | null>(null);

  const load = async (action: string, after?: string | null) => {
    const q = new URLSearchParams({ limit: '50' });
    if (action) q.set('action', action);
    if (after) q.set('cursor', after);
    const r = await request<{ items: AuditEventDto[]; nextCursor: string | null }>('GET', `/v1/admin/audit?${q}`);
    if (!r.ok) return;
    setItems((prev) => (after ? [...prev, ...r.data.items] : r.data.items));
    setCursor(r.data.nextCursor);
  };

  return (
    <div className="space-y-3">
      <div className="w-60">
        <FilterSelect
          label="Show"
          value={filter}
          onChange={(v) => {
            setFilter(v);
            void load(v);
          }}
          options={FILTERS}
        />
      </div>
      <div className="overflow-x-auto rounded-xl border border-line bg-surface">
        <table className="w-full min-w-[820px] text-left text-sm">
          <thead className="border-b border-line text-xs text-subtle">
            <tr>
              <th scope="col" className="px-4 py-2.5 font-medium">Time ({timezone})</th>
              <th scope="col" className="px-4 py-2.5 font-medium">Actor</th>
              <th scope="col" className="px-4 py-2.5 font-medium">Action</th>
              <th scope="col" className="px-4 py-2.5 font-medium">Target</th>
              <th scope="col" className="px-4 py-2.5 font-medium">Result</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {items.map((e) => (
              <React.Fragment key={e.id}>
                <tr data-testid="audit-row" className="cursor-pointer hover:bg-inset" onClick={() => setOpen(open === e.id ? null : e.id)}>
                  <td className="whitespace-nowrap px-4 py-2 text-muted">{new Date(e.at).toLocaleString('en-GB', { timeZone: timezone })}</td>
                  <td className="px-4 py-2 text-ink">{e.actor ? e.actor.email : <span className="text-subtle">anonymous</span>}</td>
                  <td className="px-4 py-2 font-mono text-xs text-ink">{e.action}</td>
                  <td className="px-4 py-2 text-xs text-muted">
                    {e.targetType}
                    {e.targetId ? ` · ${e.targetId.slice(0, 8)}` : ''}
                  </td>
                  <td className="px-4 py-2">
                    <StatusPill tone={resultTone[e.result as keyof typeof resultTone] ?? 'neutral'}>{e.result}</StatusPill>
                  </td>
                </tr>
                {open === e.id && (
                  <tr>
                    <td colSpan={5} className="bg-inset px-4 py-3">
                      <pre className="max-h-64 overflow-auto whitespace-pre-wrap text-xs text-muted">
                        {JSON.stringify({ before: e.before, after: e.after, metadata: e.metadata, correlationId: e.correlationId }, null, 2)}
                      </pre>
                    </td>
                  </tr>
                )}
              </React.Fragment>
            ))}
            {items.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-6 text-center text-subtle">
                  No events.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {cursor && <Button onClick={() => load(filter, cursor)}>Load older events</Button>}
    </div>
  );
}
