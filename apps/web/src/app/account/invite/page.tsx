import { AuthFrame } from '@/components/account/AuthFrame';
import { LinkPasswordForm } from '@/components/account/LinkPasswordForm';

export const dynamic = 'force-dynamic';

export default function InvitePage() {
  return (
    <AuthFrame title="Activate your account" subtitle="Choose a password to finish setting up your TrendPilot investor account.">
      <LinkPasswordForm kind="invite" />
    </AuthFrame>
  );
}
