'use client';

import React from 'react';
import { CalendarOffIcon, CircleDotIcon, PauseIcon, PencilIcon, PlayIcon } from 'lucide-react';
import { Decimal, tradingWindowSummary, weekdaysSummary, type OrderBlockDto } from '@trendpilot/domain';
import { Button } from '../ui/Button';
import { StatusPill } from '../ui/StatusPill';
import { DIRECTION_LABELS } from './draft';

interface Props {
  block: OrderBlockDto;
  pairLabel: string;
  strategyName: string;
  busy: boolean;
  onEdit: () => void;
  onToggle: () => void;
}

/** Adapted from the MagicPatterns TokenBlockRow. Status is always shown as text as well as colour (UI-06). */
export function OrderBlockRow({ block, pairLabel, strategyName, busy, onEdit, onToggle }: Props) {
  const active = block.status === 'ACTIVE';
  const noDays = block.weekdays.length === 0;
  return (
    <li data-testid={`order-block-${block.symbol}`} className="flex flex-col gap-3 px-4 py-3.5 lg:flex-row lg:items-center lg:gap-6">
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-center gap-2">
          <span className="font-semibold text-ink">{pairLabel}</span>
          {block.mode === 'LIVE' ? <StatusPill tone="warn">Live</StatusPill> : <StatusPill tone="accent">Paper</StatusPill>}
        </p>
        <p className="mt-0.5 truncate text-sm text-muted">
          {strategyName} · {DIRECTION_LABELS[block.direction]}
        </p>
        <p className="mt-0.5 text-xs text-subtle" data-testid="trading-days">
          Trading days: <span className={noDays ? 'text-warn' : 'text-muted'}>{weekdaysSummary(block.weekdays)}</span> · Window: <span className="text-muted" data-testid="trading-window-label">{tradingWindowSummary(block.tradingWindow)}</span> · {block.timezone}
        </p>
      </div>
      <dl className="grid grid-cols-3 gap-4 text-sm tabular-nums lg:w-[340px]">
        <div>
          <dt className="text-xs text-subtle">Order cost</dt>
          <dd className="text-ink" data-testid="order-cost">
            {new Decimal(block.orderCostUsdt).toFixed(2)} USDT
          </dd>
        </div>
        <div>
          <dt className="text-xs text-subtle">Leverage</dt>
          <dd className="text-ink">{block.leverage}×</dd>
        </div>
        <div>
          <dt className="text-xs text-subtle">Stop loss</dt>
          <dd className="text-ink">{block.stop.value}%</dd>
        </div>
      </dl>
      <div className="lg:w-[200px]">
        {active ? (
          <StatusPill tone="gain" icon={CircleDotIcon}>
            Active — waiting for signal
          </StatusPill>
        ) : (
          <StatusPill tone="neutral" icon={PauseIcon}>
            Paused
          </StatusPill>
        )}
        {block.trailingConversionRequired && (
          <p className="mt-1 text-xs font-semibold text-warn" data-testid="trailing-needs-update">
            Needs update: entries on hold until Trailing take profit has an activation value
          </p>
        )}
        {active && noDays && (
          <p className="mt-1 flex items-center gap-1 text-xs text-warn">
            <CalendarOffIcon className="h-3 w-3" aria-hidden /> No entry days selected
          </p>
        )}
      </div>
      <div className="flex gap-2">
        <Button size="sm" icon={PencilIcon} onClick={onEdit} aria-label={`Edit ${pairLabel} ${block.mode === 'LIVE' ? 'Live' : 'Paper'}`}>
          Edit
        </Button>
        <Button size="sm" variant="ghost" icon={active ? PauseIcon : PlayIcon} onClick={onToggle} loading={busy} aria-label={`${active ? 'Pause' : 'Resume'} ${pairLabel} ${block.mode === 'LIVE' ? 'Live' : 'Paper'}`}>
          {active ? 'Pause' : 'Resume'}
        </Button>
      </div>
    </li>
  );
}
