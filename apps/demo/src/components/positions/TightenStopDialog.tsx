import React, { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { useDemo } from '../../contexts/DemoContext';
import { simFor } from '../../contexts/executionReducer';
import { submissionBlockReason } from '../../utils/execution';
import { formatNumber, formatQuantity } from '../../utils/format';
import { remainingQty, workingStop } from '../../utils/orders';
import { protectionInfo } from '../../utils/protection';
import { Button } from '../ui/Button';
import { Modal } from '../ui/Modal';
import { ModalHeader } from '../ui/ModalHeader';
import { TextField } from '../ui/TextField';
import type { OrderRecord } from '../../types/execution';
import type { DemoAccount, Position } from '../../types/trading';

/** Why tightening is not possible right now, or null when it is. */
export function tightenUnavailableReason(p: Position, account: DemoAccount | undefined, orders: OrderRecord[]): string | null {
  if (p.managed === false) return 'Management adoption is outside this demo step.';
  const info = protectionInfo(p, account, orders);
  if (info.status === 'unknown') return `Current stop data unknown — ${info.note}`;
  const stop = workingStop(orders, p.id);
  if (!stop || stop.price === null) return 'Current stop data unknown — there is no confirmed resting stop to replace. Use Close paper position instead.';
  return null;
}

interface Props {
  position: Position | null;
  onClose: () => void;
  onRequestClose: (positionId: string) => void;
}

export function TightenStopDialog({ position, onClose, onRequestClose }: Props) {
  return (
    <Modal open={Boolean(position)} onClose={onClose} labelledBy="tighten-title">
      {position && <TightenBody position={position} onClose={onClose} onRequestClose={onRequestClose} />}
    </Modal>);

}

function TightenBody({ position: p, onClose, onRequestClose }: {position: Position;onClose: () => void;onRequestClose: (id: string) => void;}) {
  const { state, accountById, tightenStop } = useDemo();
  const stop = workingStop(state.orders, p.id);
  const current = stop?.price ?? null;
  const [value, setValue] = useState(current !== null ? String(current) : '');
  const [phase, setPhase] = useState<'edit' | 'confirming'>('edit');
  const account = accountById(p.accountId);
  const long = p.direction === 'long';
  const proposed = Number(value.replace(/,/g, ''));
  const fmt = (v: number) => formatNumber(v, p.priceDecimals);

  let error: string | null = null;
  let toClose = false;
  if (current === null) error = 'Current stop data unknown.';else
  if (!value.trim() || !Number.isFinite(proposed) || proposed <= 0) error = 'Enter a stop price above 0.';else
  if (long ? proposed <= current : proposed >= current) error = `Only a more protective stop is allowed: ${long ? 'higher' : 'lower'} than the current ${fmt(current)}.`;else
  if (long ? proposed >= p.markPrice : proposed <= p.markPrice) {
    error = `A ${long ? 'long' : 'short'} stop must stay ${long ? 'below' : 'above'} the current trigger-basis price ${fmt(p.markPrice)}. Use Close paper position to exit now.`;
    toClose = true;
  }

  useEffect(() => {
    if (phase !== 'confirming') return;
    const fails = Boolean(submissionBlockReason(account)) || simFor(state, p.accountId).protectionReplace === 'fail';
    const t = window.setTimeout(() => {
      tightenStop(p.id, Number(proposed.toFixed(p.priceDecimals)));
      if (fails) toast.error('Stop replacement failed', { description: `Previous confirmed stop ${fmt(current as number)} is still active.` });else
      toast.success('Stop tightened', { description: `${p.pair}: ${fmt(current as number)} → ${fmt(proposed)} · replacement confirmed (simulated).` });
      onClose();
    }, 700);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  return (
    <>
      <ModalHeader id="tighten-title" title={`Tighten stop · ${p.pair} ${long ? 'Long' : 'Short'}`} description={`${account?.name ?? ''} · paper simulation`} onClose={onClose} />
      <div className="scrollbar-thin flex-1 space-y-4 overflow-y-auto px-5 py-5 sm:px-6">
        <dl className="grid grid-cols-2 gap-3 rounded-lg border border-line bg-inset p-3 text-sm">
          {[
          ['Current confirmed stop', current === null ? 'Unknown' : fmt(current)],
          ['Trigger basis', stop?.triggerBasis ?? p.triggerBasis],
          ['Trigger-basis price (sim.)', fmt(p.markPrice)],
          ['Quantity protected', stop ? formatQuantity(remainingQty(stop), p.quantityDecimals, p.baseAsset) : '—'],
          ['Initial stop (kept for R)', p.initialStop === null ? 'Not recorded in this demo' : fmt(p.initialStop)]].
          map(([k, v]) =>
          <div key={k}>
              <dt className="text-xs text-subtle">{k}</dt>
              <dd className="tabular-nums text-ink">{v}</dd>
            </div>
          )}
        </dl>
        <TextField label="Proposed stop" value={value} onChange={setValue} inputMode="decimal" error={value !== String(current) ? error ?? undefined : undefined} hint={`${long ? 'Must be higher than the current stop and below' : 'Must be lower than the current stop and above'} the trigger-basis price.`} />
        {toClose &&
        <Button size="sm" variant="danger" onClick={() => onRequestClose(p.id)}>
            Close paper position instead
          </Button>
        }
        <p className="text-xs text-subtle">
          The displayed stop updates only after the simulated replacement is confirmed. If replacement fails, the previously confirmed stop stays active. The original initial stop and R are retained for reporting.
        </p>
      </div>
      <div className="flex flex-col-reverse gap-2 border-t border-line px-5 py-4 sm:flex-row sm:justify-end sm:px-6">
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" disabled={Boolean(error) || phase !== 'edit'} loading={phase === 'confirming'} onClick={() => setPhase('confirming')}>
          {phase === 'confirming' ? 'Awaiting confirmation…' : 'Replace stop'}
        </Button>
      </div>
    </>);

}