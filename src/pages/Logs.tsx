import React, { useMemo, useState } from 'react';
import { DownloadIcon } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useDemo } from '../contexts/DemoContext';
import { PageContainer } from '../components/layout/PageContainer';
import { TabBar } from '../components/ui/TabBar';
import { Button } from '../components/ui/Button';
import { FilterSelect } from '../components/ui/FilterSelect';
import { StatusPill } from '../components/ui/StatusPill';
import { buildLogEvents } from '../utils/logEvents';
import type { LogEvent, LogTab } from '../utils/logEvents';
import { formatDateTime } from '../utils/clock';
import { exportCsv } from '../utils/csvExport';

const SEVERITY_TONE = { info: 'neutral', warning: 'warn', critical: 'loss' } as const;

/** Read-only trading, operational and audit events derived from shared records. */
export function Logs() {
  const { state, currentUser, accountName, selectPosition } = useDemo();
  const admin = state.role === 'admin';
  const [tab, setTab] = useState<LogTab>('trading');
  const [severity, setSeverity] = useState('all');
  const [outcome, setOutcome] = useState('all');
  const [type, setType] = useState('all');
  const [query, setQuery] = useState('');

  const all = useMemo(() => buildLogEvents(state, { userId: currentUser.id, admin }), [state, currentUser.id, admin]);
  const inTab = all.filter((e) => e.tab === tab);
  const types = [...new Set(inTab.map((e) => e.type))].sort();
  const q = query.trim().toLowerCase();
  const rows = inTab.
  filter((e) => severity === 'all' || e.severity === severity).
  filter((e) => outcome === 'all' || e.outcome === outcome).
  filter((e) => type === 'all' || e.type === type).
  filter((e) => !q || e.refs.some((r) => r.toLowerCase().includes(q)) || e.id.toLowerCase().includes(q) || (e.pair ?? '').toLowerCase().includes(q));

  const changeTab = (t: LogTab) => {
    setTab(t);
    setType('all');
  };

  const exportRows = () =>
  exportCsv(
    `trendpilot-logs-${tab}.csv`,
    { report: `Logs — ${tab}`, timezone: 'Asia/Dhaka', filters: [`Severity: ${severity}`, `Outcome: ${outcome}`, `Type: ${type}`, `Search: ${query || 'none'}`], completeness: 'Demo records in this browser session', scope: admin ? 'All demo users (administrator preview)' : `${currentUser.name} only` },
    ['Event', 'Time', 'Account', 'Pair', 'Severity', 'Type', 'Outcome', 'Title', 'Detail', 'Operator', 'Previous', 'New', 'Reason'],
    rows.map((e) => [e.id, formatDateTime(e.at), e.accountId ? accountName(e.accountId) : '', e.pair, e.severity, e.type, e.outcome, e.title, e.detail, e.operator, e.previous, e.next, e.reason])
  );

  return (
    <PageContainer
      title="Logs"
      description="Read-only record of signal evaluations, orders, fills, protection changes, operational issues and configuration changes."
      scope={`${admin ? 'All demo users (administrator preview)' : `${currentUser.name}'s accounts only`} · times in Asia/Dhaka · demo audit, not tamper-resistant`}
      actions={
      <Button icon={DownloadIcon} onClick={exportRows} disabled={rows.length === 0}>
          Export CSV
        </Button>
      }>
      
      <TabBar<LogTab>
        label="Log sections"
        value={tab}
        onChange={changeTab}
        tabs={[
        { id: 'trading', label: 'Trading Events' },
        { id: 'operational', label: 'Operational Events' },
        { id: 'audit', label: 'Audit Trail' }]
        } />
      
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <FilterSelect label="Severity" value={severity} onChange={setSeverity} options={[{ value: 'all', label: 'All' }, { value: 'info', label: 'Info' }, { value: 'warning', label: 'Warning' }, { value: 'critical', label: 'Critical' }]} />
        <FilterSelect label="Outcome" value={outcome} onChange={setOutcome} options={[{ value: 'all', label: 'All' }, { value: 'success', label: 'Success' }, { value: 'failure', label: 'Failure' }, { value: 'skipped', label: 'Skipped' }, { value: 'info', label: 'Info' }]} />
        <FilterSelect label="Event type" value={type} onChange={setType} options={[{ value: 'all', label: 'All types' }, ...types.map((t) => ({ value: t, label: t }))]} />
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-subtle">Signal, trade, order or ID</span>
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search" className="h-9 rounded-lg border border-line bg-inset px-3 text-sm text-ink placeholder:text-subtle focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/60" />
        </label>
      </div>

      {rows.length === 0 ?
      <p className="rounded-xl border border-dashed border-line-strong bg-surface px-4 py-10 text-center text-sm text-muted">No events match these filters.</p> :

      <ol className="divide-y divide-line rounded-xl border border-line bg-surface">
          {rows.slice(0, 200).map((e: LogEvent) =>
        <li key={e.id} className="flex flex-col gap-1 px-4 py-3 text-sm sm:flex-row sm:items-start sm:gap-4">
              <span className="w-40 shrink-0 tabular-nums text-xs text-subtle">{formatDateTime(e.at)}</span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <StatusPill tone={SEVERITY_TONE[e.severity]}>{e.severity}</StatusPill>
                  <span className="text-xs text-subtle">{e.type}</span>
                  <span className="font-medium text-ink">{e.title}</span>
                </div>
                <p className="mt-0.5 break-words text-muted">{e.detail}</p>
                {tab === 'audit' && (e.operator || e.previous || e.next) &&
            <p className="mt-1 text-xs text-subtle">
                    {e.operator && <>Operator: {e.operator} · </>}
                    {e.scope && <>Scope: {e.scope} · </>}
                    {e.previous !== undefined && <>Previous: {e.previous} · </>}
                    {e.next !== undefined && <>New: {e.next}</>}
                    {e.reason && <> · Reason: {e.reason}</>}
                  </p>
            }
                <p className="mt-1 text-xs text-subtle">
                  {e.accountId ? accountName(e.accountId) : 'Platform'}
                  {e.pair ? ` · ${e.pair}` : ''}
                  {e.link && (
              e.link.positionId ?
              <button type="button" onClick={() => selectPosition(e.link!.positionId!)} className="ml-2 font-medium text-accent hover:underline">
                        {e.link.label}
                      </button> :

              <Link to={e.link.to} className="ml-2 font-medium text-accent hover:underline">
                        {e.link.label}
                      </Link>)
              }
                </p>
              </div>
            </li>
        )}
        </ol>
      }
      {rows.length > 200 && <p className="text-xs text-subtle">Showing the latest 200 of {rows.length} events. Narrow the filters or export CSV for the full list.</p>}
    </PageContainer>);

}