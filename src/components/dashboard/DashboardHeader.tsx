import React, { useState } from 'react';
import { RefreshCwIcon } from 'lucide-react';
import { motion } from 'framer-motion';
import { REPORTING_DATE, REPORTING_TIMEZONE, strategies } from '../../data/mockData';
import { useDemo } from '../../contexts/DemoContext';
import { formatClock } from '../../utils/clock';
import { reportingDateOptions } from '../../utils/equitySeries';
import { FilterSelect } from '../ui/FilterSelect';

export function DashboardHeader() {
  const { state, accounts, setAccount, setStrategyFilter, setReportingDate, refresh } = useDemo();
  const [refreshing, setRefreshing] = useState(false);

  const handleRefresh = () => {
    setRefreshing(true);
    window.setTimeout(() => {
      refresh();
      setRefreshing(false);
    }, 350);
  };

  return (
    <div className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
      <div>
        <h2 className="text-xl font-bold tracking-tight text-ink">Daily Overview</h2>
        <p className="mt-1 text-sm text-muted">
          Reporting timezone: <span className="font-medium text-ink">{REPORTING_TIMEZONE}</span>
          <span className="mx-2 text-line-strong" aria-hidden>
            |
          </span>
          Last refreshed{' '}
          <span className="font-medium tabular-nums text-ink" aria-live="polite">
            {formatClock(state.lastRefreshAt)}
          </span>
        </p>
      </div>
      <div className="grid grid-cols-2 items-end gap-3 sm:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_minmax(0,1.2fr)_auto]">
        <div className="col-span-2 sm:col-span-1">
          <FilterSelect
            label="Reporting date"
            value={state.reportingDate}
            onChange={setReportingDate}
            options={reportingDateOptions(REPORTING_DATE)} />
          
        </div>
        <FilterSelect
          label="Account"
          value={state.accountId}
          onChange={setAccount}
          options={accounts.map((a) => ({ value: a.id, label: a.disconnected ? `${a.name} (disconnected)` : a.name }))} />
        
        <FilterSelect
          label="Strategy"
          value={state.strategyFilter}
          onChange={setStrategyFilter}
          options={[{ value: 'all', label: 'All strategies' }, ...strategies.map((s) => ({ value: s.id, label: s.name }))]} />
        
        <button
          type="button"
          onClick={handleRefresh}
          disabled={refreshing}
          className="col-span-2 flex h-9 items-center justify-center gap-2 rounded-lg bg-accent px-4 text-sm font-semibold text-accent-ink transition-colors duration-150 hover:bg-accent/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 disabled:opacity-80 sm:col-span-1">
          
          <motion.span
            animate={refreshing ? { rotate: 360 } : { rotate: 0 }}
            transition={refreshing ? { duration: 0.6, ease: 'linear', repeat: Infinity } : { duration: 0 }}
            className="flex">
            
            <RefreshCwIcon className="h-4 w-4" aria-hidden />
          </motion.span>
          {refreshing ? 'Refreshing' : 'Refresh'}
        </button>
      </div>
    </div>);

}