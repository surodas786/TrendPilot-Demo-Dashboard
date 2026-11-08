import React from 'react';
import { XCircleIcon } from 'lucide-react';
import { usePlatform } from '../../contexts/PlatformContext';
import { formatClock } from '../../utils/clock';
import { formatUserDate } from '../../utils/userDirectory';
import { formatQty, GROSS_NOTE, MODEL_NOTE } from '../../utils/holdingsMath';
import { unrealizedOf } from '../../utils/holdingsView';
import { useDemo } from '../../contexts/DemoContext';
import { fillModelNote } from '../../contexts/signals/tokenExecution';
import { formatPrice } from '../../utils/platformText';
import { formatUsdt, MODE_LABEL } from '../../utils/tokenBlocks';
import { Button } from '../ui/Button';
import { SidePanel } from '../ui/SidePanel';
import { StatusPill } from '../ui/StatusPill';
import { PositionPriceChart } from './PositionPriceChart';
import { SideText, SignedPnl } from './SignedPnl';
import type { HoldingView } from '../../types/holdings';

function Field({ label, children, wide }: {label: string;children: React.ReactNode;wide?: boolean;}) {
  return (
    <div className={wide ? 'col-span-2' : undefined}>
      <dt className="text-xs text-subtle">{label}</dt>
      <dd className="mt-0.5 text-sm text-ink tabular-nums">{children}</dd>
    </div>);

}

interface Props {
  position?: HoldingView;
  pairLabel: string;
  onClose: () => void;
  onRequestClose: (id: string) => void;
}

export function PositionDrawer({ position, pairLabel, onClose, onRequestClose }: Props) {
  const { platform } = usePlatform();
  const { state } = useDemo();
  const p = position;
  const price = p?.currentPrice;
  return (
    <SidePanel
      open={Boolean(p)}
      onClose={onClose}
      widthClassName="sm:w-[520px]"
      title={
      p &&
      <h2 className="flex flex-wrap items-center gap-2 text-base font-semibold text-ink">
            {pairLabel} <SideText side={p.side} /> <StatusPill tone={p.mode === 'live' ? 'warn' : 'accent'}>{MODE_LABEL[p.mode]}</StatusPill>
          </h2>

      }
      subtitle={p && <span className="font-mono text-xs">{p.id}</span>}
      footer={
      p?.status === 'open' &&
      <Button variant="danger" icon={XCircleIcon} className="w-full" onClick={() => onRequestClose(p.id)}>
            Close Position
          </Button>

      }>
      
      {p &&
      <div className="space-y-5">
          <dl className="grid grid-cols-2 gap-x-4 gap-y-3">
            <Field label="Strategy package">{p.packageName}</Field>
            <Field label="Account">{p.accountLabel}</Field>
            <Field label="Entry price">{formatPrice(p.entryPrice)}</Field>
            <Field label="Current simulated price">{price ? formatPrice(price) : '—'}</Field>
            <Field label="Margin allocated at entry">{formatUsdt(p.orderCost)}</Field>
            <Field label="Leverage · margin mode">
              {p.leverage}× · {p.marginMode === 'isolated' ? 'Isolated' : 'Cross'}
            </Field>
            <Field label="Original quantity">{formatQty(p.originalQty)}</Field>
            <Field label="Remaining quantity">{formatQty(p.remainingQty)}</Field>
            <Field label="Original position value">{formatUsdt(p.originalQty * p.entryPrice)}</Field>
            <Field label="Opened (Asia/Dhaka)">
              {formatUserDate(p.openedAt)} · {formatClock(p.openedAt)}
            </Field>
            <Field label="Stop-loss price">
              {formatPrice(p.stopPrice)} <span className="text-xs text-subtle">({p.stopLossPct}%)</span>
            </Field>
            <Field label="Trailing stop">{p.trailingEnabled ? p.trailingStop !== null && p.status === 'open' ? `${formatPrice(p.trailingStop)} (${p.trailingPct}%)` : `${p.trailingPct}% — inactive` : 'Off'}</Field>
            <Field label="Unrealized P&L">
              <SignedPnl value={unrealizedOf(p)} />
            </Field>
            <Field label="Realized gross (partial closes)">
              <SignedPnl value={p.realizedPnl} />
            </Field>
            <Field label="Fees recorded">{p.kind === 'migrated' ? 'Not recorded (migrated)' : formatUsdt(p.fees)}</Field>
            <Field label="Net realized">{p.kind === 'migrated' ? 'Gross only' : <SignedPnl value={p.realizedPnl - p.fees} />}</Field>
            <Field label="Liquidation price" wide>
              Unavailable in demo
              <span className="mt-0.5 block text-xs text-subtle">Requires exchange margin and maintenance data. Cross margin also depends on account equity and other positions.</span>
            </Field>
          </dl>

          <div>
            <p className="text-xs font-medium text-subtle">Take-profit targets</p>
            <ul className="mt-1.5 divide-y divide-line rounded-lg border border-line text-sm tabular-nums">
              {p.targets.map((t, i) =>
            <li key={i} className="flex items-center justify-between gap-3 px-3 py-2">
                  <span className="text-ink">
                    TP{i + 1} · {formatPrice(t.price)} <span className="text-xs text-subtle">(+{t.movePct}% move · close {t.closePct}% of original)</span>
                  </span>
                  <StatusPill tone={t.state === 'filled' ? 'gain' : t.state === 'cancelled' ? 'neutral' : 'accent'}>{t.state === 'filled' ? 'Filled' : t.state === 'cancelled' ? 'Cancelled' : 'Waiting'}</StatusPill>
                </li>
            )}
            </ul>
          </div>

          <PositionPriceChart position={p} history={platform.priceHistory[p.symbol] ?? []} current={price} />

          {p.exits.length > 0 &&
        <div>
              <p className="text-xs font-medium text-subtle">Exits</p>
              <ul className="mt-1.5 space-y-1 text-sm tabular-nums">
                {p.exits.map((e) =>
            <li key={e.id} className="flex flex-wrap justify-between gap-2">
                    <span className="text-muted">
                      {formatClock(e.at)} · {e.reason} · {formatQty(e.qty)} @ {formatPrice(e.price)}
                    </span>
                    <SignedPnl value={e.pnl} />
                  </li>
            )}
              </ul>
            </div>
        }

          <p className="text-xs text-subtle">
            {p.kind === 'migrated' ? `${GROSS_NOTE} Migrated holding — not linked to an account.` : fillModelNote(state.simFeeRatePct)} {MODEL_NOTE} Settings shown were captured when this entry opened.
          </p>
        </div>
      }
    </SidePanel>);

}