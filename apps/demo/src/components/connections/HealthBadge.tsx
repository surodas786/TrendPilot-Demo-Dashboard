import React from 'react';
import { CheckCircle2Icon, MinusCircleIcon, XCircleIcon } from 'lucide-react';
import { cn } from '../../utils/cn';
import type { HealthDimension } from '../../types/trading';

interface HealthBadgeProps {
  dimension: HealthDimension;
  okLabel?: string;
  failedLabel?: string;
  offLabel?: string;
  className?: string;
}

export function HealthBadge({
  dimension,
  okLabel = 'Connected',
  failedLabel = 'Unavailable',
  offLabel = 'Disconnected',
  className
}: HealthBadgeProps) {
  const Icon = dimension === 'ok' ? CheckCircle2Icon : dimension === 'failed' ? XCircleIcon : MinusCircleIcon;
  const label = dimension === 'ok' ? okLabel : dimension === 'failed' ? failedLabel : offLabel;
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 whitespace-nowrap text-xs font-medium',
        dimension === 'ok' ? 'text-gain' : dimension === 'failed' ? 'text-loss' : 'text-subtle',
        className
      )}>
      
      <Icon className="h-3.5 w-3.5" aria-hidden />
      {label}
    </span>);

}