import { redirect } from 'next/navigation';
import { AuthFrame } from '@/components/account/AuthFrame';
import { homeFor, pageSession } from '@/server/pageSession';
import { SignInForm } from './SignInForm';

export const dynamic = 'force-dynamic';

export default async function SignInPage() {
  const s = await pageSession();
  if (s) redirect(homeFor(s.user.role));
  return (
    <AuthFrame title="Sign in" subtitle="Use the account your administrator created for you.">
      <SignInForm />
    </AuthFrame>
  );
}
