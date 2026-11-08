import React, { useMemo } from 'react';
import { REPORTING_DATE, strategies } from '../data/mockData';
import { useDemo } from '../contexts/DemoContext';
import { summarizeLedger } from '../utils/accountMath';
import { dhakaDate } from '../utils/clock';
import { effectiveAt } from '../utils/ledger';
import { ActivityStrip } from '../components/dashboard/ActivityStrip';
import { AutomationStatus } from '../components/dashboard/AutomationStatus';
import { DashboardHeader } from '../components/dashboard/DashboardHeader';
import { EquityHero } from '../components/dashboard/EquityHero';
import { HealthPanel } from '../components/dashboard/HealthPanel';
import { NoRecordsNotice } from '../components/dashboard/NoRecordsNotice';
import { PositionsTable } from '../components/dashboard/PositionsTable';
import { SignalsTable } from '../components/dashboard/SignalsTable';

export function Dashboard() {
  const { state, account, accountPositions, accountTrades, setReportingDate, selectPosition } = useDemo();
  const filter = state.strategyFilter;

  const data = useMemo(() => {
    const matches = (strategyId: string) => filter === 'all' || strategyId === filter;
    const positions = accountPositions.filter((p) => matches(p.strategyId));
    // Realized results are reported on their effective date (late events land in their own period).
    const trades = accountTrades.filter((t) => matches(t.strategyId) && dhakaDate(effectiveAt(t)) === REPORTING_DATE);
    return {
      positions,
      ledger: summarizeLedger(positions, trades),
      activity: state.activity.
      filter((e) => e.accountId === account.id && matches(e.strategyId)).
      sort((a, b) => b.time.localeCompare(a.time)).
      slice(0, 6),
      signals: state.signals.
      filter((s) => s.accountId === account.id && matches(s.strategyId)).
      sort((a, b) => b.receivedAt.localeCompare(a.receivedAt)).
      slice(0, 6)
    };
  }, [filter, accountPositions, accountTrades, state.activity, state.signals, account.id]);

  const strategyName = filter === 'all' ? null : strategies.find((s) => s.id === filter)?.name ?? null;
  const isToday = state.reportingDate === REPORTING_DATE;

  return (
    <div className="mx-auto w-full max-w-[1480px] space-y-4 px-4 py-5 lg:space-y-5 lg:px-6 lg:py-6">
      <DashboardHeader />
      <AutomationStatus />

      {isToday ?
      <>
          <EquityHero ledger={data.ledger} strategyName={strategyName} />
          <ActivityStrip events={data.activity} />
          <PositionsTable positions={data.positions} onSelect={selectPosition} />
          <div className="grid gap-4 lg:grid-cols-[minmax(300px,360px)_minmax(0,1fr)] lg:gap-5">
            <HealthPanel />
            <SignalsTable signals={data.signals} />
          </div>
        </> :

      <NoRecordsNotice date={state.reportingDate} onBackToToday={() => setReportingDate(REPORTING_DATE)} />
      }

      <p className="pb-2 text-center text-xs text-subtle">
        Demo only — no real exchange orders. Paper and Live — simulated accounts both use simulated prices and fills; no webhooks or real exchange connections.
      </p>
    </div>);

}