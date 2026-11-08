import React from 'react';
import { InfoTooltip } from '../ui/InfoTooltip';
import { PnlText } from '../ui/PnlText';
import { formatNumber } from '../../utils/format';
import type { LedgerTotals } from '../../types/trading';

interface PnlLedgerProps {
  ledger: LedgerTotals;
}

export function PnlLedger({ ledger }: PnlLedgerProps) {
  return (
    <dl className="text-sm">
      <LedgerRow label="Gross realized trading P&L">
        <PnlText value={ledger.grossRealized} />
      </LedgerRow>
      <LedgerRow label="Commissions">
        <span className="font-semibold tabular-nums text-loss">
          {ledger.commissions > 0 ? `−${formatNumber(ledger.commissions)}` : formatNumber(0)}
        </span>
      </LedgerRow>
      <LedgerRow label="Funding received">
        <PnlText value={ledger.fundingReceived} />
      </LedgerRow>
      <LedgerRow label="Funding paid">
        <span className="font-semibold tabular-nums text-loss">
          {ledger.fundingPaid > 0 ? `−${formatNumber(ledger.fundingPaid)}` : formatNumber(0)}
        </span>
      </LedgerRow>
      <div className="mt-1 flex items-center justify-between border-t border-dashed border-line-strong pt-2.5">
        <dt className="flex items-center gap-1.5 font-semibold text-ink">
          Net realized P&L
          <InfoTooltip
            label="How net realized P&L is calculated"
            content="Net realized P&L = gross realized trading P&L − commissions + funding received − funding paid." />
          
        </dt>
        <dd className="text-base">
          <PnlText value={ledger.netRealized} />
        </dd>
      </div>
      <div className="mt-3 flex items-center justify-between rounded-lg bg-accent/10 px-3 py-2">
        <dt className="flex items-center gap-1.5 font-medium text-accent">
          Unrealized P&L
          <InfoTooltip
            label="About unrealized P&L"
            content="Unrealized P&L belongs to open positions. It changes with the simulated mark price and becomes realized only when a position is closed." />
          
        </dt>
        <dd>
          <PnlText value={ledger.unrealized} />
        </dd>
      </div>
    </dl>);

}

function LedgerRow({ label, children }: {label: string;children: React.ReactNode;}) {
  return (
    <div className="flex items-center justify-between py-1.5">
      <dt className="text-muted">{label}</dt>
      <dd>{children}</dd>
    </div>);

}