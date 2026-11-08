import React, { useState } from 'react';
import { CandlestickChartIcon, PencilIcon, PlusIcon, SearchIcon } from 'lucide-react';
import { toast } from 'sonner';
import { usePlatform } from '../../contexts/PlatformContext';
import { pairLabel } from '../../data/platformSeed';
import { formatClock } from '../../utils/clock';
import { formatPrice } from '../../utils/platformText';
import { PageContainer } from '../../components/layout/PageContainer';
import { Button } from '../../components/ui/Button';
import { EmptyState } from '../../components/ui/EmptyState';
import { StatusPill } from '../../components/ui/StatusPill';
import { AddPairModal } from '../../components/platform/AddPairModal';
import { EditPairModal } from '../../components/platform/EditPairModal';
import { PERCENT_NOTE } from '../../components/platform/PairDefaultsFields';
import { DemoPriceControls } from '../../components/holdings/DemoPriceControls';
import { useDemo } from '../../contexts/DemoContext';

const pct = (v: number) => `${v}%`;

export function TradingPairs() {
  const { platform } = usePlatform();
  const { state } = useDemo();
  const openSymbols = [...new Set(state.positions.map((p) => p.pair))];
  const [query, setQuery] = useState('');
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);

  const q = query.toUpperCase().replace(/[^A-Z0-9]/g, '');
  const rows = platform.pairs.filter((p) => !q || p.symbol.includes(q));
  const editPair = platform.pairs.find((p) => p.symbol === editing);

  return (
    <PageContainer
      title="Trading Pairs & Defaults"
      description="Supported MEXC Futures pairs and suggested stop-loss, take-profit and trailing-stop percentages. Subscribers can override these defaults."
      scope={`${PERCENT_NOTE} All values shown are illustrative.`}
      actions={
      <Button variant="primary" icon={PlusIcon} onClick={() => setAdding(true)}>
          Add Pair
        </Button>
      }>
      
      <div className="flex max-w-sm flex-col gap-1">
        <label htmlFor="pair-filter" className="text-xs font-medium text-subtle">
          Search pairs
        </label>
        <div className="relative">
          <SearchIcon className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-subtle" aria-hidden />
          <input id="pair-filter" type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="e.g. BTC" className="h-9 w-full rounded-lg border border-line bg-inset pl-9 pr-3 text-sm text-ink placeholder:text-subtle hover:border-line-strong focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/60" />
        </div>
      </div>

      {rows.length === 0 ?
      <EmptyState icon={CandlestickChartIcon} title={platform.pairs.length === 0 ? 'No trading pairs yet' : 'No matching pairs'} body={platform.pairs.length === 0 ? 'Add a pair from the simulated MEXC catalogue.' : 'Try a different pair name.'} /> :

      <div className="scrollbar-thin overflow-x-auto rounded-xl border border-line bg-surface">
          <table className="w-full min-w-[760px] text-sm">
            <thead className="text-left text-xs text-subtle">
              <tr className="border-b border-line">
                <th scope="col" className="px-4 py-2.5 font-medium">Pair</th>
                <th scope="col" className="px-3 py-2.5 text-right font-medium">Stop loss</th>
                <th scope="col" className="px-3 py-2.5 text-right font-medium">Take profit</th>
                <th scope="col" className="px-3 py-2.5 text-right font-medium">Trailing stop</th>
                <th scope="col" className="px-3 py-2.5 font-medium">Status</th>
                <th scope="col" className="px-3 py-2.5 font-medium">Price feed</th>
                <th scope="col" className="px-3 py-2.5 text-right font-medium"><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line tabular-nums">
              {rows.map((p) => {
              const subscribed = platform.feed.includes(p.symbol);
              const tick = platform.prices[p.symbol];
              return (
                <tr key={p.symbol}>
                    <td className="px-4 py-2.5">
                      <span className="font-medium text-ink">{pairLabel(p)}</span>
                      <span className="block font-mono text-[11px] text-subtle">{p.symbol}</span>
                    </td>
                    <td className="px-3 py-2.5 text-right text-ink">{pct(p.stopLossPct)}</td>
                    <td className="px-3 py-2.5 text-right text-ink">{pct(p.takeProfitPct)}</td>
                    <td className="px-3 py-2.5 text-right text-ink">{p.trailingEnabled ? pct(p.trailingPct) : <span className="text-subtle">Off</span>}</td>
                    <td className="px-3 py-2.5">
                      <StatusPill tone={p.enabled ? 'gain' : 'neutral'}>{p.enabled ? 'Enabled' : 'Disabled'}</StatusPill>
                    </td>
                    <td className="px-3 py-2.5">
                      <StatusPill tone={subscribed ? p.enabled ? 'accent' : 'warn' : 'neutral'}>{subscribed ? p.enabled ? 'Simulated feed active' : 'Monitoring open positions' : 'Not subscribed'}</StatusPill>
                      <span className="mt-1 block text-xs text-subtle">
                        {tick ? `${formatPrice(tick.price)} · ${formatClock(tick.updatedAt)}${subscribed ? '' : ' (last)'}` : 'No price yet'}
                      </span>
                    </td>
                    <td className="px-3 py-2.5 text-right">
                      <Button size="sm" variant="ghost" icon={PencilIcon} onClick={() => setEditing(p.symbol)} aria-label={`Edit ${pairLabel(p)}`}>
                        Edit
                      </Button>
                    </td>
                  </tr>);

            })}
            </tbody>
          </table>
        </div>
      }

      <DemoPriceControls symbols={openSymbols} labelOf={(s) => {const p = platform.pairs.find((x) => x.symbol === s);return p ? pairLabel(p) : s;}} />

      <AddPairModal
        open={adding}
        onClose={() => setAdding(false)}
        onAdded={(label) => {
          setAdding(false);
          toast.success(`${label} added`);
        }} />
      
      <EditPairModal
        pair={editPair}
        onClose={() => setEditing(null)}
        onSaved={(label) => {
          setEditing(null);
          toast.success(`${label} defaults saved`, { description: 'Existing subscriber settings and open positions are unchanged.' });
        }} />
      
    </PageContainer>);

}