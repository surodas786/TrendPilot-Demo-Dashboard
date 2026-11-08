import React, { useMemo, useState } from 'react';
import { DownloadIcon } from 'lucide-react';
import { useDemo } from '../contexts/DemoContext';
import { PageContainer } from '../components/layout/PageContainer';
import { TabBar } from '../components/ui/TabBar';
import { Button } from '../components/ui/Button';
import { FilterSelect } from '../components/ui/FilterSelect';
import { StatusPill } from '../components/ui/StatusPill';
import { completedTrades, computePeriod, dateKey, dayStart, performance, REPORT_TIMEZONES } from '../utils/reports';
import type { ReportFilters } from '../utils/reports';
import { simNow } from '../utils/clock';
import { formatSigned, formatUsdt } from '../utils/format';
import { exportCsv } from '../utils/csvExport';

type Tab = 'daily' | 'performance' | 'fees' | 'recon';

const money = (v: number | null) => v === null ? 'Boundary data unavailable' : formatUsdt(v);
const signed = (v: number | null) => v === null ? 'Boundary data unavailable' : formatSigned(v);

function Rows({ items }: {items: [string, string][];}) {
  return (
    <dl className="divide-y divide-line rounded-xl border border-line bg-surface text-sm">
      {items.map(([k, v]) =>
      <div key={k} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5">
          <dt className="text-muted">{k}</dt>
          <dd className="tabular-nums text-ink">{v}</dd>
        </div>
      )}
    </dl>);

}

