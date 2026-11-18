import { connectionFor, getDb, getMyPaperAccount, listBitunixExchangeOnlyLegs, listLatestQuotes, listMyHoldings, listMyPositions } from '@trendpilot/db';
import { HoldingsClient } from '@/components/holdings/HoldingsClient';
import { SyncWithMexcButton } from '@/components/trades/SyncWithMexcButton';
import { PageContainer } from '@/components/layout/PageContainer';
import { ExchangeTabs, ModeTabs, paperExchangeOf, viewExchangeOf, viewModeOf, liveViewExchanges } from '@/components/ui/ModeTabs';
import { now } from '@/server/clock';
import { requirePageRole } from '@/server/pageSession';

export const dynamic = 'force-dynamic';

/** My Holdings: the signed-in investor's own positions only (owner-scoped read models). */
export default async function MyHoldingsPage({ searchParams }: { searchParams: Promise<{ mode?: string; exchange?: string }> }) {
  const { user } = await requirePageRole('INVESTOR');
  const sp = await searchParams;
  const mode = viewModeOf(sp.mode);
  // Live is per exchange (its own account and connection); Paper per simulator account (MEXC USDT, Lighter USDC).
  const exchange = mode === 'LIVE' ? viewExchangeOf(sp.exchange) : paperExchangeOf(sp.exchange);
  const db = getDb();
  const at = now();
  const [open, all, quotes, connection, bitunix, lighterPaper, lighter] = await Promise.all([
    listMyHoldings(db, user.id, at, mode, exchange),
    listMyPositions(db, user.id),
    listLatestQuotes(db, at, { publishedOnly: true }),
    mode === 'LIVE' ? connectionFor(db, user.id, exchange) : null,
    connectionFor(db, user.id, 'BITUNIX'),
    getMyPaperAccount(db, user.id, 'PAPER', 'LIGHTER'),
    connectionFor(db, user.id, 'LIGHTER')
  ]);
  const liveOptions = liveViewExchanges({ bitunix, lighter });
  const closed = all.filter((p) => p.status === 'CLOSED' && p.mode === mode && p.exchange === exchange).sort((a, b) => Date.parse(b.closedAt ?? b.openedAt) - Date.parse(a.closedAt ?? a.openedAt));
  const showExchanges = mode === 'LIVE' ? liveOptions.length > 1 : !!lighterPaper || exchange === 'LIGHTER';
  // Bitunix Hedge legs TrendPilot does not manage (the other leg, or opened on Bitunix): read-only.
  const otherLegs = mode === 'LIVE' && exchange === 'BITUNIX' ? await listBitunixExchangeOnlyLegs(db, user.id) : [];
  return (
    <PageContainer
      title="My Holdings"
      description="Your positions with live prices, unrealized P&L and stop protection. Select a holding for its fills and chart."
      scope={`${user.name} · My Account · ${mode === 'LIVE' ? `Live — your ${exchange === 'BITUNIX' ? 'Bitunix Futures' : exchange === 'LIGHTER' ? 'Lighter (USDC)' : 'MEXC Futures'} account` : exchange === 'LIGHTER' ? 'Paper (Lighter, USDC) — simulated on Lighter public prices' : 'Paper — simulated'}`}
      actions={
        <div className="flex flex-wrap gap-2">
          {showExchanges && <ExchangeTabs options={mode === 'LIVE' ? liveOptions : undefined} exchange={exchange} path="/my-holdings" mode={mode} />}
          <ModeTabs mode={mode} path="/my-holdings" />
        </div>
      }
    >
      {mode === 'LIVE' && exchange === 'BITUNIX' && connection && connection.status !== 'REVOKED' && (
        <p className="mb-3 text-xs text-subtle" data-testid="bitunix-sync-note">
          Bitunix account last synced {connection.lastSyncOkAt ? connection.lastSyncOkAt.toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : 'never'}
          {connection.lastSyncError ? ` · latest attempt failed: ${connection.lastSyncError}` : ''}. Sync from Live Trading → Bitunix Futures connection.
        </p>
      )}
      {mode === 'LIVE' && exchange === 'MEXC' && connection && connection.status !== 'REVOKED' && (
        <SyncWithMexcButton
          lastSyncOkAt={connection.lastSyncOkAt?.toISOString() ?? null}
          lastSyncAt={connection.lastSyncAt?.toISOString() ?? null}
          lastSyncError={connection.lastSyncError}
          drift={(connection.drift ?? []) as { kind: string; symbol: string; detail: string }[]}
          timezone={user.timezone}
        />
      )}
      <HoldingsClient open={open} closed={closed} quotes={quotes} timezone={user.timezone} mode={mode} currency={exchange === 'LIGHTER' ? 'USDC' : 'USDT'} />
      {mode === 'LIVE' && exchange === 'BITUNIX' && (
        <section className="mt-6 rounded-xl border border-line bg-surface" data-testid="bitunix-other-legs">
          <h3 className="border-b border-line px-4 py-3 text-sm font-semibold text-ink">Other Bitunix legs (not managed by TrendPilot)</h3>
          {otherLegs.length === 0 ? (
            <p className="px-4 py-3 text-sm text-muted">None: every open Bitunix leg in your account is a TrendPilot position above.</p>
          ) : (
            <table className="w-full text-left text-sm">
              <thead className="text-xs text-subtle">
                <tr>
                  <th className="px-4 py-2 font-normal">Contract</th>
                  <th className="px-4 py-2 font-normal">Side</th>
                  <th className="px-4 py-2 font-normal">Quantity</th>
                  <th className="px-4 py-2 font-normal">Entry</th>
                  <th className="px-4 py-2 font-normal">Liquidation (Bitunix est.)</th>
                  <th className="px-4 py-2 font-normal">Funding total (as reported)</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {otherLegs.map((l) => (
                  <tr key={l.exchangePositionId} data-testid={`bitunix-leg-${l.exchangePositionId}`}>
                    <td className="px-4 py-2 text-ink">
                      Bitunix · <span className="font-mono">{l.symbol}</span>
                    </td>
                    <td className="px-4 py-2">{l.side === 'LONG' ? 'Long' : 'Short'}</td>
                    <td className="px-4 py-2 font-mono">{l.qty}</td>
                    <td className="px-4 py-2 font-mono">{l.avgOpenPrice ?? '—'}</td>
                    <td className="px-4 py-2 font-mono">{l.liqPrice ?? '—'}</td>
                    <td className="px-4 py-2 font-mono">{l.reportedFunding ?? 'unknown'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      )}
    </PageContainer>
  );
}
