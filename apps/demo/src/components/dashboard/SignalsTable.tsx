import React from 'react';
import { CheckCircle2Icon, CircleSlashIcon, XCircleIcon } from 'lucide-react';
import { strategies } from '../../data/mockData';
import { timeToSeconds } from '../../utils/clock';
import { cn } from '../../utils/cn';
import { Card } from '../ui/Card';
import { InfoTooltip } from '../ui/InfoTooltip';
import { StatusPill } from '../ui/StatusPill';
import type { SignalRecord, SignalResult } from '../../types/trading';

const FRESHNESS_LIMIT_S = 30;

export function SignalsTable({ signals }: {signals: SignalRecord[];}) {
  return (
    <Card className="min-w-0" labelledBy="signals-heading">
      <div className="flex flex-wrap items-baseline justify-between gap-2 px-4 pb-3 pt-4 lg:px-5">
        <h2 id="signals-heading" className="text-sm font-semibold text-ink">
          Recent signals
        </h2>
        <p className="text-xs text-subtle">Central TradingView signals · times in Asia/Dhaka</p>
      </div>
      {signals.length === 0 ?
      <p className="border-t border-line px-5 py-8 text-center text-sm text-muted">No signals for this filter today.</p> :

      <div className="scrollbar-thin overflow-x-auto">
          <table className="w-full min-w-[860px] text-sm">
            <thead>
              <tr className="border-y border-line text-left text-xs text-subtle">
                <th scope="col" className="px-4 py-2.5 font-medium lg:pl-5">Strategy</th>
                <th scope="col" className="px-3 py-2.5 font-medium">Pair</th>
                <th scope="col" className="px-3 py-2.5 font-medium">Action</th>
                <th scope="col" className="px-3 py-2.5 font-medium">TF</th>
                <th scope="col" className="px-3 py-2.5 font-medium">
                  <span className="inline-flex items-center gap-1">
                    Candle close
                    <InfoTooltip label="About candle close time" content="When the TradingView candle that produced the signal closed (bar close time)." />
                  </span>
                </th>
                <th scope="col" className="px-3 py-2.5 font-medium">
                  <span className="inline-flex items-center gap-1">
                    Received
                    <InfoTooltip label="About received time" content="When the central signal service received the alert. The delay after candle close is shown underneath." />
                  </span>
                </th>
                <th scope="col" className="px-3 py-2.5 font-medium">Result</th>
                <th scope="col" className="px-4 py-2.5 font-medium lg:pr-5">Execution or skip reason</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {signals.map((s) => {
              const delay = timeToSeconds(s.receivedAt) - timeToSeconds(s.candleCloseAt);
              const late = delay > FRESHNESS_LIMIT_S;
              return (
                <tr key={s.id}>
                    <td className="px-4 py-3 text-ink lg:pl-5">{strategies.find((st) => st.id === s.strategyId)?.name}</td>
                    <td className="px-3 py-3 font-medium text-ink">{s.pair}</td>
                    <td className="px-3 py-3 text-muted">{s.action}</td>
                    <td className="px-3 py-3 text-muted">{s.timeframe}</td>
                    <td className="px-3 py-3 tabular-nums text-muted">{s.candleCloseAt}</td>
                    <td className="px-3 py-3">
                      <span className="block tabular-nums text-ink">{s.receivedAt}</span>
                      <span className={cn('block text-xs tabular-nums', late ? 'text-warn' : 'text-subtle')}>
                        +{delay} s after close
                      </span>
                    </td>
                    <td className="px-3 py-3">
                      <ResultPill result={s.result} />
                    </td>
                    <td className="max-w-[280px] px-4 py-3 text-muted lg:pr-5">{s.reason}</td>
                  </tr>);

            })}
            </tbody>
          </table>
        </div>
      }
    </Card>);

}

function ResultPill({ result }: {result: SignalResult;}) {
  if (result === 'executed') {
    return (
      <StatusPill tone="gain" icon={CheckCircle2Icon}>
        Executed
      </StatusPill>);

  }
  if (result === 'skipped') {
    return (
      <StatusPill tone="warn" icon={CircleSlashIcon}>
        Skipped
      </StatusPill>);

  }
  return (
    <StatusPill tone="loss" icon={XCircleIcon}>
      Rejected
    </StatusPill>);

}