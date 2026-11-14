import { connectionFor, getDb, listLatestQuotes, listMyHoldings, listMyPositions } from '@trendpilot/db';
import { HoldingsClient } from '@/components/holdings/HoldingsClient';
import { SyncWithMexcButton } from '@/components/trades/SyncWithMexcButton';
import { PageContainer } from '@/components/layout/PageContainer';
import { ModeTabs, viewModeOf } from '@/components/ui/ModeTabs';
import { now } from '@/server/clock';
import { requirePageRole } from '@/server/pageSession';

export const dynamic = 'force-dynamic';

/** My Holdings: the signed-in investor's own positions only (owner-scoped read models). */
export default async function MyHoldingsPage({ searchParams }: { searchParams: Promise<{ mode?: string }> }) {
  const { user } = await requirePageRole('INVESTOR');
  const mode = viewModeOf((await searchParams).mode);
  const db = getDb();
  const at = now();
  const [open, all, quotes, connection] = await Promise.all([listMyHoldings(db, user.id, at, mode), listMyPositions(db, user.id), listLatestQuotes(db, at, { publishedOnly: true }), mode === 'LIVE' ? connectionFor(db, user.id) : null]);
  const closed = all.filter((p) => p.status === 'CLOSED' && p.mode === mode).sort((a, b) => Date.parse(b.closedAt ?? b.openedAt) - Date.parse(a.closedAt ?? a.openedAt));
  return (
    <PageContainer
      title="My Holdings"
      description="Your positions with live prices, unrealized P&L and stop protection. Select a holding for its fills and chart."
      scope={`${user.name} · My Account · ${mode === 'LIVE' ? 'Live — your MEXC Futures account' : 'Paper — simulated'}`}
      actions={<ModeTabs mode={mode} path="/my-holdings" />}
    >
      {mode === 'LIVE' && connection && connection.status !== 'REVOKED' && (
        <SyncWithMexcButton
          lastSyncOkAt={connection.lastSyncOkAt?.toISOString() ?? null}
          lastSyncAt={connection.lastSyncAt?.toISOString() ?? null}
          lastSyncError={connection.lastSyncError}
          drift={(connection.drift ?? []) as { kind: string; symbol: string; detail: string }[]}
          timezone={user.timezone}
        />
      )}
      <HoldingsClient open={open} closed={closed} quotes={quotes} timezone={user.timezone} mode={mode} />
    </PageContainer>
  );
}
