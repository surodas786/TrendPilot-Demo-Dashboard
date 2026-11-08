import React, { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { WalletIcon } from 'lucide-react';
import { equitySeries, REPORTING_DATE } from '../../data/mockData';
import { useDemo } from '../../contexts/DemoContext';
import { formatClockShort } from '../../utils/clock';
import { buildEquityPoints, fallbackSeries, periodRangeLabel } from '../../utils/equitySeries';
import { formatNumber, formatPercent, formatSigned } from '../../utils/format';
import { cn } from '../../utils/cn';
import { Card } from '../ui/Card';
import { InfoTooltip } from '../ui/InfoTooltip';
import { EquityChart } from './EquityChart';
import { PnlLedger } from './PnlLedger';
import type { EquityPeriod, LedgerTotals } from '../../types/trading';

const periods: {value: EquityPeriod;label: string;}[] = [
{ value: 'today', label: 'Today' },
{ value: '7d', label: '7D' },
{ value: '30d', label: '30D' }];


interface EquityHeroProps {
  ledger: LedgerTotals;
  strategyName: string | null;
}

export function EquityHero({ ledger, strategyName }: EquityHeroProps) {
  const { account, summary, state } = useDemo();
  const [period, setPeriod] = useState<EquityPeriod>('today');
  const nowShort = formatClockShort(state.lastRefreshAt);
  const series = equitySeries[account.id]?.[period] ?? fallbackSeries(period, summary.currentEquity);
  const noFunds = summary.currentEquity === 0 && summary.openPositions === 0;

  const points = useMemo(
    () => buildEquityPoints(series, period, summary.currentEquity, REPORTING_DATE, nowShort),
    [series, period, summary.currentEquity, nowShort]
  );
  const periodChange = points[points.length - 1].equity - points[0].equity;
  const positive = summary.dayChange >= 0;

  return (
    <Card className="grid overflow-hidden lg:grid-cols-[minmax(320px,360px)_minmax(0,1fr)]" labelledBy="equity-heading">
      <div className="border-b border-line p-5 lg:border-b-0 lg:border-r lg:p-6">
        <p id="equity-heading" className="flex items-center gap-1.5 text-sm font-medium text-muted">
          Current equity
          <InfoTooltip
            label="How current equity is calculated"
            content="Current equity = opening equity + paper transfers + net realized P&L + unrealized P&L. Paper transfers (virtual funds) are not trading P&L; no real deposits or withdrawals exist in this demo." />
          
        </p>
        <p className="mt-2 flex items-baseline gap-2">
          <span className="text-4xl font-extrabold tracking-tight tabular-nums text-ink sm:text-[44px]">
            {formatNumber(summary.currentEquity)}
          </span>
          <span className="text-sm font-semibold text-subtle">USDT</span>
        </p>
        <p className="mt-2 text-sm text-muted">
          Opening equity <span className="tabular-nums text-ink">{formatNumber(summary.openingEquity)}</span> USDT
          {summary.transfersIn > 0 &&
          <>
              {' '}
              · Paper transfers <span className="tabular-nums text-ink">+{formatNumber(summary.transfersIn)}</span>
            </>
          }{' '}
          ·{' '}
          <span className={cn('font-semibold tabular-nums', positive ? 'text-gain' : 'text-loss')}>
            {formatSigned(summary.dayChange)} ({formatPercent(summary.dayChangePct)})
          </span>{' '}
          today
        </p>
        {noFunds &&
        <div className="mt-4 flex items-start gap-2.5 rounded-lg border border-dashed border-line-strong px-3 py-3">
            <WalletIcon className="mt-0.5 h-4 w-4 shrink-0 text-subtle" aria-hidden />
            <p className="text-sm text-muted">
              This paper account has no funds.{' '}
              <Link to={`/exchange-connections?details=${account.id}&tab=overview`} className="font-medium text-accent hover:underline">
                Add virtual funds in Exchange Connections
              </Link>
              .
            </p>
          </div>
        }

        <div className="mt-5 border-t border-line pt-4">
          <div className="mb-1 flex items-center justify-between">
            <p className="text-xs font-medium text-subtle">Daily P&L breakdown · USDT</p>
          </div>
          {strategyName &&
          <p className="mb-2 rounded-md border border-line bg-inset px-2.5 py-1.5 text-xs text-muted">
              Filtered to <span className="font-semibold text-ink">{strategyName}</span>. Equity and margin stay account-wide.
            </p>
          }
          <PnlLedger ledger={ledger} />
        </div>
      </div>

      <div className="flex min-w-0 flex-col p-5 lg:p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-ink">Simulated equity</h2>
            <p className="mt-0.5 text-xs text-subtle">
              {periodRangeLabel(period, series.length, REPORTING_DATE, nowShort)} · {account.name}
            </p>
          </div>
          <div className="flex items-center gap-3">
            <span className={cn('text-sm font-semibold tabular-nums', periodChange >= 0 ? 'text-gain' : 'text-loss')}>
              {formatSigned(periodChange)} USDT
            </span>
            <div role="tablist" aria-label="Chart period" className="flex rounded-lg border border-line bg-inset p-0.5">
              {periods.map((p) =>
              <button
                key={p.value}
                type="button"
                role="tab"
                aria-selected={period === p.value}
                onClick={() => setPeriod(p.value)}
                className={cn(
                  'rounded-md px-3 py-1 text-xs font-semibold transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60',
                  period === p.value ? 'bg-accent/15 text-accent' : 'text-muted hover:text-ink'
                )}>
                
                  {p.label}
                </button>
              )}
            </div>
          </div>
        </div>

        <div className="mt-4 h-56 min-h-0 flex-1 sm:h-64 lg:h-auto lg:min-h-[240px]">
          <EquityChart points={points} referenceValue={period === 'today' ? summary.openingEquity : undefined} />
        </div>

        <dl className="mt-4 grid grid-cols-3 gap-4 border-t border-line pt-4">
          <HeroStat label="Used margin" value={formatNumber(summary.usedMargin)} unit="USDT" />
          <HeroStat label="Available margin" value={formatNumber(summary.availableMargin)} unit="USDT" />
          <HeroStat label="Open positions" value={String(summary.openPositions)} />
        </dl>
      </div>
    </Card>);

}

function HeroStat({ label, value, unit }: {label: string;value: string;unit?: string;}) {
  return (
    <div className="min-w-0">
      <dt className="truncate text-xs text-subtle">{label}</dt>
      <dd className="mt-1 text-base font-semibold tabular-nums text-ink sm:text-lg">
        {value}
        {unit && <span className="ml-1 text-xs font-medium text-subtle">{unit}</span>}
      </dd>
    </div>);

}