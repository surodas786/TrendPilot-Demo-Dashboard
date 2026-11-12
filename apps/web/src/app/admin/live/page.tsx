import { LiveAdmin, type LiveAdminData } from '@/components/admin/LiveAdmin';
import { PageContainer } from '@/components/layout/PageContainer';
import { adminLiveData } from '@/server/live';
import { requirePageRole } from '@/server/pageSession';

export const dynamic = 'force-dynamic';

export default async function AdminLivePage() {
  await requirePageRole('ADMIN');
  const data = (await adminLiveData()) as unknown as LiveAdminData;
  return (
    <PageContainer
      title="Live Trading"
      description="The platform Live switch, the operator halt, MEXC order capability evidence, investor account approvals with limits, and the Live contract allowlist. Everything defaults to Off."
      scope="Keys and secrets are never shown. Every change is audited."
    >
      <LiveAdmin initial={data} />
    </PageContainer>
  );
}
