import React from 'react';
import { formatSigned } from '../../utils/format';
import { cn } from '../../utils/cn';

interface PnlTextProps {
  value: number;
  suffix?: string;
  className?: string;
}

export function PnlText({ value, suffix, className }: PnlTextProps) {
  const rounded = Math.round(value * 100) / 100;
  const tone = rounded > 0 ? 'text-gain' : rounded < 0 ? 'text-loss' : 'text-muted';
  return (
    <span className={cn('font-semibold tabular-nums', tone, className)}>
      {formatSigned(value)}
      {suffix && <span className="ml-1 text-xs font-medium text-subtle">{suffix}</span>}
    </span>);

}