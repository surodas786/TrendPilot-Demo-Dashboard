import React from 'react';
import { cn } from '../../utils/cn';

interface TabBarProps<T extends string> {
  label: string;
  tabs: {id: T;label: string;badge?: number;}[];
  value: T;
  onChange: (id: T) => void;
}

export function TabBar<T extends string>({ label, tabs, value, onChange }: TabBarProps<T>) {
  return (
    <div role="tablist" aria-label={label} className="scrollbar-thin -mx-1 flex gap-1 overflow-x-auto border-b border-line px-1">
      {tabs.map((t) =>
      <button
        key={t.id}
        type="button"
        role="tab"
        aria-selected={value === t.id}
        onClick={() => onChange(t.id)}
        className={cn(
          'relative -mb-px flex shrink-0 items-center gap-1.5 whitespace-nowrap border-b-2 px-3 py-2.5 text-sm font-medium transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60',
          value === t.id ? 'border-accent text-ink' : 'border-transparent text-muted hover:text-ink'
        )}>
        
          {t.label}
          {t.badge ? <span className="rounded-full bg-warn/15 px-1.5 text-[11px] font-semibold text-warn">{t.badge}</span> : null}
        </button>
      )}
    </div>);

}