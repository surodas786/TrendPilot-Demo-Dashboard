'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import { AuthFrame } from '@/components/account/AuthFrame';
import { Button } from '@/components/ui/Button';
import { TextField } from '@/components/ui/TextField';
import { request } from '@/lib/api';

/** IAM-01 password recovery. The answer is the same whether or not the email exists. */
export default function ForgotPage() {
  const [email, setEmail] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    const r = await request<{ message: string }>('POST', '/v1/auth/password/forgot', { body: { email }, redirectOn401: false });
    setBusy(false);
    setMessage(r.ok ? r.data.message : r.message);
  };

  return (
    <AuthFrame title="Forgot your password?" subtitle="We will email a single-use link that expires in 30 minutes.">
      {message ? (
        <p role="status" className="mt-6 text-sm text-muted">
          {message}
        </p>
      ) : (
        <form onSubmit={submit} className="mt-6 space-y-4" noValidate>
          <TextField label="Email" type="email" autoComplete="username" value={email} onChange={setEmail} />
          <Button type="submit" variant="primary" className="w-full" loading={busy} disabled={!email}>
            Send reset link
          </Button>
        </form>
      )}
      <p className="mt-4 text-center text-sm">
        <Link href="/sign-in" className="text-accent hover:underline">
          Back to sign in
        </Link>
      </p>
    </AuthFrame>
  );
}
