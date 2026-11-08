import React, { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangleIcon, CheckCircle2Icon, CircleDotIcon, HelpCircleIcon, Loader2Icon, RefreshCwIcon, XCircleIcon } from 'lucide-react';
import { CLOSE_SLIPPAGE_PCT } from '../../data/mockData';
import { useDemo } from '../../contexts/DemoContext';
import { round2 } from '../../utils/accountMath';
import { checkPartialClose, estimateClose, qtyRules, submissionBlockReason } from '../../utils/execution';
import { formatNumber, formatQuantity, formatUsdt } from '../../utils/format';
import { cn } from '../../utils/cn';
import { Button } from '../ui/Button';
import { DirectionBadge } from '../ui/DirectionBadge';
import { Modal } from '../ui/Modal';
import { ModalHeader } from '../ui/ModalHeader';
import { PnlText } from '../ui/PnlText';
import { SegmentedControl } from '../ui/SegmentedControl';
import { TextField } from '../ui/TextField';
import type { CloseItemState, CloseRequestItem } from '../../types/execution';
import type { Position } from '../../types/trading';

export type CloseMode = 'full' | 'partial' | 'all';

interface Props {
  open: boolean;
  accountId: string;
  positionIds: string[];
  mode: CloseMode;
  onClose: () => void;
}

export function ClosePositionsDialog({ open, accountId, positionIds, mode, onClose }: Props) {
  return (
    <Modal open={open} onClose={onClose} labelledBy="close-dialog-title" size="lg">
      {open && <CloseBody accountId={accountId} positionIds={positionIds} initialMode={mode} onClose={onClose} />}
    </Modal>);

}

const STATE_META: Record<CloseItemState, {label: string;tone: string;icon: typeof CheckCircle2Icon;}> = {
  requested: { label: 'Requested', tone: 'text-muted', icon: CircleDotIcon },
  submitted: { label: 'Submitted', tone: 'text-muted', icon: CircleDotIcon },
  'partially-filled': { label: 'Partially filled', tone: 'text-warn', icon: AlertTriangleIcon },
  filled: { label: 'Filled', tone: 'text-gain', icon: CheckCircle2Icon },
  failed: { label: 'Failed', tone: 'text-loss', icon: XCircleIcon },
  unknown: { label: 'Outcome unknown', tone: 'text-warn', icon: HelpCircleIcon }
};

