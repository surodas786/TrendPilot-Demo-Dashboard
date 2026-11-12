import { getDb, listLatestQuotes, listMyHoldings, listMyPositions } from '@trendpilot/db';
import { HoldingsClient } from '@/components/holdings/HoldingsClient';
import { PageContainer } from '@/components/layout/PageContainer';
import { now } from '@/server/clock';
import { requirePageRole } from '@/server/pageSession';

export const dynamic = 'force-dynamic';

/** My Holdings: the signed-in investor's own positions only (owner-scoped read models). */
export default async function MyHoldingsPage() {
  const { user } = await requirePageRole('INVESTOR');
  const db = getDb();
  const at = now();
  const [open, all, quotes] = await Promise.all([listMyHoldings(db, user.id, at), listMyPositions(db, user.id), listLatestQuotes(db, at, { publishedOnly: true })]);
  const closed = all.filter((p) => p.status === 'CLOSED').sort((a, b) => Date.parse(b.closedAt ?? b.openedAt) - Date.parse(a.closedAt ?? a.openedAt));
  return (
    <PageContainer title="My Holdings" description="Your positions with live prices, unrealized P&L and stop protection. Select a holding for its fills and chart." scope={`${user.name} · My Account`}>
      <HoldingsClient open={open} closed={closed} quotes={quotes} timezone={user.timezone} />
    </PageContainer>
  );
}
