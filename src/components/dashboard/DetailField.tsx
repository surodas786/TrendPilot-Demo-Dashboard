import React from 'react';
import { InfoTooltip } from '../ui/InfoTooltip';
import { cn } from '../../utils/cn';

interface DetailFieldProps {
  label: string;
  children: React.ReactNode;
  hint?: string;
  tooltip?: string;
  muted?: boolean;
}

export function DetailField({ label, children, hint, tooltip, muted }: DetailFieldProps) {
  return (
    <div className="min-w-0">
      <dt className="flex items-center gap-1 text-xs text-subtle">
        {label}
        {tooltip && <InfoTooltip label={`About ${label.toLowerCase()}`} content={tooltip} />}
      </dt>
      <dd className={cn('mt-1 text-sm tabular-nums', muted ? 'text-muted' : 'font-semibold text-ink')}>{children}</dd>
      {hint && <p className="mt-0.5 text-xs text-subtle">{hint}</p>}
    </div>);

}