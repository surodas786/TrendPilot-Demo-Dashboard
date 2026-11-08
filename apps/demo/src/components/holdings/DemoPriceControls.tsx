import React, { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { usePlatform } from '../../contexts/PlatformContext';
import { useDemo } from '../../contexts/DemoContext';
import { ownerOf } from '../../data/demoUsers';
import { formatPrice } from '../../utils/platformText';
import { Button } from '../ui/Button';
import { FilterSelect } from '../ui/FilterSelect';
import { TextField } from '../ui/TextField';

/** Shared demo price input — routes through the same exit engine as feed updates. */
export function DemoPriceControls({ symbols, labelOf }: {symbols: string[];labelOf: (s: string) => string;}) {
  const { platform, applyDemoPrice } = usePlatform();
  const { state } = useDemo();
  const [symbol, setSymbol] = useState(symbols[0] ?? '');
  const [price, setPrice] = useState('');
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    if (!symbols.includes(symbol)) setSymbol(symbols[0] ?? '');
  }, [symbols, symbol]);

  const current = platform.prices[symbol]?.price;
  // Who this shared price affects: every investor holding the pair (administrator view only).
  const holders = state.positions.filter((p) => p.pair === symbol);
  const affected = [...new Set(holders.map((p) => state.users.find((u) => u.id === ownerOf(state.accounts.find((a) => a.id === p.accountId)))?.name ?? 'Unknown investor'))];
  const apply = (e: React.FormEvent) => {
    e.preventDefault();
    const n = Number(price);
    if (!price.trim() || !Number.isFinite(n) || n <= 0) {
      setError('Enter a positive price.');
      return;
    }
    setError(undefined);
    applyDemoPrice(symbol, n);
    setPrice('');
    toast(`${labelOf(symbol)} set to ${formatPrice(n)}`, { description: 'Exits were checked once for every simulated position on this pair.' });
  };

  return (
    <section aria-labelledby="demo-controls-title" className="rounded-xl border border-dashed border-line-strong bg-surface p-4">
      <h2 id="demo-controls-title" className="text-sm font-semibold text-ink">
        Demo Controls
      </h2>
      <p className="mt-0.5 text-xs text-warn">Shared demo price — affects all simulated positions for this pair.</p>
      {symbols.length === 0 ?
      <p className="mt-3 text-sm text-muted">Available once you have an open position.</p> :

      <form onSubmit={apply} noValidate className="mt-3 grid gap-3 sm:grid-cols-[180px_minmax(0,220px)_auto] sm:items-start">
          <FilterSelect label="Pair" value={symbol} onChange={setSymbol} options={symbols.map((s) => ({ value: s, label: labelOf(s) }))} />
          <TextField label={`Price${current ? ` (now ${formatPrice(current)})` : ''}`} inputMode="decimal" value={price} onChange={setPrice} error={error} />
          <Button type="submit" variant="primary" className="sm:mt-6">
            Apply Price
          </Button>
        </form>
      }
      {symbols.length > 0 &&
      <p className="mt-2 text-xs text-muted">
          Affects {holders.length} open position{holders.length === 1 ? '' : 's'} on {labelOf(symbol)} for {affected.join(', ') || 'no investors'}. Holdings, the Dashboard and exit checks all use this price.
        </p>
      }
    </section>);

}