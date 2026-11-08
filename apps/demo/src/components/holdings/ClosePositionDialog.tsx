import React, { useState } from 'react';
import { toast } from 'sonner';
import { useDemo } from '../../contexts/DemoContext';
import { usePlatform } from '../../contexts/PlatformContext';
import { formatQty, pnlFor } from '../../utils/holdingsMath';
import { formatPrice } from '../../utils/platformText';
import { fillModelNote } from '../../contexts/signals/tokenExecution';
import { Button } from '../ui/Button';
import { Modal } from '../ui/Modal';
import { ModalHeader } from '../ui/ModalHeader';
import { SideText, SignedPnl } from './SignedPnl';
import type { HoldingView } from '../../types/holdings';

export function ClosePositionDialog({ position, pairLabel, onClose }: {position?: HoldingView;pairLabel: string;onClose: () => void;}) {
  return (
    <Modal open={Boolean(position)} onClose={onClose} labelledBy="close-pos-title">
      {position && <CloseBody key={position.id} position={position} pairLabel={pairLabel} onClose={onClose} />}
    </Modal>);

}

function CloseBody({ position: p, pairLabel, onClose }: {position: HoldingView;pairLabel: string;onClose: () => void;}) {
  const { state, closeTokenPosition, submitClose } = useDemo();
  const { closeHolding } = usePlatform();
  const [closing, setClosing] = useState(false);
  const price = p.currentPrice;
  const est = price ? pnlFor(p.side, p.entryPrice, price, p.remainingQty) : null;
  const stillOpen = p.kind === 'migrated' ? p.status === 'open' : state.positions.some((x) => x.id === p.id);

  const confirm = () => {
    if (closing || !stillOpen || !price) return;
    setClosing(true);
    if (p.kind === 'token') closeTokenPosition(p.id);else
    if (p.kind === 'legacy' && p.accountId) submitClose(`hold-close-${p.id}`, p.accountId, 'full', [{ positionId: p.id, qty: p.remainingQty }]);else
    closeHolding(p.subscriberId, p.id);
    toast.success('Close submitted — Manual close', { description: `${pairLabel} · ${p.accountLabel}. Completed trades appear in Closed Trades and Trade History.` });
    onClose();
  };

  return (
    <>
      <ModalHeader id="close-pos-title" title="Close position?" description="Closes the remaining quantity once at the current simulated price and cancels its remaining simulated exits." onClose={onClose} />
      <dl className="grid grid-cols-2 gap-3 px-5 py-5 text-sm tabular-nums sm:px-6">
        <div>
          <dt className="text-xs text-subtle">Pair</dt>
          <dd className="text-ink">
            {pairLabel} · <SideText side={p.side} />
          </dd>
        </div>
        <div>
          <dt className="text-xs text-subtle">Account</dt>
          <dd className="text-ink">{p.accountLabel}</dd>
        </div>
        <div>
          <dt className="text-xs text-subtle">Remaining quantity</dt>
          <dd className="text-ink">{formatQty(p.remainingQty)}</dd>
        </div>
        <div>
          <dt className="text-xs text-subtle">Current simulated price</dt>
          <dd className="text-ink">{price ? formatPrice(price) : 'No valid price'}</dd>
        </div>
        <div className="col-span-2">
          <dt className="text-xs text-subtle">Estimated gross P&amp;L before fees and slippage</dt>
          <dd>{est === null ? '—' : <SignedPnl value={est} />}</dd>
        </div>
        <p className="col-span-2 text-xs text-subtle">{p.kind === 'migrated' ? 'Migrated holding — not linked to an account, so no fee or balance is booked.' : fillModelNote(state.simFeeRatePct)}</p>
        {!stillOpen && <p className="col-span-2 text-xs text-warn">This position has already closed.</p>}
      </dl>
      <footer className="flex flex-col-reverse gap-2 border-t border-line px-5 py-4 sm:flex-row sm:justify-end sm:px-6">
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="danger" onClick={confirm} disabled={closing || !stillOpen || !price} loading={closing}>
          Close Position
        </Button>
      </footer>
    </>);

}