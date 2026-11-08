import React from 'react';
import { useNavigate } from 'react-router-dom';
import { LinkIcon } from 'lucide-react';
import { useDemo } from '../../contexts/DemoContext';
import { Button } from '../ui/Button';

export function LinkUnavailable({ reason }: {reason: string;}) {
  const { state } = useDemo();
  const navigate = useNavigate();
  return (
    <div className="text-center">
      <LinkIcon className="mx-auto h-6 w-6 text-subtle" aria-hidden />
      <h1 className="mt-3 text-lg font-semibold text-ink">This link is no longer available</h1>
      <p className="mt-1 text-sm text-muted">{reason}</p>
      <Button variant="primary" className="mt-6" onClick={() => navigate(state.role === 'admin' ? '/admin/users' : '/')}>
        Return to TrendPilot
      </Button>
    </div>);

}

export function linkUnavailableReason(state: 'active' | 'used' | 'replaced' | undefined, kind: 'invite' | 'reset'): string {
  const noun = kind === 'invite' ? 'invitation' : 'password-reset link';
  if (state === 'used') return `This simulated ${noun} has already been used.`;
  if (state === 'replaced') return `This simulated ${noun} was replaced by a newer one or is no longer valid.`;
  return `This simulated ${noun} could not be found.`;
}