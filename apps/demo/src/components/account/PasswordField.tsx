import React, { useState } from 'react';
import { EyeIcon, EyeOffIcon } from 'lucide-react';
import { TextField } from '../ui/TextField';

interface PasswordFieldProps {
  label: string;
  value: string;
  onChange: (v: string) => void;
  error?: string;
  hint?: string;
  autoComplete: 'new-password';
}

export function PasswordField({ label, value, onChange, error, hint, autoComplete }: PasswordFieldProps) {
  const [shown, setShown] = useState(false);
  return (
    <TextField
      label={label}
      type={shown ? 'text' : 'password'}
      value={value}
      onChange={onChange}
      error={error}
      hint={hint}
      autoComplete={autoComplete}
      trailing={
      <button
        type="button"
        onClick={() => setShown((s) => !s)}
        aria-label={shown ? `Hide ${label.toLowerCase()}` : `Show ${label.toLowerCase()}`}
        aria-pressed={shown}
        className="flex h-8 w-9 items-center justify-center rounded-md text-subtle transition-colors duration-150 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60">
        
          {shown ? <EyeOffIcon className="h-4 w-4" aria-hidden /> : <EyeIcon className="h-4 w-4" aria-hidden />}
        </button>
      } />);


}