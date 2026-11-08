import { getDb, listAudit } from '@trendpilot/db';
import { AuditLog } from '@/components/admin/AuditLog';
import { PageContainer } from '@/components/layout/PageContainer';
import { requirePageRole } from '@/server/pageSession';

export const dynamic = 'force-dynamic';

export default async function AdminAuditPage() {
  const { user } = await requirePageRole('ADMIN');
  const initial = await listAudit(getDb(), { limit: 50 });
  return (
    <PageContainer
      title="Audit Log"
      description="Append-only record of administrative, account and trade-settings changes, with actor, time, action and redacted before/after values."
      scope="Records cannot be edited or deleted. Select a row for details."
    >
      <AuditLog initial={initial} timezone={user.timezone} />
    </PageContainer>
  );
}
