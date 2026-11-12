import { getDb, getOperationsStatus } from '@trendpilot/db';
import { OperationsAdmin } from '@/components/admin/OperationsAdmin';
import { PageContainer } from '@/components/layout/PageContainer';
import { now } from '@/server/clock';
import { requirePageRole } from '@/server/pageSession';

export const dynamic = 'force-dynamic';

export default async function AdminOperationsPage() {
  const { user } = await requirePageRole('ADMIN');
  const initial = await getOperationsStatus(getDb(), now());
  return (
    <PageContainer
      title="Operations"
      description="Health of the database, worker and public market feed, the durable job queue and recent failures."
      scope="Paper and Live: Live account health shows status and drift only — no balances, keys or private trades."
    >
      <OperationsAdmin initial={initial} timezone={user.timezone} />
    </PageContainer>
  );
}
