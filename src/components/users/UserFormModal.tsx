import React, { useState } from 'react';
import { useDemo } from '../../contexts/DemoContext';
import { ownerOf } from '../../data/demoUsers';
import { EMAIL_RE, formatUserDate } from '../../utils/userDirectory';
import { Button } from '../ui/Button';
import { Modal } from '../ui/Modal';
import { ModalHeader } from '../ui/ModalHeader';
import { TextField } from '../ui/TextField';
import { AccountStatusPill, InvitationPill } from './UserStatusPills';
import type { DemoUser } from '../../types/signals';

interface UserFormModalProps {
  open: boolean;
  /** undefined = create a new subscriber. */
  user?: DemoUser;
  onClose: () => void;
  onSubmit: (name: string, email: string) => void;
}

/** Create (subscribers only, no role selector) or view/edit a subscriber. */
export function UserFormModal({ open, user, onClose, onSubmit }: UserFormModalProps) {
  return (
    <Modal open={open} onClose={onClose} labelledBy="user-form-title">
      <UserForm key={user?.id ?? 'new'} user={user} onClose={onClose} onSubmit={onSubmit} />
    </Modal>);

}

function UserForm({ user, onClose, onSubmit }: Omit<UserFormModalProps, 'open'>) {
  const { state } = useDemo();
  const [name, setName] = useState(user?.name ?? '');
  const [email, setEmail] = useState(user?.email ?? '');
  const [touched, setTouched] = useState(false);
  const accountCount = user ? state.accounts.filter((a) => ownerOf(a) === user.id).length : 0;

  const trimmedEmail = email.trim();
  const nameError = !name.trim() ? 'Enter the subscriber’s full name.' : undefined;
  const emailError = !trimmedEmail ?
  'Enter an email address.' :
  !EMAIL_RE.test(trimmedEmail) ?
  'Enter a valid email address, e.g. name@example.com.' :
  state.users.some((u) => u.id !== user?.id && u.email.toLowerCase() === trimmedEmail.toLowerCase()) ?
  'Another user already uses this email address.' :
  undefined;
  const invalid = Boolean(nameError || emailError);
  const unchanged = Boolean(user && name.trim() === user.name && trimmedEmail === user.email);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (invalid || unchanged) return;
    onSubmit(name.trim(), trimmedEmail);
  };

  return (
    <form onSubmit={submit} noValidate className="flex min-h-0 flex-col">
      <ModalHeader id="user-form-title" title={user ? 'Subscriber details' : 'Create User'} description={user ? undefined : 'New accounts are always Subscribers. An account setup invitation is simulated — no email is sent.'} onClose={onClose} />
      <div className="scrollbar-thin space-y-4 overflow-y-auto px-5 py-5 sm:px-6">
        {user &&
        <dl className="grid grid-cols-2 gap-3 rounded-lg border border-line bg-inset p-3 text-xs">
            <div>
              <dt className="text-subtle">Account status</dt>
              <dd className="mt-1">
                <AccountStatusPill status={user.status} />
              </dd>
            </div>
            <div>
              <dt className="text-subtle">Invitation</dt>
              <dd className="mt-1">
                <InvitationPill invitation={user.invitation} />
              </dd>
            </div>
            <div>
              <dt className="text-subtle">Created</dt>
              <dd className="mt-1 text-ink">{formatUserDate(user.createdAt)}</dd>
            </div>
            <div>
              <dt className="text-subtle">Role · paper accounts</dt>
              <dd className="mt-1 text-ink">Subscriber · {accountCount}</dd>
            </div>
          </dl>
        }
        <TextField label="Full name" value={name} onChange={setName} autoComplete="off" error={touched ? nameError : undefined} autoFocus={!user} />
        <TextField label="Email address" type="email" value={email} onChange={setEmail} autoComplete="off" error={touched ? emailError : undefined} />
      </div>
      <footer className="flex flex-col-reverse gap-2 border-t border-line px-5 py-4 sm:flex-row sm:justify-end sm:px-6">
        <Button onClick={onClose}>Cancel</Button>
        <Button type="submit" variant="primary" disabled={touched && (invalid || unchanged)}>
          {user ? 'Save changes' : 'Create & Send Invitation'}
        </Button>
      </footer>
    </form>);

}