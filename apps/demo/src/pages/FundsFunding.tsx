import React, { useMemo, useState } from 'react';
import { DownloadIcon, PlusIcon, RefreshCwIcon } from 'lucide-react';
import { toast } from 'sonner';
import { useDemo } from '../contexts/DemoContext';
import { streamsFor } from '../contexts/financeReducer';
import { PageContainer } from '../components/layout/PageContainer';
import { TabBar } from '../components/ui/TabBar';
import { Button } from '../components/ui/Button';
import { ConfirmDialog } from '../components/ui/ConfirmDialog';
import { FilterSelect } from '../components/ui/FilterSelect';
import { SimpleTable } from '../components/ui/SimpleTable';
import { StatusPill } from '../components/ui/StatusPill';
import { EmptyState } from '../components/ui/EmptyState';
import { buildLedgerRows, FINANCIAL_TYPES, LEDGER_TYPE_LABELS } from '../utils/ledger';
import type { LedgerRow } from '../utils/ledger';
import { fundingAmount, settlementFor } from '../utils/funding';
import { nextFundingSlot, SIM_FUNDING_RATES, SYNC_STREAMS } from '../data/financeConfig';
import { formatDateTime, formatSyncTime, simNow } from '../utils/clock';
import { formatSigned, formatUsdt } from '../utils/format';
import { exportCsv } from '../utils/csvExport';
import type { FundingSettlement } from '../types/finance';
import type { Position } from '../types/trading';
import { WalletIcon } from 'lucide-react';

type Tab = 'overview' | 'ledger' | 'funding' | 'sync';

