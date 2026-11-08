import React, { useMemo, useState } from 'react';
import { DownloadIcon } from 'lucide-react';
import { useDemo } from '../contexts/DemoContext';
import { PageContainer } from '../components/layout/PageContainer';
import { FilterSelect } from '../components/ui/FilterSelect';
import { Button } from '../components/ui/Button';
import { SimpleTable } from '../components/ui/SimpleTable';
import { PnlText } from '../components/ui/PnlText';
import { formatDateTime } from '../utils/clock';
import { formatNumber, formatUsdt } from '../utils/format';
import { buildTradeCsv, downloadCsv } from '../utils/tradeCsv';
import type { TradeRecord } from '../types/execution';

const PAGE_SIZE = 20;

/** Itemized completed trades for the selected subscriber's paper accounts. */
export function TradeHistory() {
  const { state, accounts, accountName, selectPosition } = useDemo();
  const [accountId, setAccountId] = useState('all');
  const [pair, setPair] = useState('all');
  const [direction, setDirection] = useState('all');
  const [outcome, setOutcome] = useState('all');
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(0);

  const visibleIds = useMemo(() => new Set(accounts.map((a) => a.id)), [accounts]);
  const mine = useMemo(() => state.tradeRecords.filter((t) => visibleIds.has(t.accountId)), [state.tradeRecords, visibleIds]);
  const pairs = useMemo(() => [...new Set(mine.map((t) => t.pair))].sort(), [mine]);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return mine.
    filter((t) => accountId === 'all' || t.accountId === accountId).
    filter((t) => pair === 'all' || t.pair === pair).
    filter((t) => direction === 'all' || t.direction === direction).
    filter((t) => outcome === 'all' || (outcome === 'win' ? t.net > 0.005 : outcome === 'loss' ? t.net < -0.005 : Math.abs(t.net) <= 0.005)).
    filter((t) => !q || t.id.toLowerCase().includes(q) || t.positionId.toLowerCase().includes(q)).
    sort((a, b) => b.exitAt - a.exitAt);
  }, [mine, accountId, pair, direction, outcome, query]);

  const pageRows = rows.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const reset = <T,>(fn: (v: T) => void) => (v: T) => {
    fn(v);
    setPage(0);
  };

  const exportRows = () => {
    const filters = [`Account: ${accountId === 'all' ? 'All my accounts' : accountName(accountId)}`, `Pair: ${pair}`, `Direction: ${direction}`, `Outcome: ${outcome}`];
    downloadCsv('trendpilot-trade-history.csv', buildTradeCsv(rows, { accountName: accountId === 'all' ? 'All my accounts' : accountName(accountId), exchange: 'MEXC Futures (paper)', filters }));
  };

  return (
    <PageContainer
      title="Trade History"
      description="Completed paper trades with fees and funding. A trade appears only after its position is fully closed."
      scope={`Showing ${accounts.length} paper account${accounts.length === 1 ? '' : 's'} for this subscriber. Times in Asia/Dhaka.`}
      actions={
      <Button icon={DownloadIcon} onClick={exportRows} disabled={rows.length === 0}>
          Export CSV
        </Button>
      }>
      
      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        <FilterSelect label="Account" value={accountId} onChange={reset(setAccountId)} options={[{ value: 'all', label: 'All my accounts' }, ...accounts.map((a) => ({ value: a.id, label: a.name }))]} />
        <FilterSelect label="Pair" value={pair} onChange={reset(setPair)} options={[{ value: 'all', label: 'All pairs' }, ...pairs.map((p) => ({ value: p, label: p }))]} />
        <FilterSelect label="Direction" value={direction} onChange={reset(setDirection)} options={[{ value: 'all', label: 'Both' }, { value: 'long', label: 'Long' }, { value: 'short', label: 'Short' }]} />
        <FilterSelect label="Outcome" value={outcome} onChange={reset(setOutcome)} options={[{ value: 'all', label: 'All' }, { value: 'win', label: 'Win' }, { value: 'loss', label: 'Loss' }, { value: 'even', label: 'Breakeven' }]} />
        <label className="col-span-2 flex flex-col gap-1 md:col-span-1">
          <span className="text-xs font-medium text-subtle">Trade or position ID</span>
          <input value={query} onChange={(e) => reset(setQuery)(e.target.value)} placeholder="Search" className="h-9 rounded-lg border border-line bg-inset px-3 text-sm text-ink placeholder:text-subtle focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/60" />
        </label>
      </div>

      <SimpleTable<TradeRecord>
        label="Completed trades"
        rows={pageRows}
        rowKey={(t) => t.id}
        empty={mine.length === 0 ? 'No completed trades yet. Opening demo balances include a historical summary without itemized trades.' : 'No trades match these filters.'}
        onRowClick={(t) => selectPosition(t.positionId)}
        columns={[
        { key: 'id', header: 'Trade', render: (t) => <span className="font-mono text-xs">{t.id}</span> },
        { key: 'acct', header: 'Account', render: (t) => accountName(t.accountId) },
        { key: 'pair', header: 'Pair', render: (t) => `${t.pair} · ${t.direction === 'long' ? '▲ Long' : '▼ Short'}` },
        { key: 'entry', header: 'Avg entry', align: 'right', render: (t) => formatNumber(t.avgEntry, t.priceDecimals) },
        { key: 'exit', header: 'Avg exit', align: 'right', render: (t) => formatNumber(t.avgExit, t.priceDecimals) },
        { key: 'gross', header: 'Gross', align: 'right', render: (t) => formatUsdt(t.gross) },
        { key: 'fees', header: 'Fees', align: 'right', render: (t) => formatUsdt(t.commissions) },
        { key: 'net', header: 'Net', align: 'right', render: (t) => <PnlText value={t.net} /> },
        { key: 'reason', header: 'Exit reason', render: (t) => t.exitReason },
        { key: 'at', header: 'Closed (Asia/Dhaka)', render: (t) => formatDateTime(t.exitAt) }]
        } />
      

      {rows.length > PAGE_SIZE &&
      <div className="flex items-center justify-end gap-2 text-sm text-muted">
          <Button size="sm" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>
            Previous
          </Button>
          <span>
            Page {page + 1} of {pages}
          </span>
          <Button size="sm" disabled={page >= pages - 1} onClick={() => setPage((p) => p + 1)}>
            Next
          </Button>
        </div>
      }
      <p className="text-xs text-subtle">Trades opened through Trade Settings token blocks are listed under Holdings → Closed Trades.</p>
    </PageContainer>);

}