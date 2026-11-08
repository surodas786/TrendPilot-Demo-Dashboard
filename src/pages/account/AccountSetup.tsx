import React, { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { CheckCircle2Icon } from 'lucide-react';
import { useDemo } from '../../contexts/DemoContext';
import { passwordErrors, MIN_PASSWORD } from '../../utils/userDirectory';
import { AuthFrame } from '../../components/account/AuthFrame';
import { PasswordField } from '../../components/account/PasswordField';
import { LinkUnavailable, linkUnavailableReason } from '../../components/account/LinkUnavailable';
import { Button } from '../../components/ui/Button';

/** Simulated account setup from an invitation. Passwords live only in this component's memory. */
export function AccountSetup() {
  const { linkId } = useParams();
  const { state, completeSetup, setRole, setTraderUser } = useDemo();
  const navigate = useNavigate();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [touched, setTouched] = useState(false);
  const [activatedUserId, setActivatedUserId] = useState<string | null>(null);

  const link = state.userLinks.find((l) => l.id === linkId && l.kind === 'invite');
  const user = state.users.find((u) => u.id === (activatedUserId ?? link?.userId));

  if (activatedUserId && user) {
    return (
      <AuthFrame>
        <div className="text-center">
          <CheckCircle2Icon className="mx-auto h-8 w-8 text-gain" aria-hidden />
          <h1 className="mt-3 text-lg font-semibold text-ink">Account activated</h1>
          <p className="mt-1 text-sm text-muted">
            {user.name}’s subscriber account is now Active. The password was used only for this simulation and was not stored.
          </p>
          <Button
            variant="primary"
            className="mt-6"
            onClick={() => {
              setTraderUser(user.id);
              setRole('trader');
              navigate('/');
            }}>
            
            Preview Subscriber Account
          </Button>
        </div>
      </AuthFrame>);

  }

  if (!link || !user || link.state !== 'active' || user.status !== 'invited') {
    return (
      <AuthFrame>
        <LinkUnavailable reason={link && link.state === 'active' && user && user.status !== 'invited' ? 'This account has already been set up.' : linkUnavailableReason(link?.state, 'invite')} />
      </AuthFrame>);

  }

  const errors = passwordErrors(password, confirm);
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (errors.password || errors.confirm) return;
    completeSetup(link.id);
    setPassword('');
    setConfirm('');
    setActivatedUserId(user.id);
  };

  return (
    <AuthFrame>
      <form onSubmit={submit} noValidate className="space-y-4">
        <div>
          <h1 className="text-lg font-semibold text-ink">Set up your account</h1>
          <p className="mt-1 text-sm text-muted">Choose a password to activate your subscriber account.</p>
        </div>
        <dl className="rounded-lg border border-line bg-inset p-3 text-sm">
          <dt className="sr-only">Name</dt>
          <dd className="font-medium text-ink">{user.name}</dd>
          <dt className="sr-only">Email</dt>
          <dd className="break-words text-muted">{user.email}</dd>
        </dl>
        <PasswordField label="New password" value={password} onChange={setPassword} autoComplete="new-password" hint={`At least ${MIN_PASSWORD} characters`} error={touched ? errors.password : undefined} />
        <PasswordField label="Confirm password" value={confirm} onChange={setConfirm} autoComplete="new-password" error={touched ? errors.confirm : undefined} />
        <Button type="submit" variant="primary" className="w-full">
          Set Password & Activate Account
        </Button>
      </form>
    </AuthFrame>);

}