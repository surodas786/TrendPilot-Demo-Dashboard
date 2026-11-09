import Link from 'next/link';
import { BellRingIcon } from 'lucide-react';
import { getDb, listMyOutcomes, orderBlocksFor } from '@trendpilot/db';
import { PageContainer } from '@/components/layout/PageContainer';
import { EmptyState } from '@/components/ui/EmptyState';
import { StatusPill } from '@/components/ui/StatusPill';
import { requirePageRole } from '@/server/pageSession';

export const dynamic = 'force-dynamic';

const ACTION_LABEL: Record<string, string> = { BULLISH_FLIP: 'Bullish flip', BEARISH_FLIP: 'Bearish flip', CLOSE_LONG: 'Close long', CLOSE_SHORT: 'Close short' };

/** The signed-in investor's own signal outcomes (SIG-05: one private decision per investor). */
export default async function SignalsPage() {
  const { user } = await requirePageRole('INVESTOR');
  const db = getDb();
  const [outcomes, blocks] = await Promise.all([listMyOutcomes(db, user.id, 100), orderBlocksFor(db, user.id).list()]);
  const symbolOf = (id: string) => blocks.find((b) => b.id === id)?.symbol ?? '—';
  const fmt = (iso: string) => new Date(iso).toLocaleString('en-GB', { timeZone: user.timezone, dateStyle: 'medium', timeStyle: 'short' });

  return (
    <PageContainer
      title="Signals"
      description="How each shared TradingView alert was evaluated against your own order blocks."
      scope={`${user.name} · My Account · Paper — simulated orders on fixture or public MEXC prices. Live trading is disabled.`}
    >
      {outcomes.length === 0 ? (
        <EmptyState icon={BellRingIcon} title="No signal outcomes yet" body="When an approved TradingView alert matches one of your order blocks, its outcome appears here." />
      ) : (
        <div className="overflow-x-auto rounded-xl border border-line bg-surface">
          <table className="w-full min-w-[860px] text-left text-sm">
            <thead className="border-b border-line text-xs text-subtle">
              <tr>
                <th scope="col" className="px-4 py-2.5 font-medium">Bar closed ({user.timezone})</th>
                <th scope="col" className="px-4 py-2.5 font-medium">Signal</th>
                <th scope="col" className="px-4 py-2.5 font-medium">Pair</th>
                <th scope="col" className="px-4 py-2.5 font-medium">Outcome</th>
                <th scope="col" className="px-4 py-2.5 font-medium">Why</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {outcomes.map((o) => (
                <tr key={o.id} data-testid="signal-outcome" data-status={o.status} data-reason={o.reason ?? ''}>
                  <td className="whitespace-nowrap px-4 py-2.5 text-muted">{fmt(o.signal.barCloseAt)}</td>
                  <td className="px-4 py-2.5 text-ink">
                    {ACTION_LABEL[o.signal.action] ?? o.signal.action}
                    <span className="block text-xs text-subtle">
                      {o.signal.sourceExchange}:{o.signal.sourceSymbol} · {o.signal.interval}m · ref {o.signal.referencePrice}
                    </span>
                  </td>
                  <td className="px-4 py-2.5 text-muted">
                    {symbolOf(o.orderBlockId)}
                    <span className="block text-xs text-subtle">strategy v{o.strategyVersion}</span>
                  </td>
                  <td className="px-4 py-2.5" data-testid="outcome-status" data-entry={o.entry?.status ?? ''} data-entry-reason={o.entry?.reason ?? ''}>
                    {o.exit ? (
                      o.exit.status === 'EXIT_REQUESTED' ? (
                        <span className="flex flex-wrap gap-1">
                          <StatusPill tone="warn">
                            {o.exit.reason === 'REVERSAL_CLOSE' ? 'Close and reverse' : 'Paper close'} · {(o.exit.orderState ?? 'pending').toLowerCase()}
                          </StatusPill>
                          {o.exit.reason === 'REVERSAL_CLOSE' && (
                            <span data-testid="reversal-status" data-reversal={o.entry?.status ?? 'PENDING'} data-reversal-reason={o.entry?.reason ?? ''}>
                              {!o.entry ? (
                                <StatusPill tone="neutral">Opening leg pending</StatusPill>
                              ) : o.entry.status === 'ENTRY_APPROVED' ? (
                                <StatusPill tone="gain">
                                  Reversed · Paper {o.side === 'LONG' ? 'Long' : 'Short'} {o.entry.orderState === 'FILLED' ? 'filled' : (o.entry.orderState ?? 'pending').toLowerCase()}
                                </StatusPill>
                              ) : (
                                <StatusPill tone="neutral">Stayed flat · {o.entry.reason}</StatusPill>
                              )}
                            </span>
                          )}
                        </span>
                      ) : (
                        <StatusPill tone="neutral">Position kept open · {o.exit.reason}</StatusPill>
                      )
                    ) : o.status !== 'READY_FOR_EVALUATION' ? (
                      <StatusPill tone="neutral">Skipped · {o.reason}</StatusPill>
                    ) : !o.entry ? (
                      <StatusPill tone="accent">Ready for evaluation{o.side ? ` · ${o.side === 'LONG' ? 'Long' : 'Short'}` : ''}</StatusPill>
                    ) : o.entry.status === 'ENTRY_APPROVED' ? (
                      <StatusPill tone="gain">
                        Paper {o.side === 'LONG' ? 'Long' : 'Short'} · {o.entry.orderState === 'FILLED' ? 'filled' : (o.entry.orderState ?? 'pending').toLowerCase()}
                      </StatusPill>
                    ) : (
                      <StatusPill tone="neutral">Entry skipped · {o.entry.reason}</StatusPill>
                    )}
                  </td>
                  <td className="px-4 py-2.5 text-xs text-muted">
                    {o.exit ? (
                      <span>
                        {o.exit.reason === 'REVERSAL_CLOSE' && o.entry?.reasonText ? `${o.entry.reasonText} ` : (o.exit.reasonText ?? '')}{' '}
                        {o.entry?.positionId && (
                          <Link href={`/my-trades/${o.entry.positionId}`} className="mr-2 font-semibold text-accent hover:underline">
                            View new position
                          </Link>
                        )}
                        {o.exit.positionId && (
                          <Link href={`/my-trades/${o.exit.positionId}`} className="font-semibold text-accent hover:underline">
                            View position
                          </Link>
                        )}
                      </span>
                    ) : o.entry?.positionId ? (
                      <Link href={`/my-trades/${o.entry.positionId}`} className="font-semibold text-accent hover:underline">
                        View position and stop
                      </Link>
                    ) : (
                      (o.entry?.reasonText ?? o.entry?.orderStateReason ?? o.reasonText ?? 'Passed pause, direction, weekday and freshness checks.')
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </PageContainer>
  );
}
