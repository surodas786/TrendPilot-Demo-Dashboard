import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getDb, getMyTrade } from '@trendpilot/db';
import { PageContainer } from '@/components/layout/PageContainer';
import { StatusPill } from '@/components/ui/StatusPill';
import { ClosePositionButton } from '@/components/trades/ClosePositionButton';
import { EXIT_LABEL, signedUsdt, TARGET_STATUS_LABEL } from '@/lib/exitLabels';
import { requirePageRole } from '@/server/pageSession';

export const dynamic = 'force-dynamic';

function Row({ label, value, testId }: { label: string; value: React.ReactNode; testId?: string }) {
  return (
    <div className="flex justify-between gap-4 py-1">
      <dt className="text-subtle">{label}</dt>
      <dd className="text-right text-ink tabular-nums" data-testid={testId}>
        {value}
      </dd>
    </div>
  );
}

/** UI-04 trade detail (paper). Owner-scoped: another investor's position ID is a 404 page. */
export default async function TradeDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { user } = await requirePageRole('INVESTOR');
  const { id } = await params;
  const t = await getMyTrade(getDb(), user.id, id);
  if (!t) notFound();
  const fmt = (iso: string) => new Date(iso).toLocaleString('en-GB', { timeZone: user.timezone });

  return (
    <PageContainer title={`${t.symbol} ${t.side === 'LONG' ? 'Long' : 'Short'} · Paper`} description="Simulated position with its exchange-hosted (simulated) stop loss." scope={`${user.name} · My Account`}>
      <p>
        <Link href="/my-trades" className="text-sm text-accent hover:underline">
          ← My Trades
        </Link>
      </p>
      {t.status !== 'CLOSED' && (
        <div>
          <ClosePositionButton positionId={t.id} symbol={t.symbol} side={t.side} contracts={t.contracts} />
        </div>
      )}
      <div className="grid gap-4 lg:grid-cols-2">
        <section className="rounded-xl border border-line bg-surface p-4 text-sm">
          <h3 className="mb-2 font-semibold text-ink">Position</h3>
          <dl>
            <Row label="Status" value={t.status} testId="position-status" />
            {t.closeReason && <Row label="Exit reason" value={EXIT_LABEL[t.closeReason] ?? t.closeReason} testId="exit-reason" />}
            <Row label="Remaining contracts" value={`${t.contracts} of ${t.initialContracts}`} testId="remaining" />
            <Row label="Quantity" value={t.quantity} />
            <Row label="Average entry" value={t.avgEntryPrice} />
            <Row label="Leverage · margin mode" value={`${t.leverage}× · ${t.marginMode}`} />
            <Row label="Margin" value={`${t.marginUsdt} USDT`} />
            <Row label="Liquidation (estimate, isolated)" value={t.liquidationEstimate} />
            <Row label="Realized P&L (gross)" value={signedUsdt(t.realizedPnlUsdt)} testId="realized-pnl" />
            <Row label="Fees (open + close)" value={`${t.feesUsdt} USDT`} />
            <Row label="Net realized" value={signedUsdt(t.netRealizedUsdt)} testId="net-pnl" />
            <Row label="Opened" value={fmt(t.openedAt)} />
            {t.closedAt && <Row label="Closed" value={fmt(t.closedAt)} />}
          </dl>
        </section>
        <section className="rounded-xl border border-line bg-surface p-4 text-sm" data-testid="stop-detail">
          <h3 className="mb-2 flex items-center gap-2 font-semibold text-ink">
            Stop loss <StatusPill tone={t.stop.protection === 'PROTECTED' ? 'gain' : 'loss'}>{t.stop.protection}</StatusPill>
          </h3>
          <dl>
            <Row label="Trigger price" value={t.stop.price} testId="stop-price" />
            <Row label="Trigger basis" value={t.stop.basis === 'MARK' ? 'Mark price' : 'Last price'} />
            <Row label="Covers contracts" value={t.stop.contracts ?? '—'} testId="stop-contracts" />
            <Row label="Venue order" value={<span className="font-mono text-xs">{t.stop.orderRef}</span>} />
            <Row label="Verified" value={t.stop.verifiedAt ? fmt(t.stop.verifiedAt) : 'not verified'} />
          </dl>
          <p className="mt-2 text-xs text-subtle">Sent in the same simulated opening request as the entry and verified against the filled quantity.</p>
        </section>
        <section className="rounded-xl border border-line bg-surface p-4 text-sm">
          <h3 className="mb-2 font-semibold text-ink">Opening order</h3>
          <dl>
            <Row label="State" value={t.order.state} />
            <Row label="Client order ID" value={<span className="font-mono text-xs">{t.order.clientOrderId}</span>} />
            <Row label="Expected price" value={t.order.expectedPrice} />
            <Row label="Reserved" value={`${t.order.reservedUsdt} USDT`} />
            <Row label="Submitted" value={t.order.submittedAt ? fmt(t.order.submittedAt) : '—'} />
          </dl>
          <h4 className="mt-3 text-xs font-semibold text-subtle">Fills</h4>
          <ul className="mt-1 space-y-1 text-xs text-muted">
            {t.order.fills.map((f) => (
              <li key={f.id} data-testid="fill">
                {f.contracts} @ {f.price} · fee {f.feeUsdt} USDT · {fmt(f.filledAt)} · <span className="font-mono">{f.exchangeFillId}</span>
              </li>
            ))}
          </ul>
        </section>
        {(t.reversal || t.reversedFromPositionId) && (
          <section className="rounded-xl border border-line bg-surface p-4 text-sm lg:col-span-2" data-testid="reversal" data-status={t.reversal?.status ?? 'FROM'}>
            <h3 className="mb-2 font-semibold text-ink">Close and reverse</h3>
            {t.reversedFromPositionId && (
              <p className="text-muted">
                Opened by a reversal after the previous position was confirmed closed.{' '}
                <Link href={`/my-trades/${t.reversedFromPositionId}`} className="font-semibold text-accent hover:underline">
                  View the closed position
                </Link>
              </p>
            )}
            {t.reversal && (
              <p className="text-muted">
                {t.reversal.status === 'ENTRY_APPROVED' ? (
                  <StatusPill tone="gain">Reversed into a paper {t.reversal.side === 'LONG' ? 'Long' : 'Short'} · {(t.reversal.orderState ?? 'pending').toLowerCase()}</StatusPill>
                ) : t.reversal.status === 'SKIPPED' ? (
                  <StatusPill tone="neutral">Stayed flat · {t.reversal.reason}</StatusPill>
                ) : (
                  <StatusPill tone="warn">Opening leg pending</StatusPill>
                )}{' '}
                <span data-testid="reversal-reason">{t.reversal.reasonText}</span>{' '}
                {t.reversal.positionId && (
                  <Link href={`/my-trades/${t.reversal.positionId}`} className="font-semibold text-accent hover:underline">
                    View the new position
                  </Link>
                )}
              </p>
            )}
          </section>
        )}
        <section className="rounded-xl border border-line bg-surface p-4 text-sm" data-testid="targets">
          <h3 className="mb-2 font-semibold text-ink">Take-profit targets</h3>
          {t.targets.length === 0 ? (
            <p className="text-xs text-subtle">Take profit is off for this position.</p>
          ) : (
            <table className="w-full text-left text-xs">
              <thead className="text-subtle">
                <tr>
                  <th className="py-1 font-medium">Target</th>
                  <th className="py-1 font-medium">Trigger</th>
                  <th className="py-1 font-medium">Planned</th>
                  <th className="py-1 font-medium">Requested</th>
                  <th className="py-1 font-medium">Filled</th>
                  <th className="py-1 font-medium">Status</th>
                </tr>
              </thead>
              <tbody className="tabular-nums text-muted">
                {t.targets.map((x) => (
                  <tr key={x.levelId} data-testid="target" data-level={x.levelId} data-status={x.status}>
                    <td className="py-1 text-ink">
                      {x.ordinal}. {x.levelId} <span className="text-subtle">(+{x.movePct}% · {x.closePct}%)</span>
                    </td>
                    <td className="py-1">
                      {x.triggerPrice} <span className="text-subtle">{x.basis.toLowerCase()}</span>
                    </td>
                    <td className="py-1">{x.plannedContracts}</td>
                    <td className="py-1">{x.requestedContracts}</td>
                    <td className="py-1" data-testid="target-filled">
                      {x.filledContracts}
                    </td>
                    <td className="py-1 text-ink">{TARGET_STATUS_LABEL[x.status] ?? x.status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <p className="mt-2 text-xs text-subtle">Each target closes its share of the opening quantity with a reduce-only market order. Only confirmed fills count; the stop is resized after each fill.</p>
        </section>
        <section className="rounded-xl border border-line bg-surface p-4 text-sm" data-testid="trailing-detail" data-status={t.trailing?.status ?? 'OFF'}>
          <h3 className="mb-2 font-semibold text-ink">Trailing stop</h3>
          {!t.trailing ? (
            <p className="text-xs text-subtle">Trailing is off for this position.</p>
          ) : (
            <dl>
              <Row label="State" value={t.trailing.status === 'ACTIVE' ? 'Active' : 'Waiting for activation'} />
              <Row label="Activation price" value={t.trailing.activationPrice ?? 'from entry'} />
              <Row label="Distance · basis" value={`${t.trailing.distancePct}% · ${t.trailing.basis === 'MARK' ? 'mark price' : 'last price'}`} />
              <Row label={t.side === 'LONG' ? 'Highest since activation' : 'Lowest since activation'} value={t.trailing.watermark ?? '—'} testId="trailing-watermark" />
              <Row label="Trailing level (only tightens)" value={t.trailing.level ?? '—'} testId="trailing-level" />
              <Row label="Activated" value={t.trailing.activatedAt ? fmt(t.trailing.activatedAt) : '—'} />
            </dl>
          )}
          <p className="mt-2 text-xs text-subtle">A software trigger closes the remaining quantity at market; the original stop stays at the venue as protection.</p>
        </section>
        <section className="rounded-xl border border-line bg-surface p-4 text-sm lg:col-span-2" data-testid="exits">
          <h3 className="mb-2 font-semibold text-ink">Exits</h3>
          {t.exits.length === 0 ? (
            <p className="text-xs text-subtle">No exit fills yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[720px] text-left text-xs">
                <thead className="text-subtle">
                  <tr>
                    <th className="py-1 font-medium">Filled</th>
                    <th className="py-1 font-medium">Reason</th>
                    <th className="py-1 font-medium">Contracts</th>
                    <th className="py-1 font-medium">Price</th>
                    <th className="py-1 font-medium">Realized P&amp;L</th>
                    <th className="py-1 font-medium">Fee</th>
                    <th className="py-1 font-medium">Margin released</th>
                    <th className="py-1 font-medium">Remaining</th>
                  </tr>
                </thead>
                <tbody className="text-muted tabular-nums">
                  {t.exits.map((x) => (
                    <tr key={x.id} data-testid="exit" data-reason={x.reason}>
                      <td className="py-1">{fmt(x.filledAt)}</td>
                      <td className="py-1 text-ink">{EXIT_LABEL[x.reason] ?? x.reason}</td>
                      <td className="py-1">{x.contracts}</td>
                      <td className="py-1">{x.price}</td>
                      <td className={`py-1 ${Number(x.realizedPnlUsdt) >= 0 ? 'text-gain' : 'text-loss'}`}>{signedUsdt(x.realizedPnlUsdt)}</td>
                      <td className="py-1">{x.feeUsdt} USDT</td>
                      <td className="py-1">{x.marginReleasedUsdt} USDT</td>
                      <td className="py-1">{x.remainingContracts}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {t.closeOrders.length > 0 && (
            <>
              <h4 className="mt-3 text-xs font-semibold text-subtle">Close orders (reduce-only, simulated)</h4>
              <ul className="mt-1 space-y-1 text-xs text-muted">
                {t.closeOrders.map((o) => (
                  <li key={o.id} data-testid="close-order" data-state={o.state}>
                    {EXIT_LABEL[o.exitReason ?? ''] ?? o.exitReason} · {o.filledContracts}/{o.contracts} filled · {o.state}
                    {o.stateReason ? ` (${o.stateReason})` : ''} · {fmt(o.createdAt)} · <span className="font-mono">{o.clientOrderId}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
        <section className="rounded-xl border border-line bg-surface p-4 text-sm">
          <h3 className="mb-2 font-semibold text-ink">Paper ledger</h3>
          <ul className="space-y-1 text-xs">
            {t.ledger.map((l) => (
              <li key={l.id} className="flex justify-between gap-3">
                <span className="text-muted">
                  {l.kind} <span className="text-subtle">({l.bucket.toLowerCase().replace('_', ' ')})</span>
                </span>
                <span className="text-ink tabular-nums">{l.amountUsdt} USDT</span>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </PageContainer>
  );
}
