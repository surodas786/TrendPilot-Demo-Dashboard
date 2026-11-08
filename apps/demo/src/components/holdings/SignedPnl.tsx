import React from 'react';
import { cn } from '../../utils/cn';

/** Signed USDT amount. Sign is shown in text so meaning does not depend on color. */
export function SignedPnl({ value, className }: {value: number;className?: string;}) {
  const rounded = Math.round(value * 100) / 100;
  const tone = rounded > 0 ? 'text-gain' : rounded < 0 ? 'text-loss' : 'text-muted';
  const sign = rounded > 0 ? '+' : rounded < 0 ? '−' : '';
  return (
    <span className={cn('tabular-nums', tone, className)}>
      {sign}
      {Math.abs(rounded).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USDT
    </span>);

}

export function SideText({ side }: {side: 'long' | 'short';}) {
  return <span className={cn('font-medium', side === 'long' ? 'text-gain' : 'text-loss')}>{side === 'long' ? '▲ Long' : '▼ Short'}</span>;
}