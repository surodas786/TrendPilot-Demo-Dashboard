import React from 'react';
import { useLocation } from 'react-router-dom';
import { MenuIcon } from 'lucide-react';
import { pageTitle } from '../../data/navigation';
import { useDemo } from '../../contexts/DemoContext';
import { AccountSelect } from './AccountSelect';
import { MyAccountSwitch } from './MyAccountSwitch';
import { ExchangeSelect } from './ExchangeSelect';
import { NotificationMenu } from './NotificationMenu';
import { PaperBadge } from './PaperBadge';
import { ProfileMenu } from './ProfileMenu';

export function TopBar({ onOpenMenu }: {onOpenMenu: () => void;}) {
  const { pathname } = useLocation();
  const title = pageTitle(pathname);
  const { state } = useDemo();
  const isAdmin = state.role === 'admin';

  return (
    <header className="sticky top-0 z-40 border-b border-line bg-surface">
      <div className="flex h-14 items-center gap-3 px-4 lg:px-6">
        <button
          type="button"
          onClick={onOpenMenu}
          aria-label="Open navigation"
          className="flex h-9 w-9 items-center justify-center rounded-lg border border-line bg-inset text-muted transition-colors duration-150 hover:text-ink lg:hidden">
          
          <MenuIcon className="h-4 w-4" aria-hidden />
        </button>
        <div className="flex min-w-0 items-center gap-3">
          <h1 className="truncate text-base font-semibold text-ink">{title}</h1>
          <span className="hidden whitespace-nowrap rounded-full border border-line bg-inset px-2.5 py-1 text-[11px] font-medium text-muted md:inline-flex">
            Demo only — no real exchange orders
          </span>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <div className="hidden lg:block">
            <ExchangeSelect />
          </div>
          <div className="hidden sm:block">{isAdmin ? <AccountSelect /> : <MyAccountSwitch />}</div>
          <PaperBadge className="hidden sm:inline-flex" />
          <NotificationMenu />
          <ProfileMenu />
        </div>
      </div>
      <div className="flex items-center gap-2 border-t border-line px-4 py-2 sm:hidden">
        <PaperBadge />
        <span className="truncate text-[11px] text-subtle">Demo only — no real exchange orders</span>
        <div className="ml-auto">
          {isAdmin ? <AccountSelect triggerClassName="h-8 px-2.5 text-xs" /> : <MyAccountSwitch className="h-8" />}
        </div>
      </div>
    </header>);

}