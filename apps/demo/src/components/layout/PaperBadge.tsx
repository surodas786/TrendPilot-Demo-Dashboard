import React from 'react';
import { FlaskConicalIcon } from 'lucide-react';
import { useDemo } from '../../contexts/DemoContext';
import { cn } from '../../utils/cn';

/** Mode of the selected account: Paper or Live — simulated. Both are simulated; no real orders. */
export function PaperBadge({ className }: {className?: string;}) {
  const { accounts, account } = useDemo();
  const live = accounts.length > 0 && account.environment === 'live';
  return (
    <span
      className={cn(
        'inline-flex h-7 items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 text-xs font-semibold',
        live ? 'border-warn/40 bg-warn/10 text-warn' : 'border-accent/40 bg-accent/10 text-accent',
        className
      )}
      title="Demo only — no real exchange orders">
      
      <FlaskConicalIcon className="h-3.5 w-3.5" aria-hidden />
      {live ? 'Live — simulated' : 'Paper'}
    </span>);

}