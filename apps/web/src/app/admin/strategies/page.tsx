import { getDb, listAllInstruments, listPackages } from '@trendpilot/db';
import { StrategiesAdmin } from '@/components/admin/StrategiesAdmin';
import { PageContainer } from '@/components/layout/PageContainer';
import { requirePageRole } from '@/server/pageSession';

export const dynamic = 'force-dynamic';

export default async function AdminStrategiesPage() {
  await requirePageRole('ADMIN');
  const db = getDb();
  const [packages, pairs] = await Promise.all([listPackages(db), listAllInstruments(db)]);
  return (
    <PageContainer
      title="Strategy Packages"
      description="Supertrend packages with 5m or 15m timeframe, ATR length and factor, EMA 200 filter, permitted directions and opposite-signal behavior."
      scope="Edits happen in a draft. Publishing creates an immutable version; investor settings stay pinned to the version they chose. TradingView routing arrives in M2."
    >
      <StrategiesAdmin packages={packages} pairs={pairs} />
    </PageContainer>
  );
}
