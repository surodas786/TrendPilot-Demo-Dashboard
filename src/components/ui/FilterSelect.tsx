import React, { useId } from 'react';
import { ChevronDownIcon } from 'lucide-react';

interface FilterSelectProps {
  label: string;
  value: string;
  options: {value: string;label: string;disabled?: boolean;}[];
  onChange: (value: string) => void;
  disabled?: boolean;
}

export function FilterSelect({ label, value, options, onChange, disabled }: FilterSelectProps) {
  const id = useId();
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <label htmlFor={id} className="text-xs font-medium text-subtle">
        {label}
      </label>
      <div className="relative">
        <select
          id={id}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
          className="h-9 w-full appearance-none disabled:cursor-not-allowed disabled:opacity-60 rounded-lg border border-line bg-inset pl-3 pr-9 text-sm text-ink transition-colors duration-150 hover:border-line-strong focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/60">
          
          {options.map((o) =>
          <option key={o.value} value={o.value} disabled={o.disabled}>
              {o.label}
            </option>
          )}
        </select>
        <ChevronDownIcon className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-subtle" aria-hidden />
      </div>
    </div>);

}