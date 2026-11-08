import React from 'react';
import { LayersIcon } from 'lucide-react';
import { formatClock } from '../../utils/clock';
import { formatUserDate } from '../../utils/userDirectory';
import { formatQty } from '../../utils/holdingsMath';
import { unrealizedOf } from '../../utils/holdingsView';
import { formatPrice } from '../../utils/platformText';
import { MODE_LABEL } from '../../utils/tokenBlocks';
import { Button } from '../ui/Button';
import { EmptyState } from '../ui/EmptyState';
import { SideText, SignedPnl } from './SignedPnl';
import type { HoldingView } from '../../types/holdings';

interface Props {
  positions: HoldingView[];
  labelOf: (symbol: string) => string;
  onOpen: (id: string) => void;
  onClose: (id: string) => void;
}

const SOURCE: Record<HoldingView['kind'], string> = { token: 'Token block', legacy: 'Original sample', migrated: 'Migrated' };

export function OpenPositionsTable({ positions, labelOf, onOpen, onClose }: Props) {
  if (positions.length === 0) {
    return <EmptyState icon={LayersIcon} title="No open positions" body="Positions open here when an accepted common signal matches one of your active token blocks." />;
  }
  return (
    <div className="scrollbar-thin overflow-x-auto rounded-xl border border-line bg-surface">
      <table className="w-full min-w-[980px] text-sm">
        <thead className="text-left text-xs text-subtle">
          <tr className="border-b border-line">
            <th scope="col" className="px-4 py-2.5 font-medium">Pair</th>
            <th scope="col" className="px-3 py-2.5 font-medium">Side</th>
            <th scope="col" className="px-3 py-2.5 font-medium">Account · mode</th>
            <th scope="col" className="px-3 py-2.5 text-right font-medium">Entry</th>
            <th scope="col" className="px-3 py-2.5 text-right font-medium">Current</th>
            <th scope="col" className="px-3 py-2.5 text-right font-medium">Remaining qty</th>
            <th scope="col" className="px-3 py-2.5 text-right font-medium">Unrealized P&amp;L</th>
            <th scope="col" className="px-3 py-2.5 font-medium">Opened (Asia/Dhaka)</th>
            <th scope="col" className="px-3 py-2.5"><span className="sr-only">Actions</span></th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line tabular-nums">
          {positions.map((p) =>
          <tr key={p.id} className="cursor-pointer transition-colors duration-150 hover:bg-inset/60" onClick={() => onOpen(p.id)}>
              <td className="px-4 py-2.5">
                <button type="button" onClick={(e) => {e.stopPropagation();onOpen(p.id);}} className="rounded font-medium text-ink hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60">
                  {labelOf(p.symbol)}
                </button>
                <span className="block text-[11px] text-subtle">{SOURCE[p.kind]}</span>
              </td>
              <td className="px-3 py-2.5"><SideText side={p.side} /></td>
              <td className="whitespace-nowrap px-3 py-2.5 text-muted">
                <span className="text-ink">{p.accountLabel}</span>
                <span className="block text-[11px]">{MODE_LABEL[p.mode]}</span>
              </td>
              <td className="px-3 py-2.5 text-right text-ink">{formatPrice(p.entryPrice)}</td>
              <td className="px-3 py-2.5 text-right text-ink">{p.currentPrice ? formatPrice(p.currentPrice) : '—'}</td>
              <td className="px-3 py-2.5 text-right text-ink">{formatQty(p.remainingQty)}</td>
              <td className="px-3 py-2.5 text-right"><SignedPnl value={unrealizedOf(p)} /></td>
              <td className="whitespace-nowrap px-3 py-2.5 text-muted">{formatUserDate(p.openedAt)} · {formatClock(p.openedAt)}</td>
              <td className="px-3 py-2.5 text-right">
                <Button size="sm" variant="danger" onClick={(e) => {e.stopPropagation();onClose(p.id);}}>
                  Close
                </Button>
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>);

}