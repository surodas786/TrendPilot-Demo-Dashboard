'use client';

import React, { useId } from 'react';
import { cn } from '@/lib/cn';

interface TextFieldProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'onChange' | 'value'> {
  label: string;
  value: string;
  onChange?: (value: string) => void;
  error?: string;
  hint?: React.ReactNode;
  trailing?: React.ReactNode;
}

export function TextField({ label, value, onChange, error, hint, trailing, className, readOnly, ...rest }: TextFieldProps) {
  const id = useId();
  const describedBy = error ? `${id}-error` : hint ? `${id}-hint` : undefined;
  return (
    <div className={cn('flex min-w-0 flex-col gap-1.5', className)}>
      <label htmlFor={id} className="text-sm font-medium text-ink">
        {label}
      </label>
      <div className="relative">
        <input
          id={id}
          value={value}
          readOnly={readOnly}
          onChange={(e) => onChange?.(e.target.value)}
          aria-invalid={Boolean(error)}
          aria-describedby={describedBy}
          className={cn(
            'h-10 w-full rounded-lg border bg-inset px-3 text-sm text-ink placeholder:text-subtle transition-colors duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/60',
            error ? 'border-loss/60' : 'border-line hover:border-line-strong',
            readOnly && 'cursor-default text-muted hover:border-line',
            trailing ? 'pr-12' : ''
          )}
          {...rest} />
        
        {trailing && <div className="absolute inset-y-0 right-1 flex items-center">{trailing}</div>}
      </div>
      {error ?
      <p id={`${id}-error`} className="text-xs text-loss">
          {error}
        </p> :

      hint &&
      <p id={`${id}-hint`} className="text-xs text-subtle">
            {hint}
          </p>

      }
    </div>);

}