function CloseBody({ accountId, positionIds, initialMode, onClose }: {accountId: string;positionIds: string[];initialMode: CloseMode;onClose: () => void;}) {
  const { state, accountById, submitClose, reconcileOrder } = useDemo();
  // One request id per dialog session: repeated clicks or re-renders can never create a second request.
  const [requestId] = useState(() => `REQ-${Date.now().toString(36).toUpperCase()}`);
  const submitted = useRef(false);
  const [phase, setPhase] = useState<'review' | 'submitting' | 'result'>('review');
  const [mode, setMode] = useState<CloseMode>(initialMode);
  const [unit, setUnit] = useState<'percent' | 'quantity'>('percent');
  const [amount, setAmount] = useState('50');
  const account = accountById(accountId);
  const block = submissionBlockReason(account);

  // Freeze the positions under review when the dialog opens.
  const [reviewed] = useState<Position[]>(() => state.positions.filter((p) => positionIds.includes(p.id) && p.managed !== false));
  const single = reviewed.length === 1 ? reviewed[0] : null;
  const partial = mode === 'partial' && single ? checkPartialClose(single, unit, Number(amount.replace(/,/g, ''))) : null;

  const lines = useMemo(
    () =>
    reviewed.map((p) => {
      const qty = mode === 'partial' && partial ? partial.qty : p.quantity;
      return { p, est: estimateClose(p, qty, state.simFeeRatePct) };
    }),
    [reviewed, mode, partial, state.simFeeRatePct]
  );
  const totals = { gross: round2(lines.reduce((a, l) => a + l.est.gross, 0)), fee: round2(lines.reduce((a, l) => a + l.est.fee, 0)) };
  const canConfirm = phase === 'review' && reviewed.length > 0 && (mode !== 'partial' || partial !== null && partial.error === null);
  const request = state.closeRequests.find((r) => r.id === requestId);

  useEffect(() => {
    if (phase !== 'submitting') return;
    const t = window.setTimeout(() => {
      submitClose(requestId, accountId, mode, lines.map((l) => ({ positionId: l.p.id, qty: l.est.qty })));
      setPhase('result');
    }, 450);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  const confirm = () => {
    if (!canConfirm || submitted.current) return;
    submitted.current = true;
    setPhase('submitting');
  };

  const title = phase === 'result' ? 'Paper close result' : mode === 'all' ? 'Close all managed paper positions' : mode === 'partial' ? 'Close part of paper position' : 'Close full paper position';

  return (
    <>
      <ModalHeader id="close-dialog-title" title={title} description={`${account?.name ?? ''} · MEXC Futures · paper simulation`} onClose={onClose} />
      <div className="scrollbar-thin flex-1 space-y-4 overflow-y-auto px-5 py-5 sm:px-6">
        {phase !== 'result' &&
        <>
            {single && initialMode !== 'all' &&
          <SegmentedControl<CloseMode>
            label="Close type"
            value={mode}
            onChange={(m) => phase === 'review' && setMode(m)}
            options={[
            { value: 'full', label: 'Full close' },
            { value: 'partial', label: 'Part close' }]
            } />

          }
            {mode === 'partial' && single &&
          <PartialInputs position={single} unit={unit} setUnit={setUnit} amount={amount} setAmount={setAmount} check={partial} onFull={() => setMode('full')} />
          }
            {reviewed.length === 0 ?
          <p className="rounded-lg border border-dashed border-line-strong px-4 py-6 text-center text-sm text-muted">No managed positions to close in this account.</p> :

          <ul className="divide-y divide-line rounded-lg border border-line">
                {lines.map(({ p, est }) =>
            <li key={p.id} className="px-3 py-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-semibold text-ink">{p.pair}</span>
                      <DirectionBadge direction={p.direction} />
                      <span className="text-xs text-subtle">{p.id}</span>
                    </div>
                    <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs sm:grid-cols-3">
                      <Field label="Quantity to close" value={formatQuantity(est.qty, qtyRules(p).decimals, p.baseAsset)} />
                      <Field label="Reference price (mark, sim.)" value={formatNumber(est.reference, p.priceDecimals)} />
                      <Field label="Assumed fill" value={formatNumber(est.fill, p.priceDecimals)} />
                      <Field label="Est. gross realized" value={<PnlText value={est.gross} className="text-xs" />} />
                      <Field label={`Est. closing fee (${state.simFeeRatePct}%)`} value={formatUsdt(est.fee)} />
                      <Field label="Expected remaining" value={formatQuantity(est.remaining, qtyRules(p).decimals, p.baseAsset)} />
                    </dl>
                  </li>
            )}
              </ul>
          }
            {reviewed.length > 1 &&
          <div className="flex justify-between rounded-lg bg-inset px-3 py-2 text-sm">
                <span className="text-muted">Totals · {reviewed.length} positions</span>
                <span className="flex gap-4">
                  <PnlText value={totals.gross} suffix="gross" />
                  <span className="tabular-nums text-ink">{formatUsdt(totals.fee)} fees</span>
                </span>
              </div>
          }
            <ul className="space-y-1 text-xs text-subtle">
              <li>· Slippage assumption: {CLOSE_SLIPPAGE_PCT}% adverse to the position from the simulated mark price. Actual simulated fills may differ.</li>
              <li>· Closing orders are reduce-only and can never open reverse exposure. Released margin is not profit.</li>
              <li>· Entry pauses do not block closing actions. External unmanaged positions are never included.</li>
            </ul>
            {block &&
          <p className="flex items-start gap-2 rounded-lg border border-loss/40 bg-loss/10 px-3 py-2.5 text-sm text-ink" role="alert">
                <XCircleIcon className="mt-0.5 h-4 w-4 shrink-0 text-loss" aria-hidden />
                {block}. Requests will be recorded as failed and nothing will be filled.
              </p>
          }
          </>
        }

        {phase === 'result' && request && <ResultView items={request.items} onReconcile={reconcileOrder} />}
      </div>
      <div className="flex flex-col-reverse gap-2 border-t border-line px-5 py-4 sm:flex-row sm:justify-end sm:px-6">
        <Button onClick={onClose}>{phase === 'result' ? 'Done' : 'Cancel'}</Button>
        {phase !== 'result' &&
        <Button variant="danger" onClick={confirm} disabled={!canConfirm} loading={phase === 'submitting'}>
            {phase === 'submitting' ? 'Submitting…' : 'Confirm paper close'}
          </Button>
        }
      </div>
    </>);

}

function PartialInputs({
  position: p,
  unit,
  setUnit,
  amount,
  setAmount,
  check,
  onFull








}: {position: Position;unit: 'percent' | 'quantity';setUnit: (u: 'percent' | 'quantity') => void;amount: string;setAmount: (v: string) => void;check: ReturnType<typeof checkPartialClose> | null;onFull: () => void;}) {
  const rules = qtyRules(p);
  return (
    <div className="space-y-3 rounded-lg border border-line bg-inset p-3">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <SegmentedControl<'percent' | 'quantity'>
          label="Close by"
          value={unit}
          onChange={(u) => {
            setUnit(u);
            setAmount(u === 'percent' ? '50' : String(rules.min));
          }}
          options={[
          { value: 'percent', label: 'Percentage' },
          { value: 'quantity', label: `Quantity (${p.baseAsset})` }]
          } />
        
        <TextField
          label={unit === 'percent' ? 'Percent of remaining' : `Underlying quantity`}
          value={amount}
          onChange={setAmount}
          inputMode="decimal"
          className="sm:w-44"
          trailing={<span className="pr-2 text-xs text-subtle">{unit === 'percent' ? '%' : p.baseAsset}</span>} />
        
      </div>
      <p className="text-xs text-subtle">
        Rounded down to the fictional step {rules.step} {p.baseAsset}; closing quantity and remainder must each be at least {rules.min} {p.baseAsset}. Remaining now:{' '}
        {formatQuantity(p.quantity, rules.decimals, p.baseAsset)}.
      </p>
      {check?.error &&
      <div className="flex flex-col gap-2 rounded-lg border border-warn/40 bg-warn/10 px-3 py-2.5 text-sm text-ink sm:flex-row sm:items-center sm:justify-between" role="alert">
          <span>{check.error}</span>
          {check.needsFull &&
        <Button size="sm" variant="warn" onClick={onFull}>
              Switch to full close
            </Button>
        }
        </div>
      }
    </div>);

}

function ResultView({ items, onReconcile }: {items: CloseRequestItem[];onReconcile: (orderId: string) => void;}) {
  const filled = items.filter((i) => i.state === 'filled').length;
  const allFilled = filled === items.length && items.length > 0;
  return (
    <div className="space-y-3">
      <div className={cn('flex items-start gap-2 rounded-lg border px-3 py-2.5 text-sm', allFilled ? 'border-gain/35 bg-gain/10' : 'border-warn/40 bg-warn/10')} role="status">
        {allFilled ? <CheckCircle2Icon className="mt-0.5 h-4 w-4 shrink-0 text-gain" aria-hidden /> : <AlertTriangleIcon className="mt-0.5 h-4 w-4 shrink-0 text-warn" aria-hidden />}
        <div>
          <p className="font-semibold text-ink">{allFilled ? 'All closing fills confirmed' : `${filled} of ${items.length} closes filled — not completed`}</p>
          <p className="text-muted">{allFilled ? 'Balances, risk usage and history now reflect these fills.' : 'Positions without a confirmed fill remain open. Review each result below.'}</p>
        </div>
      </div>
      <ul className="divide-y divide-line rounded-lg border border-line">
        {items.map((i) => {
          const meta = STATE_META[i.state];
          const Icon = meta.icon;
          return (
            <li key={i.positionId} className="px-3 py-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="flex items-center gap-2">
                  <span className="font-semibold text-ink">{i.pair}</span>
                  <DirectionBadge direction={i.direction} />
                </span>
                <span className={cn('inline-flex items-center gap-1.5 text-sm font-medium', meta.tone)}>
                  <Icon className="h-4 w-4" aria-hidden />
                  {meta.label}
                </span>
              </div>
              <ol className="mt-2 flex flex-wrap items-center gap-1 text-[11px] text-subtle" aria-label="Request states">
                {i.trail.map((st, idx) =>
                <li key={`${st}-${idx}`} className="flex items-center gap-1">
                    {idx > 0 && <span aria-hidden>→</span>}
                    <span className={cn('rounded border border-line px-1.5 py-0.5', idx === i.trail.length - 1 && STATE_META[st].tone)}>{STATE_META[st].label}</span>
                  </li>
                )}
              </ol>
              <p className="mt-2 text-xs text-muted">
                Filled {formatQuantity(i.filledQty, i.quantityDecimals, i.baseAsset)} of {formatQuantity(i.requestedQty, i.quantityDecimals, i.baseAsset)}
                {i.fillPrice !== null && ` at ${formatNumber(i.fillPrice, i.priceDecimals)}`} · remaining {formatQuantity(i.remainingQty, i.quantityDecimals, i.baseAsset)}
              </p>
              {i.reason && <p className="mt-1 text-xs text-ink">{i.reason}</p>}
              {i.state === 'unknown' && i.orderId &&
              <Button size="sm" icon={RefreshCwIcon} className="mt-2" onClick={() => onReconcile(i.orderId as string)}>
                  Reconcile simulated status
                </Button>
              }
            </li>);

        })}
      </ul>
      {items.some((i) => i.state === 'unknown') &&
      <p className="flex items-center gap-1.5 text-xs text-subtle">
          <Loader2Icon className="h-3.5 w-3.5" aria-hidden /> Resubmitting is not offered while an outcome is unknown — it could duplicate exposure.
        </p>
      }
    </div>);

}

function Field({ label, value }: {label: string;value: React.ReactNode;}) {
  return (
    <div className="min-w-0">
      <dt className="text-subtle">{label}</dt>
      <dd className="tabular-nums text-ink">{value}</dd>
    </div>);

}