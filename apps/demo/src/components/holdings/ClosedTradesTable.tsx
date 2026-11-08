import React, { useState } from 'react';
import { ChevronDownIcon, HistoryIcon } from 'lucide-react';
import { formatClock } from '../../utils/clock';
import { cn } from '../../utils/cn';
import { formatUserDate } from '../../utils/userDirectory';
import { averageExit, formatQty } from '../../utils/holdingsMath';
import { formatPrice } from '../../utils/platformText';
import { MODE_LABEL } from '../../utils/tokenBlocks';
import { EmptyState } from '../ui/EmptyState';
import { SideText, SignedPnl } from './SignedPnl';
import type { HoldingView } from '../../types/holdings';

const when = (ms?: number) => ms ? `${formatUserDate(ms)} · ${formatClock(ms)}` : '—';

/** Same completed-trade records as Trade History, plus migrated holdings that were never linked to an account. */
export function ClosedTradesTable({ positions, labelOf }: {positions: HoldingView[];labelOf: (symbol: string) => string;}) {
  const [open, setOpen] = useState<string | null>(null);
  if (positions.length === 0) return <EmptyState icon={HistoryIcon} title="No closed trades yet" body="Fully closed positions appear here with their exits." />;
  return (
    <div className="scrollbar-thin overflow-x-auto rounded-xl border border-line bg-surface">
      <table className="w-full min-w-[1080px] text-sm">
        <thead className="text-left text-xs text-subtle">
          <tr className="border-b border-line">
            <th scope="col" className="w-8 px-2 py-2.5"><span className="sr-only">Details</span></th>
            <th scope="col" className="px-3 py-2.5 font-medium">Pair</th>
            <th scope="col" className="px-3 py-2.5 font-medium">Account · mode</th>
            <th scope="col" className="px-3 py-2.5 text-right font-medium">Qty</th>
            <th scope="col" className="px-3 py-2.5 text-right font-medium">Entry</th>
            <th scope="col" className="px-3 py-2.5 text-right font-medium">Avg exit</th>
            <th scope="col" className="px-3 py-2.5 text-right font-medium">Gross P&amp;L</th>
            <th scope="col" className="px-3 py-2.5 text-right font-medium">Fees</th>
            <th scope="col" className="px-3 py-2.5 text-right font-medium">Net</th>
            <th scope="col" className="px-3 py-2.5 font-medium">Closed (Asia/Dhaka)</th>
            <th scope="col" className="px-3 py-2.5 font-medium">Reason</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line tabular-nums">
          {positions.map((p) => {
            const expanded = open === p.id;
            const avg = averageExit(p);
            return (
              <React.Fragment key={p.id}>
                <tr>
                  <td className="px-2 py-2">
                    <button type="button" onClick={() => setOpen(expanded ? null : p.id)} aria-expanded={expanded} aria-label={`${expanded ? 'Hide' : 'Show'} exits for ${labelOf(p.symbol)}`} className="flex h-8 w-8 items-center justify-center rounded-md text-subtle hover:bg-inset hover:text-ink">
                      <ChevronDownIcon className={cn('h-4 w-4 transition-transform duration-150', expanded && 'rotate-180')} aria-hidden />
                    </button>
                  </td>
                  <td className="whitespace-nowrap px-3 py-2">
                    <span className="font-medium text-ink">{labelOf(p.symbol)}</span> <SideText side={p.side} />
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-muted">
                    <span className="text-ink">{p.accountLabel}</span>
                    <span className="block text-[11px]">{MODE_LABEL[p.mode]}</span>
                  </td>
                  <td className="px-3 py-2 text-right text-ink">{formatQty(p.originalQty)}</td>
                  <td className="px-3 py-2 text-right text-ink">{formatPrice(p.entryPrice)}</td>
                  <td className="px-3 py-2 text-right text-ink">{avg ? formatPrice(avg) : '—'}</td>
                  <td className="px-3 py-2 text-right"><SignedPnl value={p.realizedPnl} /></td>
                  <td className="px-3 py-2 text-right text-muted">{p.kind === 'migrated' ? 'Not recorded' : p.fees.toFixed(2)}</td>
                  <td className="px-3 py-2 text-right">{p.kind === 'migrated' ? <span className="text-muted">Gross only</span> : <SignedPnl value={p.realizedPnl - p.fees} />}</td>
                  <td className="whitespace-nowrap px-3 py-2 text-muted">{when(p.closedAt)}</td>
                  <td className="whitespace-nowrap px-3 py-2 text-ink">{p.closeReason}</td>
                </tr>
                {expanded &&
                <tr className="bg-inset/50">
                    <td />
                    <td colSpan={10} className="px-3 pb-3 pt-1">
                      <p className="text-xs text-muted">Opened {when(p.openedAt)}</p>
                      <ul className="mt-1 space-y-1 text-xs">
                        {p.exits.map((e) =>
                      <li key={e.id} className="flex flex-wrap gap-x-4">
                            <span className="text-muted">{formatClock(e.at)}</span>
                            <span className="text-ink">{e.reason}</span>
                            <span className="text-muted">{formatQty(e.qty)} @ {formatPrice(e.price)}</span>
                            <SignedPnl value={e.pnl} />
                          </li>
                      )}
                      </ul>
                      <p className="mt-2 font-mono text-[11px] text-subtle">{p.id} · signal {p.signalId}</p>
                    </td>
                  </tr>
                }
              </React.Fragment>);

          })}
        </tbody>
      </table>
    </div>);

}