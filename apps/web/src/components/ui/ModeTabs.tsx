import Link from 'next/link';
import { cn } from '@/lib/cn';

export type ViewMode = 'PAPER' | 'LIVE';

/** Paper and Live results are always shown separately: ?mode=live selects Live, anything else Paper. */
export const viewModeOf = (v: string | undefined): ViewMode => (v?.toLowerCase() === 'live' ? 'LIVE' : 'PAPER');

/** Paper / Live switch for reporting pages. Keeps the other query parameters. */
export function ModeTabs({ mode, path, params = {} }: { mode: ViewMode; path: string; params?: Record<string, string | undefined> }) {
  const href = (m: ViewMode) => {
    const q = new URLSearchParams(Object.entries({ ...params, mode: m === 'LIVE' ? 'live' : undefined }).filter((e): e is [string, string] => !!e[1]));
    return `${path}${q.size ? `?${q}` : ''}`;
  };
  return (
    <nav className="inline-flex rounded-lg border border-line bg-inset p-0.5 text-sm" aria-label="Paper or Live" data-testid="mode-tabs">
      {(['PAPER', 'LIVE'] as const).map((m) => (
        <Link
          key={m}
          href={href(m)}
          aria-current={mode === m ? 'page' : undefined}
          className={cn('rounded-md px-3 py-1 font-semibold transition-colors', mode === m ? (m === 'LIVE' ? 'bg-warn/15 text-warn' : 'bg-accent/15 text-accent') : 'text-muted hover:text-ink')}
        >
          {m === 'LIVE' ? 'Live' : 'Paper'}
        </Link>
      ))}
    </nav>
  );
}
