import React, { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useDemo } from '../contexts/DemoContext';
import { PageContainer } from '../components/layout/PageContainer';
import { FilterSelect } from '../components/ui/FilterSelect';
import { SimpleTable } from '../components/ui/SimpleTable';
import { StatusPill } from '../components/ui/StatusPill';
import { dayTimeToMs } from '../utils/clock';
import { dateKey } from '../utils/reports';
import type { SignalRecord } from '../types/trading';

const RESULT_TONE = { executed: 'gain', skipped: 'warn', rejected: 'loss' } as const;
const RESULT_LABEL = { executed: 'Executed', skipped: 'Skipped', rejected: 'Rejected' } as const;

/** The selected subscriber's own signal outcomes. Other users' outcomes are never shown. */
export function Signals() {
  const { state, accounts, accountName, selectPosition } = useDemo();
  const [accountId, setAccountId] = useState('all');
  const [pair, setPair] = useState('all');
  const [action, setAction] = useState('all');
  const [result, setResult] = useState('all');
  const [date, setDate] = useState('');

  const ids = useMemo(() => new Set(accounts.map((a) => a.id)), [accounts]);
  const mine = useMemo(() => state.signals.filter((s) => ids.has(s.accountId)), [state.signals, ids]);
  const pairs = [...new Set(mine.map((s) => s.pair))].sort();
  const actions = [...new Set(mine.map((s) => s.action))].sort();
  const at = (s: SignalRecord) => s.at ?? dayTimeToMs(s.receivedAt);

  const rows = mine.
  filter((s) => accountId === 'all' || s.accountId === accountId).
  filter((s) => pair === 'all' || s.pair === pair).
  filter((s) => action === 'all' || s.action === action).
  filter((s) => result === 'all' || s.result === result).
  filter((s) => !date || dateKey(at(s), 'Asia/Dhaka') === date).
  sort((a, b) => at(b) - at(a));

  const positionFor = (s: SignalRecord) => {
    const c = s.centralId ? state.centralSignals.find((x) => x.id === s.centralId) : undefined;
    return c?.deliveries.find((d) => d.accountId === s.accountId)?.positionId;
  };

  return (
    <PageContainer title="Signals" description="How each central signal was handled for your accounts, with the reason when it was skipped or rejected." scope="Your accounts only · times in Asia/Dhaka">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-subtle">Date</span>
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="h-9 rounded-lg border border-line bg-inset px-3 text-sm text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/60" />
        </label>
        <FilterSelect label="Account" value={accountId} onChange={setAccountId} options={[{ value: 'all', label: 'All my accounts' }, ...accounts.map((a) => ({ value: a.id, label: a.name }))]} />
        <FilterSelect label="Pair" value={pair} onChange={setPair} options={[{ value: 'all', label: 'All pairs' }, ...pairs.map((p) => ({ value: p, label: p }))]} />
        <FilterSelect label="Action" value={action} onChange={setAction} options={[{ value: 'all', label: 'All actions' }, ...actions.map((a) => ({ value: a, label: a }))]} />
        <FilterSelect label="Outcome" value={result} onChange={setResult} options={[{ value: 'all', label: 'All' }, { value: 'executed', label: 'Executed' }, { value: 'skipped', label: 'Skipped' }, { value: 'rejected', label: 'Rejected' }]} />
      </div>
      <SimpleTable<SignalRecord>
        label="Signal outcomes"
        rows={rows}
        rowKey={(s) => s.id}
        empty={mine.length === 0 ? 'No signals have been evaluated for your accounts yet.' : 'No signals match these filters.'}
        columns={[
        { key: 'rec', header: 'Received', render: (s) => s.receivedAt },
        { key: 'acct', header: 'Account', render: (s) => accountName(s.accountId) },
        { key: 'pair', header: 'Pair', render: (s) => s.pair },
        { key: 'act', header: 'Action', render: (s) => s.action },
        { key: 'tf', header: 'Timeframe', render: (s) => s.timeframe },
        { key: 'candle', header: 'Candle close', render: (s) => s.candleCloseAt },
        { key: 'res', header: 'Outcome', render: (s) => <StatusPill tone={RESULT_TONE[s.result]}>{RESULT_LABEL[s.result]}</StatusPill> },
        { key: 'why', header: 'Reason', className: 'whitespace-normal min-w-[240px]', render: (s) => <span className="text-muted">{s.reason}</span> },
        {
          key: 'link',
          header: '',
          render: (s) => {
            const pos = positionFor(s);
            if (pos) return <button type="button" onClick={() => selectPosition(pos)} className="text-xs font-medium text-accent hover:underline">View position</button>;
            if (s.link) return <Link to={s.link.to} className="text-xs font-medium text-accent hover:underline">{s.link.label}</Link>;
            return null;
          }
        }]
        } />
      
    </PageContainer>);

}