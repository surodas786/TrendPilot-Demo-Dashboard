'use client';

import React from 'react';
import { TextField } from './TextField';

type Props = Omit<React.ComponentProps<typeof TextField>, 'onChange' | 'onBlur' | 'inputMode'> & {
  onChange: (value: string) => void;
  /** Called after blur normalisation, so the form can show this field's validation inline. */
  onCommit?: () => void;
};

/**
 * Tidies a finished number on blur without changing its value: "1." → "1", ".5" → "0.5",
 * "05" → "5". Anything else (including empty) is left exactly as typed for validation to report.
 */
export function normaliseDecimalInput(raw: string): string {
  const v = raw.trim();
  const m = /^(\d*)(?:\.(\d*))?$/.exec(v);
  if (!m || v === '' || v === '.') return v;
  const int = (m[1] ?? '').replace(/^0+(?=\d)/, '') || '0';
  const frac = m[2] ?? '';
  return frac ? `${int}.${frac}` : int;
}

/**
 * Text input for a decimal setting. While typing it keeps whatever is entered — empty and
 * partial values such as "" or "12." are allowed — and never parses. The value is parsed by the
 * shared validator on blur (inline message) and on Save. 0 is a value; empty means "not entered".
 */
export function DecimalField({ value, onChange, onCommit, ...rest }: Props) {
  return (
    <TextField
      {...rest}
      inputMode="decimal"
      autoComplete="off"
      value={value}
      onChange={onChange}
      onBlur={() => {
        const tidy = normaliseDecimalInput(value);
        if (tidy !== value) onChange(tidy);
        onCommit?.();
      }}
    />
  );
}
