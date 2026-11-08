import { AuthFrame } from '@/components/account/AuthFrame';
import { LinkPasswordForm } from '@/components/account/LinkPasswordForm';

export const dynamic = 'force-dynamic';

export default function ResetPage() {
  return (
    <AuthFrame title="Reset your password">
      <LinkPasswordForm kind="reset" />
    </AuthFrame>
  );
}
