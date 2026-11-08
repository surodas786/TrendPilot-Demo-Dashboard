import React from 'react';
import { UserRoundIcon } from 'lucide-react';
import { useDemo } from '../../contexts/DemoContext';
import { cn } from '../../utils/cn';

/**
 * The signed-in investor's single private context. No account picker: only a Paper /
 * Live — simulated switch when the investor has both, so their records stay separate.
 */
export function MyAccountSwitch({ className }: {className?: string;}) {
  const { accounts, account, setAccount } = useDemo();
  const paper = accounts.find((a) => a.environment === 'paper');
  const live = accounts.find((a) => a.environment === 'live');
  const current = accounts.length > 0 ? account.environment : null;

  return (
    <div className={cn('inline-flex h-9 items-center gap-2 rounded-lg border border-line bg-inset pl-3 pr-1 text-sm', className)}>
      <UserRoundIcon className="h-4 w-4 text-subtle" aria-hidden />
      <span className="whitespace-nowrap font-medium text-ink">My Account</span>
      {paper && live ?
      <div role="group" aria-label="Trading mode" className="flex rounded-md bg-surface p-0.5">
          {[
        { a: paper, label: 'Paper' },
        { a: live, label: 'Live — sim.' }].
        map(({ a, label }) =>
        <button
          key={a.id}
          type="button"
          aria-pressed={current === a.environment}
          onClick={() => setAccount(a.id)}
          className={cn(
            'h-7 whitespace-nowrap rounded px-2 text-xs font-medium transition-colors duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/60',
            current === a.environment ? 'bg-accent/15 text-ink' : 'text-muted hover:text-ink'
          )}>
          
              {label}
            </button>
        )}
        </div> :

      <span className="pr-2 text-xs text-muted">{current === 'live' ? 'Live — simulated' : current === 'paper' ? 'Paper' : 'No balance yet'}</span>
      }
    </div>);

}