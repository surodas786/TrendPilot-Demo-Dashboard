import React from 'react';
import { ArrowDownRightIcon, ArrowUpRightIcon } from 'lucide-react';
import type { Direction } from '../../types/trading';
import { cn } from '../../utils/cn';

export function DirectionBadge({ direction, className }: {direction: Direction;className?: string;}) {
  const isLong = direction === 'long';
  const Icon = isLong ? ArrowUpRightIcon : ArrowDownRightIcon;
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold',
        isLong ? 'bg-gain/15 text-gain' : 'bg-loss/15 text-loss',
        className
      )}>
      
      <Icon className="h-3 w-3" aria-hidden />
      {isLong ? 'Long' : 'Short'}
    </span>);

}