import React from 'react';
import { Link } from 'react-router-dom';
import { PauseIcon, PlayIcon } from 'lucide-react';
import { toast } from 'sonner';
import { useDemo } from '../../contexts/DemoContext';
import { cn } from '../../utils/cn';

export function AutomationStatus() {
  const { isPaused, togglePause, account, accountEntryReasons } = useDemo();
  const reasons = accountEntryReasons(account.id);
  const riskReasons = reasons.filter((r) => r.id.startsWith('risk-'));
  const connectionReasons = reasons.filter((r) => !r.id.startsWith('risk-'));
  const accountBlocked = reasons.length > 0;
  const halted = isPaused || accountBlocked;

  const handleToggle = () => {
    togglePause();
    toast(isPaused ? 'New entries resumed' : 'New entries paused', {
      description: isPaused ?
      accountBlocked ?
      `Workspace pause lifted. ${account.name} remains blocked at account level.` :
      `${account.name} will act on new paper signals again.` :
      'Existing positions remain monitored and protected in this simulation.'
    });
  };

  const title = isPaused ?
  'New entries paused' :
  connectionReasons.length > 0 ?
  `New entries paused for ${account.name}` :
  riskReasons.length > 0 ?
  `New entries blocked by risk limits for ${account.name}` :
  'Paper automation running';

  return (
    <div
      className={cn(
        'flex flex-col gap-3 rounded-xl border bg-surface px-4 py-3 sm:flex-row sm:items-center sm:justify-between',
        halted ? 'border-warn/40' : 'border-line'
      )}
      role="status"
      aria-live="polite">
      
      <div className="flex items-start gap-3">
        <span className={cn('mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full', halted ? 'bg-warn' : 'bg-gain')} aria-hidden />
        <div className="min-w-0">
          <p className="text-sm font-semibold text-ink">{title}</p>
          <p className="mt-0.5 text-sm text-muted">
            {halted ?
            'Existing positions remain monitored and protected in this simulation.' :
            `New signals for ${account.name} become simulated paper orders. Live trading is unavailable in this prototype.`}
          </p>
          {accountBlocked &&
          <ul className="mt-1.5 space-y-0.5 text-xs text-subtle">
              {reasons.map((r) =>
            <li key={r.id}>· {r.text}</li>
            )}
            </ul>
          }
          {accountBlocked &&
          <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-xs font-medium">
              {connectionReasons.length > 0 &&
            <Link to={`/exchange-connections?details=${account.id}&tab=overview`} className="text-accent hover:underline">
                  Manage connection
                </Link>
            }
              {riskReasons.length > 0 &&
            <Link to="/trading-risk" className="text-accent hover:underline">
                  Review risk settings
                </Link>
            }
            </div>
          }
        </div>
      </div>
      <button
        type="button"
        onClick={handleToggle}
        className={cn(
          'flex h-9 shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-lg px-4 text-sm font-semibold transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2',
          isPaused ?
          'bg-accent text-accent-ink hover:bg-accent/90 focus-visible:ring-accent/60' :
          'border border-warn/45 bg-warn/10 text-warn hover:bg-warn/20 focus-visible:ring-warn/60'
        )}>
        
        {isPaused ? <PlayIcon className="h-4 w-4" aria-hidden /> : <PauseIcon className="h-4 w-4" aria-hidden />}
        {isPaused ? 'Resume new entries' : 'Pause new entries'}
      </button>
    </div>);

}