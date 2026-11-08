import React from 'react';
import { cn } from '../../utils/cn';

interface SegmentedControlProps<T extends string | number> {
  label: string;
  value: T;
  options: {value: T;label: string;disabled?: boolean;}[];
  onChange: (value: T) => void;
  hideLabel?: boolean;
  hint?: React.ReactNode;
  error?: string;
}

export function SegmentedControl<T extends string | number>({ label, value, options, onChange, hideLabel, hint, error }: SegmentedControlProps<T>) {
  return (
    <fieldset className="min-w-0">
      <legend className={cn('text-sm font-medium text-ink', hideLabel && 'sr-only')}>{label}</legend>
      <div role="radiogroup" aria-label={label} className={cn('inline-flex max-w-full flex-wrap rounded-lg border bg-inset p-0.5', !hideLabel && 'mt-2', error ? 'border-loss/60' : 'border-line')}>
        {options.map((o) =>
        <button
          key={String(o.value)}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          disabled={o.disabled}
          onClick={() => onChange(o.value)}
          className={cn(
            'min-w-[3rem] whitespace-nowrap rounded-md px-3 py-1.5 text-sm font-semibold tabular-nums transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 disabled:cursor-not-allowed disabled:opacity-40',
            value === o.value ? 'bg-accent/15 text-accent' : 'text-muted hover:text-ink'
          )}>
          
            {o.label}
          </button>
        )}
      </div>
      {error ? <p className="mt-1.5 text-xs text-loss">{error}</p> : hint && <p className="mt-1.5 text-xs text-subtle">{hint}</p>}
    </fieldset>);

}