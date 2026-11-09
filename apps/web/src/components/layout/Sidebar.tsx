'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ChevronDownIcon, LockIcon } from 'lucide-react';
import { cn } from '@/lib/cn';
import { navFor, type NavItem, type ShellRole } from './navigation';

const linkClass = (active: boolean) =>
  cn(
    'flex items-center gap-3 rounded-lg border px-2.5 py-2 text-sm transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60',
    active ? 'border-accent/30 bg-accent/10 font-semibold text-accent' : 'border-transparent text-muted hover:bg-inset hover:text-ink'
  );

/** A menu group (e.g. Settings) with its submenu; open while one of its pages is shown. */
function NavGroup({ item, pathname }: { item: NavItem; pathname: string }) {
  const inGroup = pathname === item.path || pathname.startsWith(`${item.path}/`);
  const [open, setOpen] = useState(inGroup);
  const Icon = item.icon;
  const id = `nav-group-${item.path.replace(/W+/g, '-')}`;
  return (
    <li>
      <button type="button" aria-expanded={open || inGroup} aria-controls={id} onClick={() => setOpen((o) => !o)} className={cn(linkClass(false), 'w-full', inGroup && 'text-ink')}>
        <Icon className="h-4 w-4 shrink-0" aria-hidden />
        <span className="truncate">{item.label}</span>
        <ChevronDownIcon className={cn('ml-auto h-4 w-4 shrink-0 transition-transform duration-150', (open || inGroup) && 'rotate-180')} aria-hidden />
      </button>
      {(open || inGroup) && (
        <ul id={id} className="mt-0.5 space-y-0.5 pl-4">
          {item.children!.map((c) => {
            const ChildIcon = c.icon;
            const active = pathname === c.path;
            return (
              <li key={c.path}>
                <Link href={c.path} aria-current={active ? 'page' : undefined} className={linkClass(active)}>
                  <ChildIcon className="h-4 w-4 shrink-0" aria-hidden />
                  <span className="truncate">{c.label}</span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </li>
  );
}

export function Sidebar({ role, name }: { role: ShellRole; name: string }) {
  const pathname = usePathname();
  const items = navFor(role);

  return (
    <div className="flex h-full w-full flex-col px-3 py-4">
      <div className="flex items-center gap-2.5 px-2">
        <img src="/TrendPilot_Logo-removebg-preview.png" alt="" aria-hidden className="h-8 w-8 shrink-0 object-contain" />
        <span className="text-[17px] font-bold tracking-tight text-ink">TrendPilot</span>
      </div>

      <nav aria-label="Main" className="scrollbar-thin mt-6 flex-1 overflow-y-auto">
        <ul className="space-y-0.5">
          {items.map((item) => {
            const Icon = item.icon;
            if (item.children?.length) return <NavGroup key={item.path} item={item} pathname={pathname} />;
            if (item.pending) {
              return (
                <li key={item.path}>
                  <span
                    aria-disabled="true"
                    className="flex items-center gap-3 rounded-lg border border-transparent px-2.5 py-2 text-sm text-subtle/70"
                    title="Not built yet in this slice"
                  >
                    <Icon className="h-4 w-4 shrink-0" aria-hidden />
                    <span className="truncate">{item.label}</span>
                    <span className="ml-auto text-[10px] uppercase tracking-wide">Soon</span>
                  </span>
                </li>
              );
            }
            const active = pathname === item.path;
            return (
              <li key={item.path}>
                <Link
                  href={item.path}
                  aria-current={active ? 'page' : undefined}
                  className={linkClass(active)}
                >
                  <Icon className="h-4 w-4 shrink-0" aria-hidden />
                  <span className="truncate">{item.label}</span>
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>

      <div className="mt-4 space-y-3 border-t border-line px-2 pt-4">
        <div className="flex items-start gap-2">
          <LockIcon className="mt-0.5 h-4 w-4 shrink-0 text-subtle" aria-hidden />
          <div>
            <p className="text-xs font-semibold text-muted">Live trading</p>
            <p className="text-xs text-subtle">Disabled in this build. Paper settings only.</p>
          </div>
        </div>
        <p className="text-xs text-subtle">
          Signed in as <span className="font-semibold text-accent">{role === 'ADMIN' ? 'Administrator' : 'Investor'}</span>
          <span className="block text-muted">{name}</span>
        </p>
      </div>
    </div>
  );
}
