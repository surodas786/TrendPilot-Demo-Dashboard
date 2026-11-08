'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { LogOutIcon, ShieldCheckIcon, ShieldOffIcon } from 'lucide-react';
import { toast } from 'sonner';
import { request } from '@/lib/api';
import { Button } from '../ui/Button';
import { StatusPill } from '../ui/StatusPill';
import { TextField } from '../ui/TextField';

interface SessionDto {
  id: string;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  userAgent: string | null;
  current: boolean;
}

const fmt = (iso: string, tz: string) => new Date(iso).toLocaleString('en-GB', { timeZone: tz, dateStyle: 'medium', timeStyle: 'short' });

/** IAM-01: MFA enrolment and session revocation for the signed-in user only. */
export function SecurityPanel({ mfaEnabled: initialMfa, timezone }: { mfaEnabled: boolean; timezone: string }) {
  const [mfaEnabled, setMfaEnabled] = useState(initialMfa);
  const [setup, setSetup] = useState<{ secret: string; otpauthUri: string } | null>(null);
  const [code, setCode] = useState('');
  const [disabling, setDisabling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sessions, setSessions] = useState<SessionDto[] | null>(null);

  const loadSessions = useCallback(async () => {
    const r = await request<{ items: SessionDto[] }>('GET', '/v1/me/sessions');
    if (r.ok) setSessions(r.data.items);
  }, []);
  useEffect(() => {
    void loadSessions();
  }, [loadSessions]);

  const start = async () => {
    setError(null);
    const r = await request<{ secret: string; otpauthUri: string }>('POST', '/v1/me/mfa/setup');
    if (r.ok) setSetup(r.data);
    else setError(r.message);
  };
  const confirm = async () => {
    setBusy(true);
    setError(null);
    const r = await request('POST', setup ? '/v1/me/mfa/enable' : '/v1/me/mfa/disable', { body: { code: code.trim() } });
    setBusy(false);
    if (!r.ok) return setError(r.message);
    const enabling = Boolean(setup);
    setMfaEnabled(enabling);
    setSetup(null);
    setDisabling(false);
    setCode('');
    toast.success(enabling ? 'Two-step sign-in is on' : 'Two-step sign-in is off');
  };
  const revoke = async (id: string) => {
    const r = await request('POST', `/v1/me/sessions/${id}/revoke`);
    if (r.ok) toast('Session signed out');
    await loadSessions();
  };
  const revokeOthers = async () => {
    const r = await request<{ revoked: number }>('POST', '/v1/me/sessions/revoke-others');
    if (r.ok) toast(`Signed out ${r.data.revoked} other session${r.data.revoked === 1 ? '' : 's'}`);
    await loadSessions();
  };

  return (
    <div className="space-y-5">
      <div>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-sm font-medium text-ink">Two-step sign-in (authenticator app)</span>
          <StatusPill tone={mfaEnabled ? 'gain' : 'neutral'} icon={mfaEnabled ? ShieldCheckIcon : ShieldOffIcon}>
            <span data-testid="mfa-status">{mfaEnabled ? 'On' : 'Off'}</span>
          </StatusPill>
        </div>
        {!mfaEnabled && !setup && (
          <Button size="sm" className="mt-3" onClick={start}>
            Set up two-step sign-in
          </Button>
        )}
        {setup && (
          <div className="mt-3 space-y-3 rounded-lg border border-line bg-inset p-3 text-sm">
            <p className="text-muted">Add this key to an authenticator app (time-based, 6 digits, 30 seconds), then enter the current code.</p>
            <p>
              <span className="text-xs text-subtle">Setup key</span>
              <code data-testid="mfa-secret" className="mt-0.5 block break-all rounded bg-surface px-2 py-1 font-mono text-ink">
                {setup.secret}
              </code>
            </p>
            <a href={setup.otpauthUri} className="text-xs text-accent underline">
              Open in authenticator app
            </a>
          </div>
        )}
        {mfaEnabled && !disabling && (
          <Button size="sm" variant="ghost" className="mt-3" onClick={() => setDisabling(true)}>
            Turn off two-step sign-in
          </Button>
        )}
        {(setup || disabling) && (
          <div className="mt-3 flex flex-wrap items-end gap-2">
            <TextField label="Authentication code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={setCode} className="w-48" />
            <Button variant="primary" onClick={confirm} loading={busy} disabled={code.trim().length !== 6}>
              {setup ? 'Turn on' : 'Turn off'}
            </Button>
            <Button
              variant="ghost"
              onClick={() => {
                setSetup(null);
                setDisabling(false);
                setCode('');
                setError(null);
              }}
            >
              Cancel
            </Button>
          </div>
        )}
        {error && (
          <p role="alert" className="mt-2 text-xs text-loss">
            {error}
          </p>
        )}
      </div>

      <div>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-sm font-medium text-ink">Signed-in sessions</span>
          <Button size="sm" variant="ghost" icon={LogOutIcon} onClick={revokeOthers} disabled={!sessions || sessions.length < 2}>
            Sign out other sessions
          </Button>
        </div>
        <ul className="mt-2 divide-y divide-line rounded-lg border border-line" data-testid="session-list">
          {(sessions ?? []).map((s) => (
            <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-xs">
              <span className="min-w-0">
                <span className="block truncate text-ink">{s.userAgent ? s.userAgent.slice(0, 60) : 'Unknown device'}</span>
                <span className="text-subtle">Signed in {fmt(s.createdAt, timezone)} · expires {fmt(s.expiresAt, timezone)}</span>
              </span>
              {s.current ? <StatusPill tone="accent">This session</StatusPill> : <Button size="sm" variant="ghost" onClick={() => revoke(s.id)}>End session</Button>}
            </li>
          ))}
          {sessions?.length === 0 && <li className="px-3 py-2 text-xs text-subtle">No active sessions.</li>}
          {sessions === null && <li className="px-3 py-2 text-xs text-subtle">Loading…</li>}
        </ul>
      </div>
    </div>
  );
}
