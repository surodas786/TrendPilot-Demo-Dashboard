import { getDb, listAllInstruments } from '@trendpilot/db';
import { PairsAdmin } from '@/components/admin/PairsAdmin';
import { PageContainer } from '@/components/layout/PageContainer';
import { requirePageRole } from '@/server/pageSession';

export const dynamic = 'force-dynamic';

export default async function AdminPairsPage() {
  await requirePageRole('ADMIN');
  const pairs = await listAllInstruments(getDb());
  return (
    <PageContainer
      title="Trading Pairs & Defaults"
      description="Approve MEXC Futures USDT perpetual contracts and set the stop, take-profit and trailing values investors start from."
      scope="Contract data comes from local fixtures in this build. Disabling a pair blocks new settings and resumes; it never touches open positions."
    >
      <PairsAdmin pairs={pairs} />
    </PageContainer>
  );
}