/** Period reports derived from the shared ledger, trades and settlements. */
export function Reports() {
  const { state, accounts } = useDemo();
  const now = simNow();
  const [tab, setTab] = useState<Tab>('daily');
  const [tz, setTz] = useState('Asia/Dhaka');
  const today = dateKey(now, tz);
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(today);
  const [accountId, setAccountId] = useState('all');
  const [pair, setPair] = useState('all');

  const ids = useMemo(() => accountId === 'all' ? accounts.map((a) => a.id) : [accountId], [accountId, accounts]);
  const pairs = useMemo(() => [...new Set(state.positions.concat().map((p) => p.pair).concat(state.tradeRecords.map((t) => t.pair)))].sort(), [state.positions, state.tradeRecords]);
  const filters: ReportFilters = { from, to, tz, accountIds: ids, pair, strategy: 'all' };
  const validRange = from <= to;
  const r = useMemo(() => validRange ? computePeriod(state, filters, from, to, now) : null, [state, from, to, tz, ids, pair, validRange]); // eslint-disable-line react-hooks/exhaustive-deps
  const trades = useMemo(() => completedTrades(state.tradeRecords.filter((t) => ids.includes(t.accountId)), filters, dayStart(from, tz), dayStart(to, tz) + 86_400_000), [state.tradeRecords, ids, from, to, tz, pair]); // eslint-disable-line react-hooks/exhaustive-deps
  const perf = performance(trades);

  const status = !r ? null : !r.complete ? <StatusPill tone="warn">Incomplete</StatusPill> : r.provisional ? <StatusPill tone="warn">Provisional</StatusPill> : <StatusPill tone="gain">Complete</StatusPill>;

  const exportReport = () => {
    if (!r) return;
    const rows: [string, string | number | null][] = [
    ['Opening equity', r.openingEquity],
    ['Closing/current equity', r.closingEquity],
    ['Gross realized P&L', r.gross],
    ['Commissions', r.commissions],
    ['Funding received', r.fundingReceived],
    ['Funding paid', r.fundingPaid],
    ['Net realized P&L', r.netRealized],
    ['Net external inflows', r.inflows],
    ['Corrections', r.corrections],
    ['Trading-related equity change', r.tradingChange],
    ['Reconciliation difference', r.difference]];

    exportCsv(`trendpilot-report-${from}-${to}.csv`, { report: 'Period summary', timezone: tz, filters: [`From ${from}`, `To ${to}`, `Accounts: ${accountId}`, `Pair: ${pair}`, 'Environment: paper'], completeness: r.complete ? r.provisional ? 'Provisional' : 'Complete' : 'Incomplete — boundary data unavailable', scope: 'Selected subscriber accounts only' }, ['Metric', 'USDT'], rows);
  };

  return (
    <PageContainer
      title="Reports"
      description="Daily summary, performance, fees and reconciliation in USDT, derived from the same records as the dashboard."
      scope="Paper environment · selected subscriber's accounts only"
      actions={
      <Button icon={DownloadIcon} onClick={exportReport} disabled={!r}>
          Export CSV
        </Button>
      }>
      
      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-subtle">From</span>
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="h-9 rounded-lg border border-line bg-inset px-3 text-sm text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/60" />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-subtle">To</span>
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="h-9 rounded-lg border border-line bg-inset px-3 text-sm text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/60" />
        </label>
        <FilterSelect label="Timezone" value={tz} onChange={setTz} options={REPORT_TIMEZONES} />
        <FilterSelect label="Account" value={accountId} onChange={setAccountId} options={[{ value: 'all', label: 'All my accounts' }, ...accounts.map((a) => ({ value: a.id, label: a.name }))]} />
        <FilterSelect label="Pair" value={pair} onChange={setPair} options={[{ value: 'all', label: 'All pairs' }, ...pairs.map((p) => ({ value: p, label: p }))]} />
      </div>
      {!validRange && <p className="text-sm text-loss" role="alert">“From” must be on or before “To”.</p>}

      <TabBar<Tab>
        label="Report sections"
        value={tab}
        onChange={setTab}
        tabs={[
        { id: 'daily', label: 'Daily Summary' },
        { id: 'performance', label: 'Trading Performance' },
        { id: 'fees', label: 'Fees & Funding' },
        { id: 'recon', label: 'Reconciliation' }]
        } />
      

      {r &&
      <div className="flex items-center gap-2 text-xs text-subtle">
          {status}
          <span>{r.closingIsCurrent ? 'Closing values are current (period not finished).' : 'Closing values at period end.'}</span>
          {r.updatedBy.length > 0 && <StatusPill tone="accent">Updated by late events</StatusPill>}
        </div>
      }

      {r && tab === 'daily' &&
      <Rows
        items={[
        ['Opening equity', money(r.openingEquity)],
        [r.closingIsCurrent ? 'Current equity' : 'Closing equity', money(r.closingEquity)],
        ['Gross realized trading P&L', formatSigned(r.gross)],
        ['Commissions', formatUsdt(r.commissions)],
        ['Funding received', formatUsdt(r.fundingReceived)],
        ['Funding paid', formatUsdt(r.fundingPaid)],
        ['Net realized P&L', formatSigned(r.netRealized)],
        ['Opening unrealized P&L', signed(r.openingUnrealized)],
        [r.closingIsCurrent ? 'Current unrealized P&L' : 'Closing unrealized P&L', signed(r.closingUnrealized)],
        ['Net external paper inflows', formatUsdt(r.inflows)],
        ['Trading-related equity change', signed(r.tradingChange)],
        ['Trades opened · completed', `${r.tradesOpened} · ${r.tradesCompleted}`],
        ['Positions remaining open', r.openPositions === null ? 'Not available' : String(r.openPositions)]]
        } />

      }

      {r && tab === 'performance' &&
      <>
          <Rows
          items={[
          ['Completed trades', String(perf.trades)],
          ['Wins · losses · breakeven', `${perf.wins} · ${perf.losses} · ${perf.breakeven}`],
          ['Win rate', perf.winRate === null ? 'Not available' : `${perf.winRate.toFixed(1)}%`],
          ['Average net winning trade', perf.avgWin === null ? 'Not available' : formatSigned(perf.avgWin)],
          ['Average net losing trade', perf.avgLoss === null ? 'Not available' : formatSigned(perf.avgLoss)],
          ['Net completed-trade P&L', formatSigned(perf.net)]]
          } />
        
          <p className="text-xs text-subtle">Uses itemized completed trades only, net of recorded fees and attributed funding. Win rate excludes breakeven trades (|net| rounds to 0.00). Unallocated funding and seeded summaries are excluded.</p>
        </>
      }

      {r && tab === 'fees' &&
      <Rows
        items={[
        ['Entry commissions', formatUsdt(r.entryFees)],
        ['Exit commissions', formatUsdt(r.exitFees)],
        ['Funding paid', formatUsdt(r.fundingPaid)],
        ['Funding received', formatUsdt(r.fundingReceived)],
        ['Net funding', formatSigned(r.fundingReceived - r.fundingPaid)],
        ['Trade-attributed funding', formatSigned(r.attributedFunding)],
        ['Unallocated funding', formatSigned(r.unallocatedFunding)]]
        } />

      }

      {r && tab === 'recon' &&
      <>
          <Rows
          items={[
          ['Opening wallet', money(r.openingWallet)],
          ['Trading P&L (gross)', formatSigned(r.gross)],
          ['Fees', formatSigned(-r.commissions)],
          ['Funding', formatSigned(r.fundingReceived - r.fundingPaid)],
          ['External paper transfers', formatSigned(r.inflows)],
          ['Explicit corrections', formatSigned(r.corrections)],
          ['Closing/current wallet', money(r.closingWallet)],
          ['Expected trading change', signed(r.expectedChange)],
          ['Remaining difference', signed(r.difference)]]
          } />
        
          <p className="text-sm">{r.reconciled ? <StatusPill tone="gain">Reconciled within 0.01 USDT</StatusPill> : <StatusPill tone="warn">Not reconciled — data incomplete or difference above 0.01 USDT</StatusPill>}</p>
        </>
      }
    </PageContainer>);

}