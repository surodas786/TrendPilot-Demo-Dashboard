import React from 'react';
import { useNavigate } from 'react-router-dom';
import { ExternalLinkIcon, MailIcon } from 'lucide-react';
import { useDemo } from '../../contexts/DemoContext';
import { Button } from '../ui/Button';
import { Modal } from '../ui/Modal';
import { ModalHeader } from '../ui/ModalHeader';
import { StatusPill } from '../ui/StatusPill';

/** Simulated email preview. Reads the user's current details so edits stay consistent. */
export function EmailPreviewModal({ linkId, onClose }: {linkId: string | null;onClose: () => void;}) {
  const { state } = useDemo();
  const navigate = useNavigate();
  const link = linkId ? state.userLinks.find((l) => l.id === linkId) : undefined;
  const user = link ? state.users.find((u) => u.id === link.userId) : undefined;
  const invite = link?.kind === 'invite';

  return (
    <Modal open={Boolean(link && user)} onClose={onClose} labelledBy="email-preview-title">
      {link && user &&
      <>
          <ModalHeader id="email-preview-title" title={invite ? 'Invitation email preview' : 'Password-reset email preview'} description="Demo simulation — no email was sent." onClose={onClose} />
          <div className="scrollbar-thin space-y-4 overflow-y-auto px-5 py-5 sm:px-6">
            <dl className="space-y-1.5 text-sm">
              <div className="flex gap-2">
                <dt className="w-14 shrink-0 text-subtle">To</dt>
                <dd className="min-w-0 break-words text-ink">
                  {user.name} &lt;{user.email}&gt;
                </dd>
              </div>
              <div className="flex gap-2">
                <dt className="w-14 shrink-0 text-subtle">Subject</dt>
                <dd className="text-ink">{invite ? 'Set up your TrendPilot account' : 'Reset your TrendPilot password'}</dd>
              </div>
            </dl>
            <article className="rounded-lg border border-line bg-inset p-4 text-sm text-muted">
              <p className="flex items-center gap-2 font-semibold text-ink">
                <MailIcon className="h-4 w-4 text-accent" aria-hidden /> TrendPilot
              </p>
              <p className="mt-3">Hi {user.name.split(' ')[0]},</p>
              <p className="mt-2">
                {invite ?
              'An administrator created a TrendPilot subscriber account for you. Use the link below to set your password and activate your account.' :
              'We received a request to reset your TrendPilot password. Use the link below to choose a new password. If you did not ask for this, you can ignore this email.'}
              </p>
              <p className="mt-3 break-all font-mono text-xs text-subtle">Simulated link ID: {link.id}</p>
            </article>
            {link.state !== 'active' &&
          <StatusPill tone="warn">{link.state === 'used' ? 'This link has been used' : 'This link was replaced by a newer one'}</StatusPill>
          }
          </div>
          <footer className="flex flex-col-reverse gap-2 border-t border-line px-5 py-4 sm:flex-row sm:justify-end sm:px-6">
            <Button onClick={onClose}>Close</Button>
            <Button
            variant="primary"
            icon={ExternalLinkIcon}
            onClick={() => {
              onClose();
              navigate(`/account/${invite ? 'setup' : 'reset'}/${link.id}`);
            }}>
            
              {invite ? 'Open Setup Page' : 'Open Reset Page'}
            </Button>
          </footer>
        </>
      }
    </Modal>);

}