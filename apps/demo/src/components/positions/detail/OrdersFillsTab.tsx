import React from 'react';
import { formatDateTime } from '../../../utils/clock';
import { formatMaybe, formatNumber, formatUsdt } from '../../../utils/format';
import { PURPOSE_LABELS, remainingQty } from '../../../utils/orders';
import { OrderStatePill } from '../OrderStatePill';
import type { OrderRecord } from '../../../types/execution';

export function OrdersFillsTab({ orders }: {orders: OrderRecord[];}) {
  if (orders.length === 0) {
    return <p className="rounded-lg border border-dashed border-line-strong px-4 py-8 text-center text-sm text-muted">No order records linked to this position. Not recorded in this demo.</p>;
  }
  const sorted = [...orders].sort((a, b) => a.createdAt - b.createdAt);
  return (
    <ol className="space-y-3">
      {sorted.map((o) =>
      <li key={o.id} className="rounded-lg border border-line p-3">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <p className="text-sm font-semibold text-ink">
                {PURPOSE_LABELS[o.purpose]} <span className={o.side === 'Buy' ? 'text-gain' : 'text-loss'}>{o.side}</span>
              </p>
              <p className="text-xs text-subtle">
                {o.id} · {o.type}
                {o.reduceOnly ? ' · reduce-only' : ''}
              </p>
            </div>
            <OrderStatePill order={o} />
          </div>
          <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs sm:grid-cols-4">
            {[
          ['Requested', formatNumber(o.requestedQty, o.quantityDecimals)],
          ['Filled', formatNumber(o.filledQty, o.quantityDecimals)],
          ['Remaining', formatNumber(remainingQty(o), o.quantityDecimals)],
          [o.triggerState ? 'Trigger price' : 'Price', formatMaybe(o.price, o.priceDecimals)],
          ['Trigger basis', o.triggerBasis ?? '—'],
          ['Created', o.seeded ? `${formatDateTime(o.createdAt)} · details not itemized` : formatDateTime(o.createdAt)],
          ['Updated', formatDateTime(o.updatedAt)]].
          map(([k, v]) =>
          <div key={k} className="min-w-0">
                <dt className="text-subtle">{k}</dt>
                <dd className="tabular-nums text-ink">{v}</dd>
              </div>
          )}
          </dl>
          {o.note && <p className="mt-2 text-xs text-muted">{o.note}</p>}
          {o.fills.length > 0 &&
        <ul className="mt-2 divide-y divide-line rounded-md border border-line bg-inset text-xs">
              {o.fills.map((f) =>
          <li key={f.id} className="flex flex-wrap justify-between gap-2 px-2.5 py-1.5">
                  <span className="text-muted">
                    Fill {f.id} · {formatDateTime(f.at)}
                  </span>
                  <span className="tabular-nums text-ink">
                    {formatNumber(f.quantity, o.quantityDecimals)} {o.baseAsset} @ {formatNumber(f.price, o.priceDecimals)} · fee {f.fee === null ? 'not recorded' : formatUsdt(f.fee)}
                  </span>
                </li>
          )}
            </ul>
        }
        </li>
      )}
    </ol>);

}