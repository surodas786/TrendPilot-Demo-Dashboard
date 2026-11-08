import React from 'react';
import { exchanges } from '../../../data/mockData';
import { entryNotional, markNotional, positionMargin, unrealizedPnl } from '../../../utils/accountMath';
import { formatDateTime } from '../../../utils/clock';
import { formatLeverage, formatNumber, formatQuantity, formatUsdt } from '../../../utils/format';
import { originalQuantity } from '../../../utils/positionDetail';
import type { RealizedBreakdown } from '../../../utils/positionDetail';
import { strategyWithVersion } from '../../../utils/strategies';
import { PnlText } from '../../ui/PnlText';
import { DetailField } from '../../dashboard/DetailField';
import { DetailSection, NOT_RECORDED, UNAVAILABLE } from './DetailSection';
import type { TradeRecord } from '../../../types/execution';
import type { Position } from '../../../types/trading';

interface Props {
  position: Position;
  trade: TradeRecord | null;
  realized: RealizedBreakdown;
  accountName: string;
}

export function OverviewTab({ position: p, trade, realized, accountName }: Props) {
  const closed = Boolean(trade);
  const exchange = exchanges.find((e) => e.id === p.exchangeId)?.name ?? p.exchangeId;
  const remaining = closed ? 0 : p.quantity;
  const origQty = trade ? trade.originalQty : originalQuantity(p);
  const q = (v: number) => formatQuantity(v, p.quantityDecimals, p.baseAsset);

  return (
    <div className="space-y-6">
      <DetailSection title="Identity" first>
        <DetailField label="Position ID">{p.id}</DetailField>
        <DetailField label="Account">{accountName}</DetailField>
        <DetailField label="Exchange">{exchange}</DetailField>
        <DetailField label="Pair · direction">
          {p.pair} · {p.direction === 'long' ? 'Long' : 'Short'}
        </DetailField>
        <DetailField label="Opened at">{p.openedAt} · Asia/Dhaka</DetailField>
        <DetailField label="Status">{closed && trade ? `Closed · ${formatDateTime(trade.exitAt)}` : p.closedQuantity > 0 ? 'Open · partially closed' : 'Open'}</DetailField>
      </DetailSection>

      <DetailSection title="Size and price">
        <DetailField label="Original quantity">{q(origQty)}</DetailField>
        <DetailField label="Remaining quantity">{q(remaining)}</DetailField>
        <DetailField label="Average entry">{formatNumber(p.entryPrice, p.priceDecimals)}</DetailField>
        <DetailField label={closed ? 'Weighted average exit' : 'Mark price (simulated)'}>{formatNumber(closed && trade ? trade.avgExit : p.markPrice, p.priceDecimals)}</DetailField>
        <DetailField label="Current notional" hint={closed ? undefined : `At entry ${formatUsdt(entryNotional(p))}`}>
          {closed ? formatUsdt(0) : formatUsdt(markNotional(p))}
        </DetailField>
        <DetailField label="Leverage · margin mode">
          {formatLeverage(p.leverage)} · {p.marginMode}
        </DetailField>
        <DetailField label="Original allocated entry cost" tooltip="Initial margin allocated to the original order, excluding fees and funding. Not the maximum possible loss.">
          {formatUsdt(p.allocatedCost)}
        </DetailField>
        <DetailField label="Current margin" hint={closed ? 'Released on closure — not profit' : p.closedQuantity > 0 ? 'Reduced after partial exits' : undefined}>
          {closed ? formatUsdt(0) : formatUsdt(positionMargin(p))}
        </DetailField>
      </DetailSection>

      <DetailSection title="P&L">
        <DetailField label="Realized gross" hint={`${q(realized.exitQty)} closed`}>
          <PnlText value={realized.gross} suffix="USDT" />
        </DetailField>
        <DetailField label="Unrealized" hint={closed ? 'None — position closed' : 'Remaining quantity at simulated mark'}>
          <PnlText value={closed ? 0 : unrealizedPnl(p)} suffix="USDT" />
        </DetailField>
        <DetailField label="Entry commission" muted={realized.entryFees === null}>
          {realized.entryFees === null ? NOT_RECORDED : formatUsdt(realized.entryFees)}
        </DetailField>
        <DetailField label="Exit commissions">{formatUsdt(realized.exitFees)}</DetailField>
        <DetailField label="Attributed funding" muted={!realized.fundingRecorded}>
          {realized.fundingRecorded ? `+${formatNumber(realized.fundingReceived)} received · −${formatNumber(realized.fundingPaid)} paid` : 'None recorded'}
        </DetailField>
        <DetailField label="Net realized" tooltip="Realized gross − entry and exit commissions + funding received − funding paid. Unrealized P&L is not included.">
          <PnlText value={realized.net} suffix="USDT" />
        </DetailField>
      </DetailSection>

      <DetailSection title="Liquidation">
        <DetailField label="Liquidation price" muted>
          {UNAVAILABLE}
        </DetailField>
        <DetailField label="Distance to liquidation" muted>
          {UNAVAILABLE}
        </DetailField>
        <DetailField label="Estimated liquidation loss" muted>
          {UNAVAILABLE}
        </DetailField>
      </DetailSection>

      <DetailSection title="Strategy and plan versions">
        <DetailField label="Strategy">{strategyWithVersion(p.strategyId, p.strategyVersion)}</DetailField>
        <DetailField label="Subscription" muted={!p.subscriptionLabel}>
          {p.subscriptionLabel ?? (p.managed === false ? 'None — unmanaged' : NOT_RECORDED)}
        </DetailField>
        <DetailField label="Exit-plan version" muted={!p.exitSnapshot}>
          {p.exitSnapshot?.planLabel ?? (p.managed === false ? 'No TrendPilot exit plan' : NOT_RECORDED)}
        </DetailField>
      </DetailSection>
    </div>);

}