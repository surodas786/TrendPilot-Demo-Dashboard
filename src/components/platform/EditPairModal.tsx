import React, { useState } from 'react';
import { usePlatform } from '../../contexts/PlatformContext';
import { pairLabel } from '../../data/platformSeed';
import { Button } from '../ui/Button';
import { Modal } from '../ui/Modal';
import { ModalHeader } from '../ui/ModalHeader';
import { defaultsErrors, hasErrors, PairDefaultsFields } from './PairDefaultsFields';
import type { DefaultsDraft } from './PairDefaultsFields';
import type { TradingPair } from '../../types/platform';

export function EditPairModal({ pair, onClose, onSaved }: {pair?: TradingPair;onClose: () => void;onSaved: (label: string) => void;}) {
  return (
    <Modal open={Boolean(pair)} onClose={onClose} labelledBy="edit-pair-title">
      {pair && <EditBody key={pair.symbol} pair={pair} onClose={onClose} onSaved={onSaved} />}
    </Modal>);

}

function EditBody({ pair, onClose, onSaved }: {pair: TradingPair;onClose: () => void;onSaved: (label: string) => void;}) {
  const { updatePairDefaults, setPairEnabled } = usePlatform();
  const [draft, setDraft] = useState<DefaultsDraft>({ stopLossPct: String(pair.stopLossPct), takeProfitPct: String(pair.takeProfitPct), trailingEnabled: pair.trailingEnabled, trailingPct: String(pair.trailingPct), enabled: pair.enabled });
  const [touched, setTouched] = useState(false);

  const save = (e: React.FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (hasErrors(defaultsErrors(draft))) return;
    updatePairDefaults(pair.symbol, {
      stopLossPct: Number(draft.stopLossPct),
      takeProfitPct: Number(draft.takeProfitPct),
      trailingEnabled: draft.trailingEnabled,
      trailingPct: draft.trailingEnabled ? Number(draft.trailingPct) : pair.trailingPct
    });
    setPairEnabled(pair.symbol, draft.enabled);
    onSaved(pairLabel(pair));
  };

  return (
    <form onSubmit={save} noValidate className="flex min-h-0 flex-col">
      <ModalHeader id="edit-pair-title" title={`Edit ${pairLabel(pair)}`} description={<span className="font-mono text-xs">{pair.symbol} · MEXC Futures (simulated)</span>} onClose={onClose} />
      <div className="scrollbar-thin overflow-y-auto px-5 py-5 sm:px-6">
        <PairDefaultsFields draft={draft} onChange={setDraft} showErrors={touched} />
      </div>
      <footer className="flex flex-col-reverse gap-2 border-t border-line px-5 py-4 sm:flex-row sm:justify-end sm:px-6">
        <Button onClick={onClose}>Cancel</Button>
        <Button type="submit" variant="primary">
          Save defaults
        </Button>
      </footer>
    </form>);

}