import { getDb, getFeedTransport, listFeedEvents, listFeedHealth } from '@trendpilot/db';
import { MarketFeedsAdmin } from '@/components/admin/MarketFeedsAdmin';
import { PageContainer } from '@/components/layout/PageContainer';
import { now } from '@/server/clock';
import { requirePageRole } from '@/server/pageSession';

export const dynamic = 'force-dynamic';

export default async function AdminMarketDataPage() {
  const { user } = await requirePageRole('ADMIN');
  const db = getDb();
  const at = now();
  const [items, events, transport] = await Promise.all([listFeedHealth(db, at), listFeedEvents(db, 50), getFeedTransport(db, at)]);
  return (
    <PageContainer
      title="Market Data Feed"
      description="Public MEXC Futures prices and closed candles used by Paper mode, per contract: feed state, freshness, current price source and recent feed events. Prices arrive over the public WebSocket and update here live."
      scope="Public market data only. No API keys or private endpoints are used. Orders are filled by the paper simulator; live order submission is disabled."
    >
      <MarketFeedsAdmin initial={{ items, events, transport, checkedAt: at.toISOString() }} timezone={user.timezone} />
    </PageContainer>
  );
}
