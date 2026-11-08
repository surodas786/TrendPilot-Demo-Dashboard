import React from 'react';
import { RadioIcon, SendIcon } from 'lucide-react';
import { formatClock, timeToSeconds } from '../../../utils/clock';
import { formatNumber } from '../../../utils/format';
import { PURPOSE_LABELS } from '../../../utils/orders';
import { cn } from '../../../utils/cn';
import { activityIcon } from '../../dashboard/ActivityStrip';
import { NOT_RECORDED } from './DetailSection';
import type { OrderRecord } from '../../../types/execution';
import type { ActivityEvent, Position, SignalRecord } from '../../../types/trading';

interface Props {
  position: Position;
  activity: ActivityEvent[];
  orders: OrderRecord[];
  signals: SignalRecord[];
}

interface Row {
  id: string;
  time: string;
  title: string;
  detail: string;
  icon: React.ComponentType<{className?: string;}>;
  tone: string;
}

/** Linked events in timestamp order. Missing history is labelled, never invented. */
export function TimelineTab({ position: p, activity, orders, signals }: Props) {
  const signal = signals.
  filter((s) => s.accountId === p.accountId && s.pair === p.pair && s.strategyId === p.strategyId && s.result === 'executed' && s.action.startsWith('Open') && timeToSeconds(s.receivedAt) <= timeToSeconds(p.openedAt)).
  sort((a, b) => b.receivedAt.localeCompare(a.receivedAt))[0];

  const rows: Row[] = [];
  if (signal) rows.push({ id: signal.id, time: signal.receivedAt, title: 'Signal received', detail: `${signal.action} · ${signal.timeframe} candle closed ${signal.candleCloseAt}`, icon: RadioIcon, tone: 'text-accent' });
  orders.
  filter((o) => !o.seeded).
  forEach((o) => rows.push({ id: `${o.id}-sub`, time: formatClock(o.createdAt), title: `${PURPOSE_LABELS[o.purpose]} order requested`, detail: `${o.id} · ${o.type} · ${formatNumber(o.requestedQty, o.quantityDecimals)} ${o.baseAsset}`, icon: SendIcon, tone: 'text-muted' }));
  activity.forEach((e) => rows.push({ id: e.id, time: e.time, title: e.title, detail: e.detail, icon: activityIcon[e.kind].icon, tone: activityIcon[e.kind].tone }));
  rows.sort((a, b) => timeToSeconds(a.time) - timeToSeconds(b.time));

  const seededEntry = orders.some((o) => o.purpose === 'entry' && o.seeded);

  return (
    <div className="space-y-3">
      <ol className="relative space-y-0 border-l border-line pl-4">
        {!signal && p.managed !== false && <Missing label="Signal receipt" />}
        {seededEntry && <Missing label="Entry submission and acknowledgement" />}
        {rows.map((r) => {
          const Icon = r.icon;
          return (
            <li key={r.id} className="relative pb-4">
              <span className="absolute -left-[25px] top-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-surface">
                <Icon className={cn('h-3.5 w-3.5', r.tone)} />
              </span>
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <p className="text-sm text-ink">{r.title}</p>
                <span className="text-xs tabular-nums text-subtle">{r.time}</span>
              </div>
              <p className="text-xs text-subtle">{r.detail}</p>
            </li>);

        })}
      </ol>
      <p className="text-xs text-subtle">Times in Asia/Dhaka on the simulated reporting day.</p>
    </div>);

}

function Missing({ label }: {label: string;}) {
  return (
    <li className="relative pb-4">
      <span className="absolute -left-[21px] top-1.5 h-2 w-2 rounded-full border border-line-strong bg-surface" aria-hidden />
      <p className="text-sm text-muted">{label}</p>
      <p className="text-xs text-subtle">{NOT_RECORDED}</p>
    </li>);

}