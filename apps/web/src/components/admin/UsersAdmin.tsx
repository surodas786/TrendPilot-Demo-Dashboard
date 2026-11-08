'use client';

import React, { useState } from 'react';
import { useRouter } from 'next/navigation';
import { MailIcon, UserPlusIcon } from 'lucide-react';
import { toast } from 'sonner';
import type { AdminUserDto } from '@trendpilot/db';
import { issueMap, request } from '@/lib/api';
import { Button } from '../ui/Button';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { StatusPill } from '../ui/StatusPill';
import { TextField } from '../ui/TextField';

type Action = { kind: 'suspend' | 'reactivate' | 'reset' | 'revoke' | 'resend'; user: AdminUserDto };

const statusTone = { ACTIVE: 'gain', INVITED: 'accent', SUSPENDED: 'loss' } as const;
const statusLabel = { ACTIVE: 'Active', INVITED: 'Invited', SUSPENDED: 'Suspended' } as const;

/** UI-05 Users: invite, resend, suspend, reactivate, send reset, revoke sessions. */
export function UsersAdmin({ users, devMailbox }: { users: AdminUserDto[]; devMailbox: boolean }) {
  const router = useRouter();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [action, setAction] = useState<Action | null>(null);

  const invite = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErrors({});
    const r = await request<AdminUserDto>('POST', '/v1/admin/users', { body: { name, email } });
    setBusy(false);
    if (!r.ok) {
      setErrors(r.issues.length ? issueMap(r.issues) : { email: r.message });
      return;
    }
    toast.success(`Invitation sent to ${r.data.email}`, { description: devMailbox ? 'Captured in the development mailbox.' : undefined });
    setName('');
    setEmail('');
    router.refresh();
  };

  const run = async (a: Action) => {
    setAction(null);
    const id = a.user.id;
    const r =
      a.kind === 'suspend'
        ? await request('POST', `/v1/admin/users/${id}/suspend`, { revision: a.user.revision })
        : a.kind === 'reactivate'
          ? await request('POST', `/v1/admin/users/${id}/reactivate`, { revision: a.user.revision })
          : a.kind === 'reset'
            ? await request('POST', `/v1/admin/users/${id}/reset-password`)
            : a.kind === 'resend'
              ? await request('POST', `/v1/admin/users/${id}/resend-invite`)
              : await request('POST', `/v1/admin/users/${id}/revoke-sessions`);
    if (!r.ok) toast.error(r.message);
    else toast.success({ suspend: 'Investor suspended', reactivate: 'Investor reactivated', reset: 'Reset link sent', resend: 'Invitation resent', revoke: 'All sessions signed out' }[a.kind]);
    router.refresh();
  };

  const confirmText: Record<Action['kind'], string> = {
    suspend: 'Suspending blocks sign-in and new entries, signs the investor out everywhere and cancels pending links. Existing protection is not affected.',
    reactivate: 'The investor can sign in again. Their order blocks stay as they are.',
    reset: 'Email the investor a single-use password reset link that expires in 30 minutes.',
    resend: 'Send a fresh invitation link. The previous link stops working.',
    revoke: 'Sign the investor out of every session.'
  };

  return (
    <div className="space-y-5">
      <form onSubmit={invite} className="rounded-xl border border-line bg-surface p-4" noValidate>
        <h3 className="flex items-center gap-2 text-sm font-semibold text-ink">
          <UserPlusIcon className="h-4 w-4 text-subtle" aria-hidden /> Invite an investor
        </h3>
        <div className="mt-3 grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-start">
          <TextField label="Full name" value={name} onChange={setName} error={errors.name} />
          <TextField label="Email" type="email" value={email} onChange={setEmail} error={errors.email} />
          <Button type="submit" variant="primary" className="sm:mt-7" loading={busy} disabled={!name || !email}>
            Send invitation
          </Button>
        </div>
        <p className="mt-2 text-xs text-subtle">
          The invitation link is single-use and expires in 72 hours.
          {devMailbox && (
            <>
              {' '}
              In development, emails are captured in the{' '}
              <a href="/dev/mail" target="_blank" className="text-accent underline">
                local mailbox
              </a>
              .
            </>
          )}
        </p>
      </form>

      <div className="overflow-x-auto rounded-xl border border-line bg-surface">
        <table className="w-full min-w-[760px] text-left text-sm">
          <thead className="border-b border-line text-xs text-subtle">
            <tr>
              <th scope="col" className="px-4 py-2.5 font-medium">Name</th>
              <th scope="col" className="px-4 py-2.5 font-medium">Email</th>
              <th scope="col" className="px-4 py-2.5 font-medium">Role</th>
              <th scope="col" className="px-4 py-2.5 font-medium">Status</th>
              <th scope="col" className="px-4 py-2.5 font-medium">MFA</th>
              <th scope="col" className="px-4 py-2.5 font-medium">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {users.map((u) => (
              <tr key={u.id} data-testid={`user-row-${u.email}`}>
                <td className="px-4 py-2.5 text-ink">{u.name}</td>
                <td className="px-4 py-2.5 text-muted">{u.email}</td>
                <td className="px-4 py-2.5 text-muted">{u.role === 'ADMIN' ? 'Administrator' : 'Investor'}</td>
                <td className="px-4 py-2.5">
                  <StatusPill tone={statusTone[u.status]}>{statusLabel[u.status]}</StatusPill>
                </td>
                <td className="px-4 py-2.5 text-muted">{u.mfaEnabled ? 'On' : 'Off'}</td>
                <td className="px-4 py-2.5">
                  {u.role === 'INVESTOR' && (
                    <div className="flex flex-wrap gap-1.5">
                      {u.status === 'INVITED' && (
                        <Button size="sm" icon={MailIcon} onClick={() => setAction({ kind: 'resend', user: u })}>
                          Resend invite
                        </Button>
                      )}
                      {u.status === 'ACTIVE' && (
                        <>
                          <Button size="sm" onClick={() => setAction({ kind: 'reset', user: u })}>
                            Send reset
                          </Button>
                          <Button size="sm" onClick={() => setAction({ kind: 'revoke', user: u })}>
                            Sign out everywhere
                          </Button>
                          <Button size="sm" variant="danger" onClick={() => setAction({ kind: 'suspend', user: u })}>
                            Suspend
                          </Button>
                        </>
                      )}
                      {u.status === 'SUSPENDED' && (
                        <Button size="sm" onClick={() => setAction({ kind: 'reactivate', user: u })}>
                          Reactivate
                        </Button>
                      )}
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <ConfirmDialog
        open={action !== null}
        title={action ? `${{ suspend: 'Suspend', reactivate: 'Reactivate', reset: 'Send password reset to', resend: 'Resend invitation to', revoke: 'Sign out' }[action.kind]} ${action.user.name}?` : ''}
        description={action ? confirmText[action.kind] : ''}
        confirmLabel={action ? { suspend: 'Suspend', reactivate: 'Reactivate', reset: 'Send reset', resend: 'Resend', revoke: 'Sign out everywhere' }[action.kind] : 'OK'}
        tone={action?.kind === 'suspend' ? 'danger' : 'default'}
        onConfirm={() => action && run(action)}
        onCancel={() => setAction(null)}
      />
    </div>
  );
}
