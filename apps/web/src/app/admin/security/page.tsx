import { SecurityPanel } from '@/components/account/SecurityPanel';
import { PageContainer } from '@/components/layout/PageContainer';
import { requirePageRole } from '@/server/pageSession';

export const dynamic = 'force-dynamic';

export default async function AdminSecurityPage() {
  const { user } = await requirePageRole('ADMIN');
  return (
    <PageContainer title="My Security" description="Two-step sign-in and active sessions for your administrator account." scope={`${user.name} · ${user.email}`}>
      <section className="max-w-2xl rounded-xl border border-line bg-surface p-5">
        <SecurityPanel mfaEnabled={user.mfaEnabled} timezone={user.timezone} />
      </section>
    </PageContainer>
  );
}
