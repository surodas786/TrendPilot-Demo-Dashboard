import { getDb, getMailBoxView } from '@trendpilot/db';
import { MailBoxAdmin } from '@/components/admin/MailBoxAdmin';
import { PageContainer } from '@/components/layout/PageContainer';
import { requirePageRole } from '@/server/pageSession';

export const dynamic = 'force-dynamic';

export default async function AdminMailBoxPage() {
  const { user } = await requirePageRole('ADMIN');
  const initial = await getMailBoxView(getDb());
  return (
    <PageContainer
      title="Mail Box"
      description="Outgoing email (SMTP) for investor invitations, password resets and account notices."
      scope="Settings · administrators only. The SMTP password is stored encrypted and never shown."
    >
      <MailBoxAdmin initial={initial} timezone={user.timezone} adminEmail={user.email} />
    </PageContainer>
  );
}
