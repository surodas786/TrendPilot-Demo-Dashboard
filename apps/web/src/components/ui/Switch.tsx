'use client';

import React, { useId } from 'react';
import { cn } from '@/lib/cn';

interface SwitchProps {
  label: string;
  description?: React.ReactNode;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}

export function Switch({ label, description, checked, onChange, disabled }: SwitchProps) {
  const id = useId();
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0">
        <label htmlFor={id} className="text-sm font-medium text-ink">
          {label}
        </label>
        {description && <p className="mt-0.5 text-xs text-subtle">{description}</p>}
      </div>
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cn(
          'relative h-6 w-11 shrink-0 rounded-full border transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 disabled:cursor-not-allowed disabled:opacity-50',
          checked ? 'border-accent bg-accent/80' : 'border-line-strong bg-inset'
        )}>
        
        <span
          className={cn(
            'absolute top-0.5 h-4 w-4 rounded-full bg-ink transition-transform duration-150',
            checked ? 'translate-x-[22px]' : 'translate-x-0.5'
          )}
          aria-hidden />
        
        <span className="sr-only">{checked ? 'On' : 'Off'}</span>
      </button>
    </div>);

}