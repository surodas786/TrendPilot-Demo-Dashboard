import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getDb, getMyTrade, listLatestQuotes, listMyHoldings } from '@trendpilot/db';
import { HoldingDetailClient } from '@/components/holdings/HoldingDetailClient';
import { PageContainer } from '@/components/layout/PageContainer';
import { ClosePositionButton } from '@/components/trades/ClosePositionButton';
import { now } from '@/server/clock';
import { requirePageRole } from '@/server/pageSession';

export const dynamic = 'force-dynamic';

/** One holding. Owner-scoped: another investor's position ID is a 404 page. */
export default async function HoldingDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { user } = await requirePageRole('INVESTOR');
  const { id } = await params;
  const db = getDb();
  const at = now();
  const t = await getMyTrade(db, user.id, id);
  if (!t) notFound();
  const [holdings, quotes] = await Promise.all([t.status === 'OPEN' ? listMyHoldings(db, user.id, at) : Promise.resolve([]), listLatestQuotes(db, at, { publishedOnly: true })]);
  const price = holdings.find((h) => h.id === t.id)?.price ?? null;

  return (
    <PageContainer
      title={`${t.pair} ${t.side === 'LONG' ? 'Long' : 'Short'} · ${t.mode === 'LIVE' ? 'Live' : 'Paper'}`}
      description={`${t.exchange} ${t.exchangeSymbol} perpetual. ${t.status === 'OPEN' ? 'Open position' : 'Closed position'} — fills, exits and chart.`}
      scope={`${user.name} · My Account`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Link href="/my-holdings" className="text-sm text-accent hover:underline">
          ← My Holdings
        </Link>
        {t.status === 'OPEN' && <ClosePositionButton positionId={t.id} symbol={t.symbol} side={t.side} contracts={t.contracts} />}
      </div>
      <HoldingDetailClient t={t} holdingPrice={price} quotes={quotes} timezone={user.timezone} />
    </PageContainer>
  );
}
