import Link from 'next/link';
import { FlaskConicalIcon, HourglassIcon, ListChecksIcon, ShieldCheckIcon, ShieldAlertIcon, ZapIcon } from 'lucide-react';
import { connectionFor, getDb, getMyPaperAccount, listMyOrders, listMyPositions } from '@trendpilot/db';
import { PageContainer } from '@/components/layout/PageContainer';
import { EmptyState } from '@/components/ui/EmptyState';
import { StatusPill } from '@/components/ui/StatusPill';
import { ClosePositionButton } from '@/components/trades/ClosePositionButton';
import { SyncWithMexcButton } from '@/components/trades/SyncWithMexcButton';
import { EXIT_LABEL, signedUsdt as signed, TARGET_STATUS_LABEL, TRAILING_STATUS_LABEL, targetSummary, trailingName } from '@/lib/exitLabels';
import { requirePageRole } from '@/server/pageSession';
import { ModeTabs, viewModeOf } from '@/components/ui/ModeTabs';

export const dynamic = 'force-dynamic';

/** The position's own stored mode, never the page's: a Live position is never labelled Paper. */
function ModeBadge({ mode }: { mode: string }) {
  return mode === 'LIVE' ? (
    <StatusPill tone="warn" icon={ZapIcon}>
      Live
    </StatusPill>
  ) : (
    <StatusPill tone="accent" icon={FlaskConicalIcon}>
      Paper
    </StatusPill>
  );
}

const usdt = (v: string) => `${Number(v).toLocaleString('en-US', { maximumFractionDigits: 4 })} USDT`;

