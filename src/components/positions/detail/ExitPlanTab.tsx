import React from 'react';
import { formatMaybe, formatQuantity } from '../../../utils/format';
import { remainingQty, workingStop } from '../../../utils/orders';
import { DetailField } from '../../dashboard/DetailField';
import { DetailSection, NOT_RECORDED } from './DetailSection';
import type { OrderRecord } from '../../../types/execution';
import type { Position } from '../../../types/trading';

interface Props {
  position: Position;
  orders: OrderRecord[];
  closed: boolean;
}

export function ExitPlanTab({ position: p, orders, closed }: Props) {
  if (p.managed === false) {
    return (
      <p className="rounded-lg border border-dashed border-line-strong px-4 py-8 text-center text-sm text-muted">
        This position was opened outside a managed strategy. It has no TrendPilot exit plan. Management adoption is outside this demo step.
      </p>);

  }
  const snap = p.exitSnapshot;
  const stop = workingStop(orders, p.id);
  const R = p.initialStop === null ? null : Math.abs(p.entryPrice - p.initialStop);
  const price = (v: number | null | undefined) => formatMaybe(v ?? null, p.priceDecimals, NOT_RECORDED);

  return (
    <div className="space-y-6">
      <p className="rounded-lg border border-line bg-inset px-3 py-2 text-xs text-muted">
        Immutable snapshot captured at entry. Later exit-plan versions and setting changes do not alter it. Manual stop tightening is logged separately and never changes the initial stop or R.
      </p>
      <DetailSection title="Entry configuration" first>
        <DetailField label="Exit plan" muted={!snap}>
          {snap?.planLabel ?? NOT_RECORDED}
        </DetailField>
        <DetailField label="Exit mode" muted={!snap}>
          {snap?.mode ?? NOT_RECORDED}
        </DetailField>
        <DetailField label="Trigger price basis">{p.triggerBasis}</DetailField>
        <DetailField label="Initial stop" muted={p.initialStop === null}>
          {price(p.initialStop)}
        </DetailField>
        <DetailField label="Original R" muted={R === null}>
          {R === null ? NOT_RECORDED : `${formatMaybe(R, p.priceDecimals)} per ${p.baseAsset}`}
        </DetailField>
        <DetailField label="Opposite-signal exit" muted={!snap}>
          {snap ? snap.oppositeExit ? 'Close remaining position' : 'Off' : NOT_RECORDED}
        </DetailField>
        <DetailField label="Partial target" muted={!snap?.partialTarget}>
          {snap ? snap.partialTarget ?? 'Not used by this plan' : NOT_RECORDED}
        </DetailField>
        <DetailField label="Close percentage" muted={!snap?.closePct}>
          {snap ? snap.closePct ? `${snap.closePct}%` : 'Not used by this plan' : NOT_RECORDED}
        </DetailField>
      </DetailSection>
      <DetailSection title="Current state">
        <DetailField label="Current effective stop" muted={closed || !stop}>
          {closed ? 'Closed — exit orders cancelled' : stop ? price(stop.price) : 'No confirmed resting stop'}
        </DetailField>
        <DetailField label="Remaining protective quantity" muted={closed || !stop}>
          {closed ? '—' : stop ? formatQuantity(remainingQty(stop), p.quantityDecimals, p.baseAsset) : 'None confirmed'}
        </DetailField>
        <DetailField label="Partial-exit status" muted={p.closedQuantity === 0}>
          {p.closedQuantity > 0 ? `${formatQuantity(p.closedQuantity, p.quantityDecimals, p.baseAsset)} closed` : 'None filled'}
        </DetailField>
        <DetailField label="Trailing activation state">{snap?.trailing ?? p.trailingState}</DetailField>
        <DetailField label="Best tracked price" muted={!snap?.bestPrice}>
          {snap?.bestPrice ? price(snap.bestPrice) : NOT_RECORDED}
        </DetailField>
        <DetailField label="Take-profit order" muted={!Number.isFinite(p.takeProfit)}>
          {price(p.takeProfit)}
        </DetailField>
      </DetailSection>
    </div>);

}