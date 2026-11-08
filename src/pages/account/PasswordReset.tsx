import React, { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { CheckCircle2Icon } from 'lucide-react';
import { useDemo } from '../../contexts/DemoContext';
import { passwordErrors, MIN_PASSWORD } from '../../utils/userDirectory';
import { AuthFrame } from '../../components/account/AuthFrame';
import { PasswordField } from '../../components/account/PasswordField';
import { LinkUnavailable, linkUnavailableReason } from '../../components/account/LinkUnavailable';
import { Button } from '../../components/ui/Button';
import { TextField } from '../../components/ui/TextField';

/** Simulated password reset. Works once per link; account status is unchanged. */
export function PasswordReset() {
  const { linkId } = useParams();
  const { state, completeReset } = useDemo();
  const navigate = useNavigate();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [touched, setTouched] = useState(false);
  const [doneEmail, setDoneEmail] = useState<string | null>(null);

  const link = state.userLinks.find((l) => l.id === linkId && l.kind === 'reset');
  const user = link ? state.users.find((u) => u.id === link.userId) : undefined;

  if (doneEmail) {
    return (
      <AuthFrame>
        <div className="text-center">
          <CheckCircle2Icon className="mx-auto h-8 w-8 text-gain" aria-hidden />
          <h1 className="mt-3 text-lg font-semibold text-ink">Password reset</h1>
          <p className="mt-1 text-sm text-muted">The password for {doneEmail} was reset in this simulation. Nothing was stored, and the reset link can’t be used again.</p>
          <Button variant="primary" className="mt-6" onClick={() => navigate(state.role === 'admin' ? '/admin/users' : '/')}>
            Return to TrendPilot
          </Button>
        </div>
      </AuthFrame>);

  }

  if (!link || !user || link.state !== 'active') {
    return (
      <AuthFrame>
        <LinkUnavailable reason={linkUnavailableReason(link?.state, 'reset')} />
      </AuthFrame>);

  }

  const errors = passwordErrors(password, confirm);
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (errors.password || errors.confirm) return;
    completeReset(link.id);
    setPassword('');
    setConfirm('');
    setDoneEmail(user.email);
  };

  return (
    <AuthFrame>
      <form onSubmit={submit} noValidate className="space-y-4">
        <div>
          <h1 className="text-lg font-semibold text-ink">Reset your password</h1>
          <p className="mt-1 text-sm text-muted">Choose a new password for your TrendPilot account.</p>
        </div>
        <TextField label="Subscriber email" value={user.email} readOnly />
        <PasswordField label="New password" value={password} onChange={setPassword} autoComplete="new-password" hint={`At least ${MIN_PASSWORD} characters`} error={touched ? errors.password : undefined} />
        <PasswordField label="Confirm password" value={confirm} onChange={setConfirm} autoComplete="new-password" error={touched ? errors.confirm : undefined} />
        <Button type="submit" variant="primary" className="w-full">
          Reset Password
        </Button>
      </form>
    </AuthFrame>);

}