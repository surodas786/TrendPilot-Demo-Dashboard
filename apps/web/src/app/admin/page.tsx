import { getDb, listUsers } from '@trendpilot/db';
import { UsersAdmin } from '@/components/admin/UsersAdmin';
import { PageContainer } from '@/components/layout/PageContainer';
import { devMailboxEnabled } from '@/server/devMailbox';
import { requirePageRole } from '@/server/pageSession';

export const dynamic = 'force-dynamic';

export default async function AdminUsersPage() {
  await requirePageRole('ADMIN');
  const users = await listUsers(getDb());
  return (
    <PageContainer
      title="Users"
      description="Invite investors, resend invitations, send password resets, sign investors out and suspend access."
      scope="Admin screens never show investor credentials, MFA secrets or private trading settings."
    >
      <UsersAdmin users={users} devMailbox={devMailboxEnabled()} />
    </PageContainer>
  );
}
