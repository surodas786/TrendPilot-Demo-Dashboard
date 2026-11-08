import React, { useMemo, useState } from 'react';
import { CheckIcon, SearchIcon } from 'lucide-react';
import { usePlatform } from '../../contexts/PlatformContext';
import { PAIR_CATALOGUE, pairLabel } from '../../data/platformSeed';
import { simNow } from '../../utils/clock';
import { cn } from '../../utils/cn';
import { Button } from '../ui/Button';
import { Modal } from '../ui/Modal';
import { ModalHeader } from '../ui/ModalHeader';
import { defaultsErrors, hasErrors, PairDefaultsFields } from './PairDefaultsFields';
import type { DefaultsDraft } from './PairDefaultsFields';

export function AddPairModal({ open, onClose, onAdded }: {open: boolean;onClose: () => void;onAdded: (label: string) => void;}) {
  return (
    <Modal open={open} onClose={onClose} labelledBy="add-pair-title" size="lg">
      <AddPairBody onClose={onClose} onAdded={onAdded} />
    </Modal>);

}

const normalize = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, '');

function AddPairBody({ onClose, onAdded }: {onClose: () => void;onAdded: (label: string) => void;}) {
  const { platform, addPair } = usePlatform();
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [draft, setDraft] = useState<DefaultsDraft>({ stopLossPct: '2', takeProfitPct: '4', trailingEnabled: false, trailingPct: '1.5', enabled: true });
  const [touched, setTouched] = useState(false);
  const existing = useMemo(() => new Set(platform.pairs.map((p) => p.symbol)), [platform.pairs]);

  const q = normalize(query);
  const results = PAIR_CATALOGUE.filter((c) => !q || c.symbol.includes(q) || normalize(pairLabel(c)).includes(q));
  const pick = PAIR_CATALOGUE.find((c) => c.symbol === selected);

  const submit = () => {
    setTouched(true);
    if (!pick || existing.has(pick.symbol) || hasErrors(defaultsErrors(draft))) return;
    addPair({
      symbol: pick.symbol,
      base: pick.base,
      quote: pick.quote,
      enabled: draft.enabled,
      stopLossPct: Number(draft.stopLossPct),
      takeProfitPct: Number(draft.takeProfitPct),
      trailingEnabled: draft.trailingEnabled,
      trailingPct: Number(draft.trailingPct) || 1,
      updatedAt: simNow()
    });
    onAdded(pairLabel(pick));
  };

  return (
    <>
      <ModalHeader id="add-pair-title" title="Add Pair" description="Simulated MEXC futures catalogue — demo data, not a verified live exchange listing." onClose={onClose} />
      <div className="scrollbar-thin space-y-4 overflow-y-auto px-5 py-5 sm:px-6">
        <div className="flex flex-col gap-1">
          <label htmlFor="pair-search" className="text-xs font-medium text-subtle">
            Search catalogue
          </label>
          <div className="relative">
            <SearchIcon className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-subtle" aria-hidden />
            <input id="pair-search" type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="e.g. ETH or ETH/USDT" autoFocus className="h-9 w-full rounded-lg border border-line bg-inset pl-9 pr-3 text-sm text-ink placeholder:text-subtle hover:border-line-strong focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/60" />
          </div>
        </div>
        <ul role="listbox" aria-label="Catalogue pairs" className="scrollbar-thin max-h-48 divide-y divide-line overflow-y-auto rounded-lg border border-line">
          {results.length === 0 && <li className="px-3 py-3 text-sm text-muted">No catalogue pair matches “{query}”.</li>}
          {results.map((c) => {
            const added = existing.has(c.symbol);
            const isSel = selected === c.symbol;
            return (
              <li key={c.symbol} role="option" aria-selected={isSel} aria-disabled={added}>
                <button type="button" disabled={added} onClick={() => setSelected(c.symbol)} className={cn('flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm transition-colors duration-150', added ? 'cursor-not-allowed text-subtle' : isSel ? 'bg-accent/10 text-accent' : 'text-ink hover:bg-inset')}>
                  <span>
                    {pairLabel(c)} <span className="ml-1 font-mono text-xs text-subtle">{c.symbol}</span>
                  </span>
                  {added ? <span className="text-xs">Already added</span> : isSel && <CheckIcon className="h-4 w-4" aria-hidden />}
                </button>
              </li>);

          })}
        </ul>
        {touched && !pick && <p className="text-xs text-loss">Select a pair from the catalogue.</p>}
        {pick && <PairDefaultsFields draft={draft} onChange={setDraft} showErrors={touched} />}
      </div>
      <footer className="flex flex-col-reverse gap-2 border-t border-line px-5 py-4 sm:flex-row sm:justify-end sm:px-6">
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" onClick={submit}>
          Add pair
        </Button>
      </footer>
    </>);

}