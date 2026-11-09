import Link from 'next/link';
import { FlaskConicalIcon, ListChecksIcon, ShieldCheckIcon, ShieldAlertIcon } from 'lucide-react';
import { getDb, getMyPaperAccount, listMyOrders, listMyPositions } from '@trendpilot/db';
import { PageContainer } from '@/components/layout/PageContainer';
import { EmptyState } from '@/components/ui/EmptyState';
import { StatusPill } from '@/components/ui/StatusPill';
import { ClosePositionButton } from '@/components/trades/ClosePositionButton';
import { EXIT_LABEL, signedUsdt as signed, TARGET_STATUS_LABEL, targetSummary } from '@/lib/exitLabels';
import { requirePageRole } from '@/server/pageSession';

export const dynamic = 'force-dynamic';

const usdt = (v: string) => `${Number(v).toLocaleString('en-US', { maximumFractionDigits: 4 })} USDT`;

/** UI-04 My Trades (paper): the signed-in investor's own positions and orders only. */
export default async function MyTradesPage() {
  const { user } = await requirePageRole('INVESTOR');
  const db = getDb();
  const [account, positions, orders] = await Promise.all([getMyPaperAccount(db, user.id), listMyPositions(db, user.id), listMyOrders(db, user.id)]);
  const open = positions.filter((p) => p.status !== 'CLOSED');
  const closed = positions.filter((p) => p.status === 'CLOSED');
  const fmt = (iso: string) => new Date(iso).toLocaleString('en-GB', { timeZone: user.timezone, dateStyle: 'medium', timeStyle: 'short' });

  return (
    <PageContainer
      title="My Trades"
      description="Paper positions opened from shared signals with your own settings, each with its attached stop loss."
      scope={`${user.name} · My Account · Paper — simulated orders and fills on fixture or public MEXC prices. No order reaches a real exchange.`}
    >
      {account && (
        <dl className="grid gap-3 rounded-xl border border-line bg-surface p-4 text-sm sm:grid-cols-4" data-testid="paper-balance">
          <div>
            <dt className="text-xs text-subtle">Paper wallet</dt>
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
        <EmptyState icon={ListChecksIcon} title="No open paper positions" body="When a shared signal passes all your entry checks, the simulated position and its stop appear here." />
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
                <th className="px-4 py-2.5 font-medium">Take profit · trailing</th>
                <th className="px-4 py-2.5 font-medium">Liq. (est.)</th>
                <th className="px-4 py-2.5 font-medium" />
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {open.map((p) => (
                <tr key={p.id} data-testid={`position-${p.symbol}`} data-protection={p.stop.protection} data-contracts={p.contracts}>
                  <td className="whitespace-nowrap px-4 py-2.5 text-muted">{fmt(p.openedAt)}</td>
                  <td className="px-4 py-2.5 text-ink">
                    {p.symbol}{' '}
                    <StatusPill tone="accent" icon={FlaskConicalIcon}>
                      Paper
                    </StatusPill>
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
                      <span className="block text-xs" data-testid="trailing" data-status={p.trailing.status}>
                        {p.trailing.status === 'ACTIVE' ? (
                          <span className="text-ink">Trailing {p.trailing.level} (best {p.trailing.watermark})</span>
                        ) : (
                          <span className="text-subtle">Trailing from {p.trailing.activationPrice}</span>
                        )}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2.5 text-xs text-muted tabular-nums">{p.liquidationEstimate}</td>
                  <td className="space-y-1 px-4 py-2.5">
                    <Link href={`/my-trades/${p.id}`} className="block text-sm font-semibold text-accent hover:underline">
                      Details
                    </Link>
                    <ClosePositionButton positionId={p.id} symbol={p.symbol} side={p.side} contracts={p.contracts} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {closed.length > 0 && (
        <section className="space-y-2">
          <h3 className="text-sm font-semibold text-ink">Closed paper positions</h3>
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
                      {p.symbol}{' '}
                      <StatusPill tone="accent" icon={FlaskConicalIcon}>
                        Paper
                      </StatusPill>
                    </td>
                    <td className="px-4 py-2.5">
                      <StatusPill tone={p.side === 'LONG' ? 'gain' : 'loss'}>{p.side === 'LONG' ? 'Long' : 'Short'}</StatusPill>
                    </td>
                    <td className="px-4 py-2.5 text-ink" data-testid="exit-reason">
                      {EXIT_LABEL[p.closeReason ?? ''] ?? p.closeReason}
                    </td>
                    <td className="px-4 py-2.5 text-muted tabular-nums" data-testid="remaining">
                      {p.initialContracts} · {p.contracts}
                    </td>
                    <td className="px-4 py-2.5 text-muted tabular-nums">{p.avgEntryPrice}</td>
                    <td className={`px-4 py-2.5 tabular-nums ${Number(p.realizedPnlUsdt) >= 0 ? 'text-gain' : 'text-loss'}`} data-testid="realized-pnl">
                      {signed(p.realizedPnlUsdt)}
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
          <p className="text-xs text-subtle">Realized P&amp;L and released margin come from confirmed simulated fills. Fees include the opening and closing fees.</p>
        </section>
      )}

      <section className="space-y-2">
        <h3 className="text-sm font-semibold text-ink">Paper orders</h3>
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
          {orders.length === 0 && <li className="px-4 py-3 text-subtle">No paper orders yet.</li>}
        </ul>
      </section>
    </PageContainer>
  );
}
