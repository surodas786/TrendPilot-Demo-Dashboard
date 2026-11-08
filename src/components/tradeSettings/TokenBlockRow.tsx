import React from 'react';
import { BanIcon, CircleDotIcon, PauseIcon, PencilIcon, PlayIcon } from 'lucide-react';
import { formatUsdt, MODE_LABEL } from '../../utils/tokenBlocks';
import { daysSummary, DEFAULT_TIMEZONE } from '../../utils/tradingDays';
import { Button } from '../ui/Button';
import { StatusPill } from '../ui/StatusPill';
import type { BlockStatus, TokenBlock } from '../../types/tradeSettings';

interface Props {
  block: TokenBlock;
  pairLabel: string;
  packageName: string;
  status: BlockStatus;
  /** Investor's timezone used for the trading-day schedule. */
  timezone?: string;
  onEdit: () => void;
  onToggle: () => void;
}

function StatusBadge({ status }: {status: BlockStatus;}) {
  if (status.kind === 'active') return <StatusPill tone="gain" icon={CircleDotIcon}>Active — waiting for signal</StatusPill>;
  if (status.kind === 'paused') return <StatusPill tone="neutral" icon={PauseIcon}>Paused</StatusPill>;
  return <StatusPill tone="loss" icon={BanIcon}>Blocked</StatusPill>;
}

export function TokenBlockRow({ block, pairLabel, packageName, status, timezone = DEFAULT_TIMEZONE, onEdit, onToggle }: Props) {
  const reason = status.kind === 'blocked' ? status.reason : status.kind === 'paused' ? status.blockedReason : undefined;
  return (
    <li className="flex flex-col gap-3 px-4 py-3.5 lg:flex-row lg:items-center lg:gap-6">
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-center gap-2">
          <span className="font-semibold text-ink">{pairLabel}</span>
          <StatusPill tone={block.mode === 'live' ? 'warn' : 'accent'}>{MODE_LABEL[block.mode]}</StatusPill>
        </p>
        <p className="mt-0.5 truncate text-sm text-muted">{packageName}</p>
        <p className="mt-0.5 text-xs text-subtle">
          Trading days: <span className="text-muted">{daysSummary(block.tradingDays)}</span> · {timezone}
        </p>
      </div>
      <dl className="grid grid-cols-3 gap-4 text-sm tabular-nums lg:w-[320px]">
        <div>
          <dt className="text-xs text-subtle">Order cost</dt>
          <dd className="text-ink">{formatUsdt(block.orderCost)}</dd>
        </div>
        <div>
          <dt className="text-xs text-subtle">Leverage</dt>
          <dd className="text-ink">{block.leverage}×</dd>
        </div>
        <div>
          <dt className="text-xs text-subtle">Margin</dt>
          <dd className="text-ink">{block.marginMode === 'isolated' ? 'Isolated' : 'Cross'}</dd>
        </div>
      </dl>
      <div className="lg:w-[220px]">
        <StatusBadge status={status} />
        {reason && <p className="mt-1 text-xs text-subtle">{status.kind === 'paused' ? `Resume blocked: ${reason}` : reason}</p>}
      </div>
      <div className="flex gap-2">
        <Button size="sm" icon={PencilIcon} onClick={onEdit} aria-label={`Edit ${pairLabel} ${MODE_LABEL[block.mode]}`}>
          Edit
        </Button>
        <Button size="sm" variant="ghost" icon={block.active ? PauseIcon : PlayIcon} onClick={onToggle}>
          {block.active ? 'Pause' : 'Resume'}
        </Button>
      </div>
    </li>);

}