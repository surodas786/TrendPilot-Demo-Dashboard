import React from 'react';
import { ChevronRightIcon } from 'lucide-react';
import { exchanges } from '../../data/mockData';
import { strategyName } from '../../utils/strategies';
import { useDemo } from '../../contexts/DemoContext';
import { positionMargin, round2, unrealizedPnl } from '../../utils/accountMath';
import { protectionInfo } from '../../utils/protection';
import { formatLeverage, formatMaybe, formatNumber } from '../../utils/format';
import { Card } from '../ui/Card';
import { DirectionBadge } from '../ui/DirectionBadge';
import { InfoTooltip } from '../ui/InfoTooltip';
import { PnlText } from '../ui/PnlText';
import { ProtectionPill } from './ProtectionPill';
import type { Position } from '../../types/trading';

interface PositionsTableProps {
  positions: Position[];
  onSelect: (id: string) => void;
}

const ORDER_COST_TIP =
'Order cost is the initial margin allocated to an order, excluding fees and funding. It is not the maximum possible loss.';
const UNREALIZED_TIP = 'Unrealized P&L belongs to open positions and is based on the simulated mark price.';

export function PositionsTable({ positions, onSelect }: PositionsTableProps) {
  const { accountName } = useDemo();
  const totalAllocated = round2(positions.reduce((s, p) => s + p.allocatedCost, 0));
  const totalMargin = round2(positions.reduce((s, p) => s + positionMargin(p), 0));
  const totalPnl = round2(positions.reduce((s, p) => s + unrealizedPnl(p), 0));

  return (
    <Card labelledBy="positions-heading">
      <div className="flex flex-wrap items-baseline justify-between gap-2 px-4 pb-3 pt-4 lg:px-5">
        <h2 id="positions-heading" className="text-sm font-semibold text-ink">
          Open positions <span className="text-muted">({positions.length})</span>
        </h2>
        <p className="text-xs text-subtle">Prices and mark values are simulated sample market values · USDT perpetuals</p>
      </div>

      {positions.length === 0 ?
      <div className="border-t border-line px-5 py-10 text-center">
          <p className="text-sm font-medium text-ink">No open positions</p>
          <p className="mt-1 text-sm text-muted">Nothing is open for this account and strategy filter.</p>
        </div> :

      <>
          <div className="scrollbar-thin hidden overflow-x-auto md:block">
            <table className="w-full min-w-[1180px] text-sm">
              <thead>
                <tr className="border-y border-line text-left text-xs font-medium text-subtle">
                  <th scope="col" className="px-4 py-2.5 font-medium lg:pl-5">Pair</th>
                  <th scope="col" className="px-3 py-2.5 font-medium">Exchange / Account</th>
                  <th scope="col" className="px-3 py-2.5 font-medium">Strategy</th>
                  <th scope="col" className="px-3 py-2.5 text-right font-medium">
                    <span className="inline-flex items-center gap-1">
                      Entry cost
                      <InfoTooltip label="About allocated entry cost" content={ORDER_COST_TIP} />
                    </span>
                  </th>
                  <th scope="col" className="px-3 py-2.5 text-right font-medium">Margin</th>
                  <th scope="col" className="px-3 py-2.5 text-right font-medium">Lev.</th>
                  <th scope="col" className="px-3 py-2.5 text-right font-medium">Avg entry</th>
                  <th scope="col" className="px-3 py-2.5 text-right font-medium">Mark (sim.)</th>
                  <th scope="col" className="px-3 py-2.5 text-right font-medium">
                    <span className="inline-flex items-center gap-1">
                      Unrealized
                      <InfoTooltip label="About unrealized P&L" content={UNREALIZED_TIP} />
                    </span>
                  </th>
                  <th scope="col" className="px-3 py-2.5 text-right font-medium">Stop loss</th>
                  <th scope="col" className="px-3 py-2.5 text-right font-medium">Take profit</th>
                  <th scope="col" className="px-3 py-2.5 font-medium">Protection</th>
                  <th scope="col" className="px-4 py-2.5 lg:pr-5">
                    <span className="sr-only">Details</span>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {positions.map((p) =>
              <tr
                key={p.id}
                onClick={() => onSelect(p.id)}
                className="cursor-pointer transition-colors duration-150 hover:bg-inset">
                
                    <td className="px-4 py-3 lg:pl-5">
                      <div className="flex flex-col items-start gap-1">
                        <span className="font-semibold text-ink">{p.pair}</span>
                        <DirectionBadge direction={p.direction} />
                      </div>
                    </td>
                    <td className="px-3 py-3">
                      <span className="block text-ink">{exchanges.find((e) => e.id === p.exchangeId)?.name}</span>
                      <span className="block text-xs text-subtle">{accountName(p.accountId)}</span>
                    </td>
                    <td className="px-3 py-3 text-muted">{strategyName(p.strategyId)}</td>
                    <td className="px-3 py-3 text-right tabular-nums text-ink">{formatNumber(p.allocatedCost)}</td>
                    <td className="px-3 py-3 text-right tabular-nums text-ink">{formatNumber(positionMargin(p))}</td>
                    <td className="px-3 py-3 text-right tabular-nums text-muted">{formatLeverage(p.leverage)}</td>
                    <td className="px-3 py-3 text-right tabular-nums text-ink">{formatNumber(p.entryPrice, p.priceDecimals)}</td>
                    <td className="px-3 py-3 text-right tabular-nums text-ink">{formatNumber(p.markPrice, p.priceDecimals)}</td>
                    <td className="px-3 py-3 text-right">
                      <PnlText value={unrealizedPnl(p)} />
                    </td>
                    <td className="px-3 py-3 text-right tabular-nums text-muted">{formatMaybe(p.stopLoss, p.priceDecimals)}</td>
                    <td className="px-3 py-3 text-right tabular-nums text-muted">{formatMaybe(p.takeProfit, p.priceDecimals)}</td>
                    <td className="px-3 py-3">
                      <PositionProtection position={p} />
                    </td>
                    <td className="px-4 py-3 text-right lg:pr-5">
                      <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      onSelect(p.id);
                    }}
                    className="inline-flex items-center gap-1 whitespace-nowrap rounded-md border border-line bg-inset px-2.5 py-1 text-xs font-medium text-ink transition-colors duration-150 hover:border-line-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60">
                    
                        View details
                        <ChevronRightIcon className="h-3.5 w-3.5" aria-hidden />
                      </button>
                    </td>
                  </tr>
              )}
              </tbody>
              <tfoot>
                <tr className="border-t border-line-strong text-sm">
                  <th scope="row" colSpan={3} className="px-4 py-2.5 text-left text-xs font-medium text-subtle lg:pl-5">
                    Totals · USDT
                  </th>
                  <td className="px-3 py-2.5 text-right font-semibold tabular-nums text-ink">{formatNumber(totalAllocated)}</td>
                  <td className="px-3 py-2.5 text-right font-semibold tabular-nums text-ink">{formatNumber(totalMargin)}</td>
                  <td colSpan={3} />
                  <td className="px-3 py-2.5 text-right">
                    <PnlText value={totalPnl} />
                  </td>
                  <td colSpan={4} />
                </tr>
              </tfoot>
            </table>
          </div>

          <ul className="space-y-3 border-t border-line p-4 md:hidden">
            {positions.map((p) =>
          <li key={p.id}>
                <button
              type="button"
              onClick={() => onSelect(p.id)}
              className="w-full rounded-lg border border-line bg-inset p-3.5 text-left transition-colors duration-150 hover:border-line-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60">
              
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="font-semibold text-ink">{p.pair}</span>
                        <DirectionBadge direction={p.direction} />
                      </div>
                      <p className="mt-1 text-xs text-subtle">
                        {strategyName(p.strategyId)} · {formatLeverage(p.leverage)}
                      </p>
                    </div>
                    <div className="text-right">
                      <PnlText value={unrealizedPnl(p)} className="text-base" />
                      <p className="text-[11px] text-subtle">Unrealized USDT</p>
                    </div>
                  </div>
                  <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
                    <MobileField label="Entry cost" value={formatNumber(p.allocatedCost)} />
                    <MobileField label="Margin" value={formatNumber(positionMargin(p))} />
                    <MobileField label="Avg entry" value={formatNumber(p.entryPrice, p.priceDecimals)} />
                    <MobileField label="Mark (sim.)" value={formatNumber(p.markPrice, p.priceDecimals)} />
                    <MobileField label="Stop loss" value={formatMaybe(p.stopLoss, p.priceDecimals)} />
                    <MobileField label="Take profit" value={formatMaybe(p.takeProfit, p.priceDecimals)} />
                  </dl>
                  <div className="mt-3 flex items-center justify-between">
                    <PositionProtection position={p} />
                    <span className="flex items-center gap-1 text-xs font-medium text-accent">
                      View details
                      <ChevronRightIcon className="h-3.5 w-3.5" aria-hidden />
                    </span>
                  </div>
                </button>
              </li>
          )}
            <li className="flex items-center justify-between rounded-lg px-1 text-xs text-subtle">
              <span>
                Total margin <span className="font-semibold tabular-nums text-ink">{formatNumber(totalMargin)}</span> USDT
              </span>
              <span>
                Unrealized <PnlText value={totalPnl} className="text-xs" />
              </span>
            </li>
          </ul>
        </>
      }
    </Card>);

}

/** Protection derived from simulated protective-order records and connection health. */
function PositionProtection({ position }: {position: Position;}) {
  const { accountById, state } = useDemo();
  const view = protectionInfo(position, accountById(position.accountId), state.orders);
  return <ProtectionPill status={view.status} title={view.note} />;
}

function MobileField({ label, value }: {label: string;value: string;}) {
  return (
    <div className="flex justify-between gap-2">
      <dt className="text-subtle">{label}</dt>
      <dd className="tabular-nums text-ink">{value}</dd>
    </div>);

}