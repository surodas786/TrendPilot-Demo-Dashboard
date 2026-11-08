import React from 'react';
import { cn } from '../../utils/cn';

interface RadioCardProps {
  name: string;
  value: string;
  checked: boolean;
  onChange?: (value: string) => void;
  label: string;
  description?: string;
  tag?: string;
  disabled?: boolean;
}

export function RadioCard({ name, value, checked, onChange, label, description, tag, disabled }: RadioCardProps) {
  return (
    <label
      className={cn(
        'flex items-start gap-3 rounded-lg border px-3 py-2.5 transition-colors duration-150',
        disabled ? 'cursor-not-allowed border-line opacity-60' : 'cursor-pointer',
        !disabled && (checked ? 'border-accent/50 bg-accent/10' : 'border-line bg-inset hover:border-line-strong')
      )}>
      
      <input
        type="radio"
        name={name}
        value={value}
        checked={checked}
        disabled={disabled}
        onChange={() => onChange?.(value)}
        className="mt-0.5 h-4 w-4 shrink-0 accent-[#2DD4BF]" />
      
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-sm font-medium text-ink">{label}</span>
          {tag && <span className="rounded-full border border-line px-2 py-0.5 text-[11px] text-subtle">{tag}</span>}
        </span>
        {description && <span className="mt-0.5 block text-xs text-subtle">{description}</span>}
      </span>
    </label>);

}