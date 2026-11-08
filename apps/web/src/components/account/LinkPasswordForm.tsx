'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { CheckCircle2Icon } from 'lucide-react';
import { PASSWORD_MIN } from '@trendpilot/domain';
import { issueMap, request } from '@/lib/api';
import { Button } from '../ui/Button';
import { TextField } from '../ui/TextField';

/**
 * Invite acceptance and password reset. The single-use token arrives in the URL fragment
 * (#token=…), which browsers never send to the server; we post it in the body instead.
 */
export function LinkPasswordForm({ kind }: { kind: 'invite' | 'reset' }) {
  const [token, setToken] = useState<string | null>(null);
  const [who, setWho] = useState<{ name: string; email: string } | null>(null);
  const [state, setState] = useState<'checking' | 'ready' | 'invalid' | 'done'>('checking');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const base = kind === 'invite' ? '/v1/auth/invite' : '/v1/auth/password';

  useEffect(() => {
    const t = new URLSearchParams(window.location.hash.slice(1)).get('token');
    // Remove the token from the address bar and history.
    window.history.replaceState(null, '', window.location.pathname);
    if (!t) return setState('invalid');
    setToken(t);
    request<{ name: string; email: string }>('POST', `${base}/check`, { body: { token: t }, redirectOn401: false }).then((r) => {
      if (r.ok) {
        setWho(r.data);
        setState('ready');
      } else setState('invalid');
    });
  }, [base]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (password !== confirm) return setError('The passwords do not match.');
    setBusy(true);
    const r = await request('POST', kind === 'invite' ? `${base}/accept` : `${base}/reset`, { body: { token, password }, redirectOn401: false });
    setBusy(false);
    if (r.ok) return setState('done');
    if (r.code === 'LINK_INVALID') return setState('invalid');
    setError(issueMap(r.issues).password ?? r.message);
  };

  if (state === 'checking') return <p className="mt-6 text-sm text-muted">Checking your link…</p>;
  if (state === 'invalid')
    return (
      <div className="mt-6 space-y-3 text-sm">
        <p role="alert" className="rounded-lg border border-loss/40 bg-loss/10 px-3 py-2 text-loss">
          This link is invalid, expired or already used.
        </p>
        <p className="text-muted">
          {kind === 'invite' ? 'Ask your administrator to resend the invitation.' : <Link href="/account/forgot" className="text-accent hover:underline">Request a new reset link.</Link>}
        </p>
      </div>
    );
  if (state === 'done')
    return (
      <div className="mt-6 space-y-4 text-sm">
        <p role="status" className="flex items-start gap-2 text-gain">
          <CheckCircle2Icon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          {kind === 'invite' ? 'Your password is set and your account is active.' : 'Your password was changed. All previous sessions were signed out.'}
        </p>
        <Link href="/sign-in" className="inline-flex h-9 items-center rounded-lg bg-accent px-4 text-sm font-semibold text-accent-ink">
          Go to sign in
        </Link>
      </div>
    );

  return (
    <form onSubmit={submit} className="mt-6 space-y-4" noValidate>
      {who && (
        <p className="text-sm text-muted">
          {kind === 'invite' ? 'Welcome, ' : 'Account: '}
          <span className="text-ink">{who.name}</span> ({who.email})
        </p>
      )}
      <TextField label="New password" type="password" autoComplete="new-password" value={password} onChange={setPassword} hint={`At least ${PASSWORD_MIN} characters, with a letter and a number.`} />
      <TextField label="Confirm password" type="password" autoComplete="new-password" value={confirm} onChange={setConfirm} />
      {error && (
        <p role="alert" className="text-sm text-loss">
          {error}
        </p>
      )}
      <Button type="submit" variant="primary" className="w-full" loading={busy} disabled={!password || !confirm}>
        {kind === 'invite' ? 'Set password and activate' : 'Change password'}
      </Button>
    </form>
  );
}
