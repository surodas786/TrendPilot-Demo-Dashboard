'use client';

import React, { Suspense, useState } from 'react';
import { usePathname, useSearchParams } from 'next/navigation';
import { FlaskConicalIcon, LogOutIcon, MenuIcon, ShieldIcon, UserRoundIcon, ZapIcon } from 'lucide-react';
import { exchangeLabel } from '@trendpilot/domain';
import { paperExchangeOf, viewExchangeOf, viewModeOf } from '@/components/ui/ModeTabs';
import { pageTitle, type ShellRole } from './navigation';

/**
 * UI-02 / PRD §2.2: My Account is the fixed signed-in scope. There is deliberately
 * no account selector, "All my accounts" option or Trading Account field here.
 */
function ScopeBadge({ role, name }: { role: ShellRole; name: string }) {
  const Icon = role === 'ADMIN' ? ShieldIcon : UserRoundIcon;
  return (
    <span data-testid="account-scope" className="inline-flex h-9 max-w-[60vw] items-center gap-2 rounded-lg border border-line bg-inset px-3 text-sm">
      <Icon className="h-4 w-4 shrink-0 text-subtle" aria-hidden />
      <span className="truncate font-medium text-ink">{role === 'ADMIN' ? `Administrator · ${name}` : `My Account · ${name}`}</span>
    </span>
  );
}

/** Reporting pages with a Paper / Live switch (?mode=live&exchange=…): the badge follows that view. */
const MODE_VIEW_PAGES = ['/dashboard', '/my-holdings', '/my-trades'];

/**
 * The mode of the view on screen, read from the same URL parameters the page itself uses (one
 * source of truth): "Live · Bitunix" on My Trades → Bitunix → Live, "Paper" on a Paper view. Pages
 * without a Paper/Live view (Live Trading, Trade Settings, a single trade…) show no global mode:
 * each order block and position carries its own stored mode there.
 */
function ViewModeBadge() {
  const pathname = usePathname();
  const params = useSearchParams();
  if (!MODE_VIEW_PAGES.includes(pathname)) return null;
  const mode = viewModeOf(params.get('mode') ?? undefined);
  if (mode === 'LIVE') {
    const exchange = viewExchangeOf(params.get('exchange') ?? undefined);
    return (
      <span data-testid="view-mode-badge" data-mode="LIVE" data-exchange={exchange} className="inline-flex h-7 items-center gap-1.5 whitespace-nowrap rounded-full border border-warn/40 bg-warn/10 px-2.5 text-xs font-semibold text-warn">
        <ZapIcon className="h-3.5 w-3.5" aria-hidden />
        Live · {exchangeLabel(exchange)}
      </span>
    );
  }
  const exchange = paperExchangeOf(params.get('exchange') ?? undefined);
  return (
    <span data-testid="view-mode-badge" data-mode="PAPER" data-exchange={exchange} className="inline-flex h-7 items-center gap-1.5 whitespace-nowrap rounded-full border border-accent/40 bg-accent/10 px-2.5 text-xs font-semibold text-accent">
      <FlaskConicalIcon className="h-3.5 w-3.5" aria-hidden />
      Paper{exchange === 'LIGHTER' ? ' · Lighter' : ''}
    </span>
  );
}

function PaperBadge() {
  return (
    <Suspense fallback={null}>
      <ViewModeBadge />
    </Suspense>
  );
}

export function TopBar({ role, name, onOpenMenu }: { role: ShellRole; name: string; onOpenMenu: () => void }) {
  const pathname = usePathname();
  const [signingOut, setSigningOut] = useState(false);

  const signOut = async () => {
    setSigningOut(true);
    await fetch('/v1/auth/logout', { method: 'POST' }).catch(() => undefined);
    window.location.assign('/sign-in');
  };

  return (
    <header className="sticky top-0 z-40 border-b border-line bg-surface">
      <div className="flex h-14 items-center gap-3 px-4 lg:px-6">
        <button
          type="button"
          onClick={onOpenMenu}
          aria-label="Open navigation"
          className="flex h-9 w-9 items-center justify-center rounded-lg border border-line bg-inset text-muted transition-colors duration-150 hover:text-ink lg:hidden"
        >
          <MenuIcon className="h-4 w-4" aria-hidden />
        </button>
        <h1 className="truncate text-base font-semibold text-ink">{pageTitle(pathname, role)}</h1>
        <div className="ml-auto flex items-center gap-2">
          <div className="hidden sm:block">
            <ScopeBadge role={role} name={name} />
          </div>
          {role === 'INVESTOR' && (
            <div className="hidden sm:block">
              <PaperBadge />
            </div>
          )}
          <button
            type="button"
            onClick={signOut}
            disabled={signingOut}
            className="inline-flex h-9 items-center gap-2 rounded-lg border border-line bg-inset px-3 text-sm text-muted transition-colors duration-150 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 disabled:opacity-50"
          >
            <LogOutIcon className="h-4 w-4" aria-hidden />
            <span className="hidden sm:inline">Sign out</span>
            <span className="sr-only sm:hidden">Sign out</span>
          </button>
        </div>
      </div>
      <div className="flex items-center gap-2 border-t border-line px-4 py-2 sm:hidden">
        <ScopeBadge role={role} name={name} />
        {role === 'INVESTOR' && <PaperBadge />}
      </div>
    </header>
  );
}