/** Wallet, ledger, funding and synchronization for the selected paper account. */
export function FundsFunding() {
  const demo = useDemo();
  const { state, summaries, accountPositions, addFunds, dispatchFinance, runFinanceSync } = demo;
  // Never fall back to another user's account when this subscriber has none.
  const account = demo.accounts.length > 0 ? demo.account : undefined;
  const [tab, setTab] = useState<Tab>('overview');
  const [amount, setAmount] = useState('500');
  const [showOps, setShowOps] = useState(false);
  const [typeFilter, setTypeFilter] = useState('all');
  const [pending, setPending] = useState<Position | null>(null);

  const summary = account ? summaries[account.id] : undefined;
  const ledger = useMemo(() => {
    if (!account) return [];
    const id = account.id;
    return buildLedgerRows({
      account,
      ledger: state.closedTrades.filter((t) => t.accountId === id),
      transfers: state.transfers.filter((t) => t.accountId === id),
      settlements: state.fundingSettlements.filter((s) => s.accountId === id),
      tradeRecords: state.tradeRecords.filter((t) => t.accountId === id),
      orders: state.orders.filter((o) => o.accountId === id)
    });
  }, [account, state.closedTrades, state.transfers, state.fundingSettlements, state.tradeRecords, state.orders]);

  if (!account || !summary) {
    return (
      <PageContainer title="Funds & Funding" description="Wallet balance, ledger, funding settlements and synchronization.">
        <EmptyState icon={WalletIcon} title="No paper account" body="This subscriber has no paper account with wallet records yet." />
      </PageContainer>);

  }

  const rows = ledger.filter((r) => (showOps || !r.operational) && (typeFilter === 'all' || r.type === typeFilter));
  const settlements = state.fundingSettlements.filter((s) => s.accountId === account.id).sort((a, b) => b.effectiveAt - a.effectiveAt);
  const streams = streamsFor(state, account.id);
  const discrepancies = state.discrepancies.filter((d) => d.accountId === account.id && d.status === 'open');
  const open = accountPositions.filter((p) => p.quantity > 0);

  const submitFunds = () => {
    const v = Number(amount);
    if (!Number.isFinite(v) || v <= 0) return toast.error('Enter an amount greater than 0.');
    addFunds(account.id, v);
    toast.success(`${formatUsdt(v)} USDT virtual funds added`, { description: 'Recorded once as an external paper transfer. Not trading P&L.' });
  };

  const applySettlement = (p: Position) => {
    const req = settlementFor(p, simNow());
    const exists = state.fundingSettlements.some((s) => s.id === req.settlementId);
    if (exists) {
      toast('Already recorded', { description: `${req.settlementId} — no further wallet movement.` });
    } else {
      dispatchFinance({ ...req, at: simNow() });
      toast.success('Simulated settlement recorded');
    }
    setPending(null);
  };

  const exportLedger = () =>
  exportCsv(
    `trendpilot-ledger-${account.id}.csv`,
    { report: 'Account ledger', timezone: 'Asia/Dhaka', filters: [`Account: ${account.name}`, `Type: ${typeFilter}`, `Operational events: ${showOps ? 'shown' : 'hidden'}`], completeness: discrepancies.length ? 'Provisional — open reconciliation difference' : 'Complete for itemized records', scope: 'Selected subscriber account only' },
    ['Event ID', 'Effective', 'Recorded', 'Type', 'Pair', 'Related', 'Wallet movement USDT', 'Running balance USDT', 'Status'],
    rows.map((r) => [r.id, formatDateTime(r.effectiveAt), formatDateTime(r.recordedAt), LEDGER_TYPE_LABELS[r.type], r.pair, r.related?.label, r.operational ? 0 : r.amount, r.running, r.status])
  );

  return (
    <PageContainer title="Funds & Funding" description="Wallet balance, ledger, funding settlements and synchronization for the selected paper account." scope={`${account.name} · simulated paper data · times in Asia/Dhaka`}>
      <TabBar<Tab>
        label="Funds sections"
        value={tab}
        onChange={setTab}
        tabs={[
        { id: 'overview', label: 'Account Overview' },
        { id: 'ledger', label: 'Account Ledger' },
        { id: 'funding', label: 'Funding Settlements' },
        { id: 'sync', label: 'Synchronization', badge: discrepancies.length }]
        } />
      

      {tab === 'overview' &&
      <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
          <section className="rounded-xl border border-line bg-surface p-5">
            <p className="text-xs text-subtle">Equity (wallet + unrealized)</p>
            <p className="mt-1 text-3xl font-bold tabular-nums text-ink">{formatUsdt(summary.currentEquity)} <span className="text-base font-medium text-muted">USDT</span></p>
            <dl className="mt-5 grid grid-cols-2 gap-x-6 gap-y-3 text-sm sm:grid-cols-3">
              {[
            ['Wallet balance', formatUsdt(summary.walletBalance)],
            ['Unrealized P&L', formatSigned(summary.unrealized)],
            ['Used position margin', formatUsdt(summary.usedMargin)],
            ['Pending entry reservations', formatUsdt(summary.reservedMargin)],
            ['Available margin', formatUsdt(summary.availableMargin)],
            ['Last balance sync', formatSyncTime(streams.balances.lastSuccessAt)]].
            map(([k, v]) =>
            <div key={k}>
                  <dt className="text-xs text-subtle">{k}</dt>
                  <dd className="mt-0.5 tabular-nums text-ink">{v}</dd>
                </div>
            )}
            </dl>
            <p className="mt-4 text-xs text-subtle">Available margin = equity − used margin − pending reservations. A free-margin reserve, if configured, is a trading-policy limit, not a debit.</p>
          </section>
          <section className="rounded-xl border border-line bg-surface p-5">
            <h3 className="text-sm font-semibold text-ink">Add virtual funds</h3>
            <p className="mt-1 text-xs text-muted">Recorded once as an external paper transfer. It raises equity, not trading P&L.</p>
            <label className="mt-3 flex flex-col gap-1">
              <span className="text-xs font-medium text-subtle">Amount (USDT)</span>
              <input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} className="h-10 rounded-lg border border-line bg-inset px-3 text-sm tabular-nums text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/60" />
            </label>
            <Button className="mt-3 w-full" variant="primary" icon={PlusIcon} onClick={submitFunds}>
              Add virtual funds
            </Button>
            <p className="mt-4 text-xs text-subtle">Recorded equity snapshots: {state.equitySnapshots.filter((s) => s.accountId === account.id).length}. History before the demo opening is unavailable.</p>
          </section>
        </div>
      }

      {tab === 'ledger' &&
      <>
          <div className="flex flex-wrap items-end gap-3">
            <div className="w-56">
              <FilterSelect label="Event type" value={typeFilter} onChange={setTypeFilter} options={[{ value: 'all', label: 'All types' }, ...FINANCIAL_TYPES.map((t) => ({ value: t, label: LEDGER_TYPE_LABELS[t] }))]} />
            </div>
            <label className="flex h-9 items-center gap-2 text-sm text-muted">
              <input type="checkbox" checked={showOps} onChange={(e) => setShowOps(e.target.checked)} className="h-4 w-4 accent-[rgb(var(--accent))]" />
              Show margin events (zero wallet movement)
            </label>
            <Button className="ml-auto" icon={DownloadIcon} onClick={exportLedger}>
              Export CSV
            </Button>
          </div>
          <SimpleTable<LedgerRow>
          label="Account ledger"
          rows={rows}
          rowKey={(r) => r.id}
          empty="No ledger events match this filter."
          columns={[
          { key: 'id', header: 'Event', render: (r) => <span className="font-mono text-xs">{r.id}</span> },
          { key: 'eff', header: 'Effective', render: (r) => formatDateTime(r.effectiveAt) },
          { key: 'type', header: 'Type', render: (r) => LEDGER_TYPE_LABELS[r.type] },
          { key: 'pair', header: 'Pair', render: (r) => r.pair ?? '—' },
          { key: 'rel', header: 'Related', render: (r) => r.related?.label ?? '—' },
          { key: 'amt', header: 'Movement', align: 'right', render: (r) => r.operational ? '0.00' : formatSigned(r.amount) },
          { key: 'run', header: 'Running', align: 'right', render: (r) => r.running === null ? '—' : formatUsdt(r.running) },
          { key: 'st', header: 'Status', render: (r) => r.late ? `${r.status} · late` : r.status }]
          } />
        
        </>
      }

      {tab === 'funding' &&
      <>
          <section className="space-y-2">
            <h3 className="text-sm font-semibold text-ink">Rate preview <span className="font-normal text-subtle">— illustrative estimate, fictional rates</span></h3>
            <SimpleTable<Position>
            label="Funding rate preview"
            rows={open}
            rowKey={(p) => p.id}
            empty="No open positions on this account, so there is nothing to estimate."
            columns={[
            { key: 'pair', header: 'Pair', render: (p) => `${p.pair} · ${p.direction === 'long' ? '▲ Long' : '▼ Short'}` },
            { key: 'rate', header: 'Simulated rate', align: 'right', render: (p) => `${(SIM_FUNDING_RATES[p.pair] ?? 0).toFixed(3)}%` },
            { key: 'next', header: 'Assumed settlement', render: () => formatDateTime(nextFundingSlot(simNow())) },
            { key: 'not', header: 'Notional', align: 'right', render: (p) => formatUsdt(p.quantity * p.markPrice) },
            { key: 'est', header: 'Estimate', align: 'right', render: (p) => formatSigned(fundingAmount(p.direction, p.quantity * p.markPrice, SIM_FUNDING_RATES[p.pair] ?? 0)) },
            { key: 'act', header: '', render: (p) => <Button size="sm" onClick={() => setPending(p)}>Apply simulated settlement</Button> }]
            } />
          
            <p className="text-xs text-subtle">Positive rate: longs pay, shorts receive. Negative rate: shorts pay, longs receive. Estimate = notional × |rate|. Estimates never change balances.</p>
          </section>
          <section className="space-y-2">
            <h3 className="text-sm font-semibold text-ink">Settlement history</h3>
            <SimpleTable<FundingSettlement>
            label="Settlement history"
            rows={settlements}
            rowKey={(s) => s.id}
            empty="No funding settlements recorded."
            columns={[
            { key: 'id', header: 'Settlement', render: (s) => <span className="font-mono text-xs">{s.id}</span> },
            { key: 'pair', header: 'Pair', render: (s) => s.pair },
            { key: 'eff', header: 'Effective', render: (s) => formatDateTime(s.effectiveAt) },
            { key: 'rec', header: 'Recorded', render: (s) => formatDateTime(s.recordedAt) },
            { key: 'rate', header: 'Rate', align: 'right', render: (s) => `${s.ratePct.toFixed(3)}%` },
            { key: 'not', header: 'Notional', align: 'right', render: (s) => formatUsdt(s.notional) },
            { key: 'amt', header: 'Paid / received', align: 'right', render: (s) => formatSigned(s.amount) },
            { key: 'attr', header: 'Attribution', render: (s) => s.attributed ? `Trade ${s.positionId}` : 'Unallocated funding' }]
            } />
          
          </section>
        </>
      }

      {tab === 'sync' &&
      <>
          <div className="flex justify-end">
            <Button icon={RefreshCwIcon} onClick={() => runFinanceSync(account.id)}>
              Run simulated synchronization
            </Button>
          </div>
          <SimpleTable<(typeof SYNC_STREAMS)[number]>
          label="Synchronization streams"
          rows={SYNC_STREAMS}
          rowKey={(s) => s.id}
          empty=""
          columns={[
          { key: 'l', header: 'Stream', render: (s) => s.label },
          { key: 's', header: 'Status', render: (s) => {const st = streams[s.id].status;return <StatusPill tone={st === 'ok' ? 'gain' : st === 'failed' ? 'loss' : st === 'partial' ? 'warn' : 'neutral'}>{st === 'ok' ? 'OK' : st === 'failed' ? 'Failed' : st === 'partial' ? 'Partial' : 'Never run'}</StatusPill>;} },
          { key: 'a', header: 'Last attempt', render: (s) => formatSyncTime(streams[s.id].lastAttemptAt) },
          { key: 'ok', header: 'Last success', render: (s) => formatSyncTime(streams[s.id].lastSuccessAt) },
          { key: 'm', header: 'Missing period', render: (s) => streams[s.id].missingPeriod ?? '—', className: 'whitespace-normal min-w-[180px]' },
          { key: 'f', header: 'Result', render: (s) => streams[s.id].finding, className: 'whitespace-normal min-w-[200px]' }]
          } />
        
          {discrepancies.map((d) =>
        <section key={d.id} className="rounded-xl border border-warn/40 bg-warn/5 p-4 text-sm">
              <p className="font-semibold text-warn">Reconciliation difference — reports marked provisional</p>
              <p className="mt-1 text-muted">
                {d.label}: local {formatUsdt(d.local)} · simulated source {formatUsdt(d.source)} · difference {formatSigned(d.source - d.local)} USDT
              </p>
              <Button size="sm" variant="warn" className="mt-3" onClick={() => dispatchFinance({ type: 'recordCorrection', discrepancyId: d.id, reason: 'Matched simulated source after review', at: simNow() })}>
                Record explicit correction
              </Button>
            </section>
        )}
          <p className="text-xs text-subtle">A failed attempt never overwrites the last successful time or changes balances.</p>
        </>
      }

      <ConfirmDialog
        open={pending !== null}
        title="Apply simulated settlement?"
        description={
        pending ?
        `${account.name} · ${pending.pair} ${pending.direction} · rate ${(SIM_FUNDING_RATES[pending.pair] ?? 0).toFixed(3)}% · notional ${formatUsdt(pending.quantity * pending.markPrice)} USDT → wallet ${formatSigned(fundingAmount(pending.direction, pending.quantity * pending.markPrice, SIM_FUNDING_RATES[pending.pair] ?? 0))} USDT. Quantity and price are captured now.` :
        ''
        }
        confirmLabel="Apply settlement"
        onConfirm={() => pending && applySettlement(pending)}
        onCancel={() => setPending(null)} />
      
    </PageContainer>);

}