/** UI-04 My Trades: the signed-in investor's own positions and orders only, Paper or Live (separately). */
export default async function MyTradesPage({ searchParams }: { searchParams: Promise<{ mode?: string }> }) {
  const { user } = await requirePageRole('INVESTOR');
  const mode = viewModeOf((await searchParams).mode);
  const live = mode === 'LIVE';
  const db = getDb();
  const [account, allPositions, allOrders, connection] = await Promise.all([getMyPaperAccount(db, user.id, mode), listMyPositions(db, user.id), listMyOrders(db, user.id), live ? connectionFor(db, user.id) : null]);
  const positions = allPositions.filter((p) => p.mode === mode);
  const orders = allOrders.filter((o) => o.mode === mode);
  const open = positions.filter((p) => p.status !== 'CLOSED');
  const closed = positions.filter((p) => p.status === 'CLOSED');
  const fmt = (iso: string) => new Date(iso).toLocaleString('en-GB', { timeZone: user.timezone, dateStyle: 'medium', timeStyle: 'short' });

  return (
    <PageContainer
      title="My Trades"
      description={`${live ? 'Live' : 'Paper'} positions opened from shared signals with your own settings, each with its attached stop loss.`}
      scope={
        live
          ? `${user.name} · My Account · Live — real orders and fills on your own MEXC Futures account.`
          : `${user.name} · My Account · Paper — simulated orders and fills on fixture or public MEXC prices. No order reaches a real exchange.`
      }
      actions={<ModeTabs mode={mode} path="/my-trades" />}
    >
      {live && connection && connection.status !== 'REVOKED' && (
        <SyncWithMexcButton
          lastSyncOkAt={connection.lastSyncOkAt?.toISOString() ?? null}
          lastSyncAt={connection.lastSyncAt?.toISOString() ?? null}
          lastSyncError={connection.lastSyncError}
          drift={(connection.drift ?? []) as { kind: string; symbol: string; detail: string }[]}
          timezone={user.timezone}
        />
      )}

      {account && (
        <dl className="grid gap-3 rounded-xl border border-line bg-surface p-4 text-sm sm:grid-cols-4" data-testid="paper-balance">
          <div>
            <dt className="text-xs text-subtle">{live ? 'Live wallet (MEXC, synced)' : 'Paper wallet'}</dt>
            <dd className="text-ink">{usdt(account.walletBalanceUsdt)}</dd>
          </div>
          <div>
            <dt className="text-xs text-subtle">Position margin</dt>
            <dd className="text-ink">{usdt(account.positionMarginUsdt)}</dd>
          </div>
          <div>
            <dt className="text-xs text-subtle">Reserved for orders</dt>
            <dd className="text-ink">{usdt(account.orderReserveUsdt)}</dd>
          </div>
          <div>
            <dt className="text-xs text-subtle">Available</dt>
            <dd className="font-semibold text-ink">{usdt(account.availableUsdt)}</dd>
          </div>
        </dl>
      )}

      {open.length === 0 ? (
        <EmptyState
          icon={ListChecksIcon}
          title={live ? 'No open Live positions' : 'No open paper positions'}
          body={live ? 'When Live is active and a shared signal passes every entry and Live check, the MEXC position and its stop appear here.' : 'When a shared signal passes all your entry checks, the simulated position and its stop appear here.'}
        />
      ) : (
        <div className="overflow-x-auto rounded-xl border border-line bg-surface">
          <table className="w-full min-w-[980px] text-left text-sm">
            <thead className="border-b border-line text-xs text-subtle">
              <tr>
                <th className="px-4 py-2.5 font-medium">Opened ({user.timezone})</th>
                <th className="px-4 py-2.5 font-medium">Pair</th>
                <th className="px-4 py-2.5 font-medium">Side</th>
                <th className="px-4 py-2.5 font-medium">Contracts · qty</th>
                <th className="px-4 py-2.5 font-medium">Avg entry</th>
                <th className="px-4 py-2.5 font-medium">Margin · lev</th>
                <th className="px-4 py-2.5 font-medium">Stop loss</th>
                <th className="px-4 py-2.5 font-medium">Take profit · trailing take profit</th>
                <th className="px-4 py-2.5 font-medium">Liq. (est.)</th>
                <th className="px-4 py-2.5 font-medium" />
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {open.map((p) => (
                <tr key={p.id} data-testid={`position-${p.symbol}`} data-protection={p.stop.protection} data-contracts={p.contracts} data-mode={p.mode} data-exchange-close={p.venueSync?.closeState ?? ''}>
                  <td className="whitespace-nowrap px-4 py-2.5 text-muted">{fmt(p.openedAt)}</td>
                  <td className="px-4 py-2.5 text-ink">
                    {p.symbol} <ModeBadge mode={p.mode} />
                    {p.venueSync?.closeState === 'FILLS_PENDING' && (
                      <span className="mt-1 block" data-testid="fills-pending">
                        <StatusPill tone="warn" icon={HourglassIcon}>
                          {p.venueSync.contracts === '0' ? 'Closed on MEXC · fill details pending' : `MEXC holds ${p.venueSync.contracts} · fill details pending`}
                        </StatusPill>
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2.5">
                    <StatusPill tone={p.side === 'LONG' ? 'gain' : 'loss'}>{p.side === 'LONG' ? 'Long' : 'Short'}</StatusPill>
                  </td>
                  <td className="px-4 py-2.5 text-muted tabular-nums" data-testid="remaining">
                    {p.contracts} · {p.quantity}
                    {p.contracts !== p.initialContracts && (
                      <span className="block text-xs text-subtle">
                        of {p.initialContracts} opened · realized {signed(p.netRealizedUsdt)}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2.5 text-ink tabular-nums" data-testid="avg-entry">
                    {p.avgEntryPrice}
                  </td>
                  <td className="px-4 py-2.5 text-muted tabular-nums">
                    {usdt(p.marginUsdt)} · {p.leverage}× {p.marginMode === 'ISOLATED' ? 'isolated' : 'cross'}
                  </td>
                  <td className="px-4 py-2.5 tabular-nums" data-testid="stop">
                    <span className="text-ink">{p.stop.price}</span> <span className="text-xs text-subtle">({p.stop.basis.toLowerCase()})</span>
                    <span className="block">
                      {p.stop.protection === 'PROTECTED' ? (
                        <StatusPill tone="gain" icon={ShieldCheckIcon}>
                          Protected · covers {p.stop.contracts}
                        </StatusPill>
                      ) : (
                        <StatusPill tone="loss" icon={ShieldAlertIcon}>
                          {p.stop.protection}
                          {p.stop.protection === 'UNPROTECTED' && ` · stop covers ${p.stop.contracts ?? 0} of ${p.contracts}`}
                        </StatusPill>
                      )}
                    </span>
                  </td>
                  <td className="px-4 py-2.5 tabular-nums text-ink" data-testid="take-profit">
                    {p.targets.length === 0 ? (
                      <span className="text-subtle">TP off</span>
                    ) : (
                      <span className="block" data-testid="target-progress">
                        {targetSummary(p.targets)}
                        <span className="block text-xs text-subtle">
                          {p.targets.map((t) => `${t.triggerPrice} ${TARGET_STATUS_LABEL[t.status]?.toLowerCase() ?? t.status} ${t.filledContracts}/${t.plannedContracts}`).join(' · ')}
                        </span>
                      </span>
                    )}
                    {p.trailing && (
                      <span className="block text-xs" data-testid="trailing" data-status={p.trailing.status} data-kind={p.trailing.kind}>
                        <span className="text-subtle">{trailingName(p.trailing.kind)}: </span>
                        {p.trailing.status === 'ACTIVE' ? (
                          <span className="text-ink">
                            Active · closes at {p.trailing.level} (best {p.trailing.watermark})
                          </span>
                        ) : p.trailing.status === 'WAITING' ? (
                          <span className="text-ink">{p.trailing.activationPrice ? `Waiting for activation at ${p.trailing.activationPrice}` : 'Waiting for activation'}</span>
                        ) : (
                          <span className="text-ink">{TRAILING_STATUS_LABEL[p.trailing.status] ?? p.trailing.status}</span>
                        )}
                        {p.trailing.contracts !== null && <span className="text-subtle"> · {p.trailing.contracts} contracts</span>}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2.5 text-xs text-muted tabular-nums">{p.liquidationEstimate}</td>
                  <td className="space-y-1 px-4 py-2.5">
                    <Link href={`/my-trades/${p.id}`} className="block text-sm font-semibold text-accent hover:underline">
                      Details
                    </Link>
                    {p.venueSync?.closeState !== 'FILLS_PENDING' && <ClosePositionButton positionId={p.id} symbol={p.symbol} side={p.side} contracts={p.contracts} />}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {closed.length > 0 && (
        <section className="space-y-2">
          <h3 className="text-sm font-semibold text-ink">Closed {live ? 'Live' : 'paper'} positions</h3>
          <div className="overflow-x-auto rounded-xl border border-line bg-surface">
            <table className="w-full min-w-[900px] text-left text-sm">
              <thead className="border-b border-line text-xs text-subtle">
                <tr>
                  <th className="px-4 py-2.5 font-medium">Closed ({user.timezone})</th>
                  <th className="px-4 py-2.5 font-medium">Pair</th>
                  <th className="px-4 py-2.5 font-medium">Side</th>
                  <th className="px-4 py-2.5 font-medium">Exit reason</th>
                  <th className="px-4 py-2.5 font-medium">Opened · remaining</th>
                  <th className="px-4 py-2.5 font-medium">Avg entry</th>
                  <th className="px-4 py-2.5 font-medium">Realized P&amp;L</th>
                  <th className="px-4 py-2.5 font-medium">Fees</th>
                  <th className="px-4 py-2.5 font-medium">Net</th>
                  <th className="px-4 py-2.5 font-medium" />
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {closed.map((p) => (
                  <tr key={p.id} data-testid={`closed-${p.symbol}`} data-reason={p.closeReason ?? ''}>
                    <td className="whitespace-nowrap px-4 py-2.5 text-muted">{p.closedAt ? fmt(p.closedAt) : '—'}</td>
                    <td className="px-4 py-2.5 text-ink">
                      {p.symbol} <ModeBadge mode={p.mode} />
                    </td>
                    <td className="px-4 py-2.5">
                      <StatusPill tone={p.side === 'LONG' ? 'gain' : 'loss'}>{p.side === 'LONG' ? 'Long' : 'Short'}</StatusPill>
                    </td>
                    <td className="px-4 py-2.5 text-ink" data-testid="exit-reason">
                      {EXIT_LABEL[p.closeReason ?? ''] ?? p.closeReason}
                      {p.venueSync?.closeState === 'FILLS_PENDING' && (
                        <span className="mt-1 block" data-testid="fills-pending">
                          <StatusPill tone="warn" icon={HourglassIcon}>
                            Closed on MEXC · fill details pending
                          </StatusPill>
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-muted tabular-nums" data-testid="remaining">
                      {p.initialContracts} · {p.contracts}
                    </td>
                    <td className="px-4 py-2.5 text-muted tabular-nums">{p.avgEntryPrice}</td>
                    <td className={`px-4 py-2.5 tabular-nums ${Number(p.realizedPnlUsdt) >= 0 ? 'text-gain' : 'text-loss'}`} data-testid="realized-pnl">
                      {p.venueSync?.closeState === 'FILLS_PENDING' ? <span className="text-subtle">Pending</span> : signed(p.realizedPnlUsdt)}
                    </td>
                    <td className="px-4 py-2.5 text-muted tabular-nums">{usdt(p.feesUsdt)}</td>
                    <td className={`px-4 py-2.5 font-semibold tabular-nums ${Number(p.netRealizedUsdt) >= 0 ? 'text-gain' : 'text-loss'}`} data-testid="net-pnl">
                      {signed(p.netRealizedUsdt)}
                    </td>
                    <td className="px-4 py-2.5">
                      <Link href={`/my-trades/${p.id}`} className="text-sm font-semibold text-accent hover:underline">
                        Details
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-subtle">
            Realized P&amp;L and released margin come from confirmed {live ? 'MEXC' : 'simulated'} fills{live ? ', including closes made directly on MEXC' : ''}. Fees include the opening and closing fees.
          </p>
        </section>
      )}

      <section className="space-y-2">
        <h3 className="text-sm font-semibold text-ink">{live ? 'Live' : 'Paper'} orders</h3>
        <ul className="divide-y divide-line rounded-xl border border-line bg-surface text-sm">
          {orders.map((o) => (
            <li key={o.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2" data-testid="paper-order" data-state={o.state}>
              <span className="text-muted">{fmt(o.createdAt)}</span>
              <span className="text-ink">
                {o.kind} {o.side} {o.symbol} · {o.kind === 'CLOSE' ? `${o.filledContracts}/${o.contracts}` : o.contracts} contracts
                {o.exitReason && <span className="text-subtle"> · {EXIT_LABEL[o.exitReason] ?? o.exitReason}</span>}
              </span>
              <StatusPill tone={o.state === 'FILLED' ? 'gain' : o.state === 'CANCELLED' || o.state === 'EXPIRED' || o.state === 'REJECTED' ? 'neutral' : 'warn'}>{o.state}</StatusPill>
              {o.stateReason && <span className="text-xs text-subtle">{o.stateReason}</span>}
              <span className="font-mono text-xs text-subtle">{o.clientOrderId}</span>
            </li>
          ))}
          {orders.length === 0 && <li className="px-4 py-3 text-subtle">No {live ? 'Live' : 'paper'} orders yet.</li>}
        </ul>
      </section>
    </PageContainer>
  );
}
