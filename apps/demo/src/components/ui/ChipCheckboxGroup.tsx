import React from 'react';
import { CheckIcon } from 'lucide-react';
import { cn } from '../../utils/cn';

interface ChipCheckboxGroupProps {
  label: React.ReactNode;
  description?: React.ReactNode;
  options: {value: string;label: string;disabled?: boolean;note?: string;}[];
  value: string[];
  onChange: (value: string[]) => void;
  error?: React.ReactNode;
}

export function ChipCheckboxGroup({ label, description, options, value, onChange, error }: ChipCheckboxGroupProps) {
  const toggle = (v: string) => {
    const next = value.includes(v) ? value.filter((x) => x !== v) : [...value, v];
    onChange(options.map((o) => o.value).filter((o) => next.includes(o)));
  };
  return (
    <fieldset className="min-w-0">
      <legend className="text-sm font-medium text-ink">{label}</legend>
      {description && <p className="mt-0.5 text-xs text-subtle">{description}</p>}
      <div className="mt-2 flex flex-wrap gap-2">
        {options.map((o) => {
          const on = value.includes(o.value);
          return (
            <button
              key={o.value}
              type="button"
              role="checkbox"
              aria-checked={on}
              disabled={o.disabled}
              title={o.note}
              onClick={() => toggle(o.value)}
              className={cn(
                'inline-flex h-9 items-center gap-2 rounded-lg border px-3 text-sm font-medium transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 disabled:cursor-not-allowed disabled:opacity-45',
                on ? 'border-accent/50 bg-accent/10 text-accent' : 'border-line bg-inset text-muted hover:border-line-strong'
              )}>
              
              <span className={cn('flex h-4 w-4 items-center justify-center rounded border', on ? 'border-accent bg-accent text-accent-ink' : 'border-line-strong')}>
                {on && <CheckIcon className="h-3 w-3" aria-hidden />}
              </span>
              {o.label}
              {o.note && <span className="text-xs font-normal text-subtle">· {o.note}</span>}
            </button>);

        })}
      </div>
      {error && <div className="mt-1.5 text-xs text-loss">{error}</div>}
    </fieldset>);

}