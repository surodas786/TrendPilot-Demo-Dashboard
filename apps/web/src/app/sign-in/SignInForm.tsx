'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import { EyeIcon, EyeOffIcon, ShieldCheckIcon } from 'lucide-react';
import { request } from '@/lib/api';
import { Button } from '@/components/ui/Button';
import { TextField } from '@/components/ui/TextField';

type LoginResponse = { mfaRequired: boolean; user?: { role: 'ADMIN' | 'INVESTOR' } };

const home = (role?: string) => (role === 'ADMIN' ? '/admin' : '/trade-settings');

/** IAM-01 sign-in: password, then a TOTP code when two-step sign-in is on. */
export function SignInForm() {
  const [step, setStep] = useState<'password' | 'mfa'>('password');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [shown, setShown] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submitPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const r = await request<LoginResponse>('POST', '/v1/auth/login', { body: { email, password }, redirectOn401: false });
    setBusy(false);
    if (!r.ok) return setError(r.message);
    if (r.data.mfaRequired) {
      setStep('mfa');
      setPassword('');
      return;
    }
    window.location.assign(home(r.data.user?.role));
  };

  const submitCode = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const r = await request<LoginResponse>('POST', '/v1/auth/mfa', { body: { code: code.trim() }, redirectOn401: false });
    setBusy(false);
    if (!r.ok) {
      if (r.status === 401 || r.status === 429) {
        setStep('password');
        setCode('');
      }
      return setError(r.message);
    }
    window.location.assign(home(r.data.user?.role));
  };

  if (step === 'mfa') {
    return (
      <form onSubmit={submitCode} className="mt-6 space-y-4" noValidate>
        <p className="flex items-start gap-2 text-sm text-muted">
          <ShieldCheckIcon className="mt-0.5 h-4 w-4 shrink-0 text-accent" aria-hidden />
          Enter the 6-digit code from your authenticator app.
        </p>
        <TextField label="Authentication code" inputMode="numeric" autoComplete="one-time-code" value={code} onChange={setCode} maxLength={6} autoFocus />
        {error && (
          <p role="alert" className="rounded-lg border border-loss/40 bg-loss/10 px-3 py-2 text-sm text-loss">
            {error}
          </p>
        )}
        <Button type="submit" variant="primary" className="w-full" loading={busy} disabled={code.trim().length !== 6}>
          Verify
        </Button>
      </form>
    );
  }

  return (
    <form onSubmit={submitPassword} className="mt-6 space-y-4" noValidate>
      <TextField label="Email" type="email" autoComplete="username" value={email} onChange={setEmail} required />
      <TextField
        label="Password"
        type={shown ? 'text' : 'password'}
        autoComplete="current-password"
        value={password}
        onChange={setPassword}
        required
        trailing={
          <button
            type="button"
            onClick={() => setShown((s) => !s)}
            aria-label={shown ? 'Hide password' : 'Show password'}
            aria-pressed={shown}
            className="flex h-8 w-9 items-center justify-center rounded-md text-subtle transition-colors duration-150 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
          >
            {shown ? <EyeOffIcon className="h-4 w-4" aria-hidden /> : <EyeIcon className="h-4 w-4" aria-hidden />}
          </button>
        }
      />
      {error && (
        <p role="alert" className="rounded-lg border border-loss/40 bg-loss/10 px-3 py-2 text-sm text-loss">
          {error}
        </p>
      )}
      <Button type="submit" variant="primary" className="w-full" loading={busy} disabled={!email || !password}>
        Sign in
      </Button>
      <p className="text-center text-sm">
        <Link href="/account/forgot" className="text-accent hover:underline">
          Forgot your password?
        </Link>
      </p>
    </form>
  );
}
