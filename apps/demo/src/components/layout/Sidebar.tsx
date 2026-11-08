import React from 'react';
import { NavLink } from 'react-router-dom';
import { LockIcon } from 'lucide-react';
import { navForRole } from '../../data/navigation';
import { useDemo } from '../../contexts/DemoContext';
import { ExchangeSelect } from './ExchangeSelect';
import { cn } from '../../utils/cn';

interface SidebarProps {
  showExchange?: boolean;
}

export function Sidebar({ showExchange = false }: SidebarProps) {
  const { state, currentUser } = useDemo();
  const items = navForRole(state.role);

  return (
    <div className="flex h-full w-full flex-col px-3 py-4">
      <div className="flex items-center gap-2.5 px-2">
        <img src="/TrendPilot_Logo-removebg-preview.png" alt="" aria-hidden className="h-8 w-8 shrink-0 object-contain" />
        <span className="text-[17px] font-bold tracking-tight text-ink">TrendPilot</span>
      </div>
      <p className="mx-2 mt-3 rounded-md border border-line bg-inset px-2 py-1.5 text-center text-[11px] font-medium text-muted">
        Demo only — no real exchange orders
      </p>

      {showExchange &&
      <div className="mx-2 mt-4">
          <p className="mb-1 text-xs font-medium text-subtle">Exchange</p>
          <ExchangeSelect align="left" />
        </div>
      }

      <nav aria-label="Main" className="scrollbar-thin mt-5 flex-1 overflow-y-auto">
        <ul className="space-y-0.5">
          {items.map((item) => {
            const Icon = item.icon;
            return (
              <li key={item.path}>
                <NavLink
                  to={item.path}
                  end={item.path === '/' || item.path === '/admin'}
                  className={({ isActive }) =>
                  cn(
                    'flex items-center gap-3 rounded-lg border px-2.5 py-2 text-sm transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60',
                    isActive ? 'border-accent/30 bg-accent/10 font-semibold text-accent' : 'border-transparent text-muted hover:bg-inset hover:text-ink'
                  )
                  }>
                  
                  <Icon className="h-4 w-4 shrink-0" aria-hidden />
                  <span className="truncate">{item.label}</span>
                </NavLink>
              </li>);

          })}
        </ul>
      </nav>

      <div className="mt-4 space-y-3 border-t border-line px-2 pt-4">
        <div className="flex items-start gap-2">
          <LockIcon className="mt-0.5 h-4 w-4 shrink-0 text-subtle" aria-hidden />
          <div>
            <p className="text-xs font-semibold text-muted">Live trading</p>
            <p className="text-xs text-subtle">Unavailable in this prototype</p>
          </div>
        </div>
        <p className="text-xs text-subtle">
          Demo role: <span className="font-semibold text-accent">{state.role === 'admin' ? 'Administrator' : 'Subscriber'}</span>
          <span className="block">{state.role === 'admin' ? 'Platform administrator' : currentUser.name}</span>
        </p>
      </div>
    </div>);

}