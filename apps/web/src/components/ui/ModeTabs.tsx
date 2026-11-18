import Link from 'next/link';
import { cn } from '@/lib/cn';

export type ViewMode = 'PAPER' | 'LIVE';

/** Paper and Live results are always shown separately: ?mode=live selects Live, anything else Paper. */
export const viewModeOf = (v: string | undefined): ViewMode => (v?.toLowerCase() === 'live' ? 'LIVE' : 'PAPER');

export type ViewExchange = 'MEXC' | 'BITUNIX' | 'LIGHTER';

/** Live is reported per exchange: ?exchange=bitunix selects the Bitunix account, anything else MEXC. */
export const viewExchangeOf = (v: string | undefined): ViewExchange => (v?.toLowerCase() === 'bitunix' ? 'BITUNIX' : 'MEXC');

/** Paper is reported per simulator account: ?exchange=lighter selects the Lighter (USDC) account, anything else MEXC (USDT). */
export const paperExchangeOf = (v: string | undefined): ViewExchange => (v?.toLowerCase() === 'lighter' ? 'LIGHTER' : 'MEXC');

/**
 * Exchange switch for reporting pages. Live: MEXC / Bitunix (shown when the investor has a Bitunix
 * account). Paper: MEXC (USDT) / Lighter (USDC) simulator accounts (shown when the investor has Lighter
 * Paper activity). Accounts in different currencies are never summed.
 */
export function ExchangeTabs({ exchange, path, params = {}, mode = 'LIVE' }: { exchange: ViewExchange; path: string; params?: Record<string, string | undefined>; mode?: ViewMode }) {
  const options: ViewExchange[] = mode === 'LIVE' ? ['MEXC', 'BITUNIX'] : ['MEXC', 'LIGHTER'];
  const href = (x: ViewExchange) => {
    const q = new URLSearchParams(Object.entries({ ...params, mode: mode === 'LIVE' ? 'live' : undefined, exchange: x === 'MEXC' ? undefined : x.toLowerCase() }).filter((e): e is [string, string] => !!e[1]));
    return `${path}${q.size ? `?${q}` : ''}`;
  };
  return (
    <nav className="inline-flex rounded-lg border border-line bg-inset p-0.5 text-sm" aria-label="Exchange" data-testid="exchange-tabs">
      {options.map((x) => (
        <Link key={x} href={href(x)} aria-current={exchange === x ? 'page' : undefined} className={cn('rounded-md px-3 py-1 font-semibold transition-colors', exchange === x ? (mode === 'LIVE' ? 'bg-warn/15 text-warn' : 'bg-accent/15 text-accent') : 'text-muted hover:text-ink')}>
          {x === 'BITUNIX' ? 'Bitunix' : x === 'LIGHTER' ? 'Lighter (USDC)' : mode === 'LIVE' ? 'MEXC' : 'MEXC (USDT)'}
        </Link>
      ))}
    </nav>
  );
}

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
