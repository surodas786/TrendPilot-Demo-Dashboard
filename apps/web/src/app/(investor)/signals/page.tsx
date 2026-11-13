import Link from 'next/link';
import { BellRingIcon } from 'lucide-react';
import { getDb, listMyOutcomes, orderBlocksFor } from '@trendpilot/db';
import { OUTSIDE_WINDOW_TEXT } from '@trendpilot/domain';
import { PageContainer } from '@/components/layout/PageContainer';
import { EmptyState } from '@/components/ui/EmptyState';
import { StatusPill } from '@/components/ui/StatusPill';
import { requirePageRole } from '@/server/pageSession';

export const dynamic = 'force-dynamic';

const ACTION_LABEL: Record<string, string> = { BULLISH_FLIP: 'Bullish flip', BEARISH_FLIP: 'Bearish flip', CLOSE_LONG: 'Close long', CLOSE_SHORT: 'Close short' };

/** Reason codes with an investor-facing label; others show their code. */
const REASON_LABEL: Record<string, string> = { OUTSIDE_TRADING_WINDOW: OUTSIDE_WINDOW_TEXT, DAY_DISABLED: 'Day not selected' };
const reasonLabel = (code: string | null | undefined) => (code ? (REASON_LABEL[code] ?? code) : '');
/** An entry cancelled at submission records "<CODE> at submission (…)" on the order. */
const submissionBlock = (stateReason: string | null | undefined) => (stateReason ? (/^(OUTSIDE_TRADING_WINDOW|DAY_DISABLED) at submission/.exec(stateReason)?.[1] ?? null) : null);
/** The block's own mode as recorded at evaluation: a Live block's order is never labelled Paper. */
const modeLabel = (mode: 'PAPER' | 'LIVE') => (mode === 'LIVE' ? 'Live' : 'Paper');
const sideLabel = (side: 'LONG' | 'SHORT' | null) => (side === 'LONG' ? 'Long' : 'Short');

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
      scope={`${user.name} · My Account · Paper entries are simulated; Live entries are sent to your own MEXC account. Each outcome shows the mode of the order block it was evaluated for.`}
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
                <tr key={o.id} data-testid="signal-outcome" data-status={o.status} data-reason={o.reason ?? ''} data-mode={o.mode}>
                  <td className="whitespace-nowrap px-4 py-2.5 text-muted">{fmt(o.signal.barCloseAt)}</td>
                  <td className="px-4 py-2.5 text-ink">
                    {ACTION_LABEL[o.signal.action] ?? o.signal.action}
                    <span className="block text-xs text-subtle">
                      {o.signal.sourceExchange}:{o.signal.sourceSymbol} · {o.signal.interval}m · ref {o.signal.referencePrice}
                    </span>
                  </td>
                  <td className="px-4 py-2.5 text-muted">
                    <span className="flex items-center gap-1.5">
                      {symbolOf(o.orderBlockId)}
                      <StatusPill tone={o.mode === 'LIVE' ? 'warn' : 'accent'}>{modeLabel(o.mode)}</StatusPill>
                    </span>
                    <span className="block text-xs text-subtle">strategy v{o.strategyVersion}</span>
                  </td>
                  <td className="px-4 py-2.5" data-testid="outcome-status" data-entry={o.entry?.status ?? ''} data-entry-reason={o.entry?.reason ?? ''}>
                    {o.exit ? (
                      o.exit.status === 'EXIT_REQUESTED' ? (
                        <span className="flex flex-wrap gap-1">
                          <StatusPill tone="warn">
                            {o.exit.reason === 'REVERSAL_CLOSE' ? 'Close and reverse' : `${modeLabel(o.mode)} close`} · {(o.exit.orderState ?? 'pending').toLowerCase()}
                          </StatusPill>
                          {o.exit.reason === 'REVERSAL_CLOSE' && (
                            <span data-testid="reversal-status" data-reversal={o.entry?.status ?? 'PENDING'} data-reversal-reason={o.entry?.reason ?? ''}>
                              {!o.entry ? (
                                <StatusPill tone="neutral">Opening leg pending</StatusPill>
                              ) : o.entry.status === 'ENTRY_APPROVED' ? (
                                <StatusPill tone="gain">
                                  Reversed · {modeLabel(o.mode)} {sideLabel(o.side)} {o.entry.orderState === 'FILLED' ? 'filled' : (o.entry.orderState ?? 'pending').toLowerCase()}
                                </StatusPill>
                              ) : (
                                <StatusPill tone="neutral">Stayed flat · {reasonLabel(o.entry.reason)}</StatusPill>
                              )}
                            </span>
                          )}
                        </span>
                      ) : (
                        <StatusPill tone="neutral">Position kept open · {o.exit.reason}</StatusPill>
                      )
                    ) : o.status !== 'READY_FOR_EVALUATION' ? (
                      <StatusPill tone="neutral">Skipped · {reasonLabel(o.reason)}</StatusPill>
                    ) : !o.entry ? (
                      <StatusPill tone="accent">Ready for evaluation{o.side ? ` · ${o.side === 'LONG' ? 'Long' : 'Short'}` : ''}</StatusPill>
                    ) : o.entry.status === 'ENTRY_APPROVED' && o.entry.orderState === 'CANCELLED' && submissionBlock(o.entry.orderStateReason) ? (
                      <StatusPill tone="neutral">Entry cancelled · {reasonLabel(submissionBlock(o.entry.orderStateReason))}</StatusPill>
                    ) : o.entry.status === 'ENTRY_APPROVED' ? (
                      <StatusPill tone="gain">
                        {modeLabel(o.mode)} {sideLabel(o.side)} · {o.entry.orderState === 'FILLED' ? 'filled' : (o.entry.orderState ?? 'pending').toLowerCase()}
                      </StatusPill>
                    ) : o.entry.reason === 'LIVE_NOT_ELIGIBLE' ? (
                      <StatusPill tone="warn">Live entry blocked · {sideLabel(o.side)} not sent</StatusPill>
                    ) : (
                      <StatusPill tone="neutral">Entry skipped · {reasonLabel(o.entry.reason)}</StatusPill>
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
                      (o.entry?.reasonText ??
                      (submissionBlock(o.entry?.orderStateReason) === 'OUTSIDE_TRADING_WINDOW' ? `${OUTSIDE_WINDOW_TEXT} when the order was submitted (${o.entry?.orderStateReason?.replace(/^.*\(|\)$/g, '')}).` : null) ??
                      o.entry?.orderStateReason ??
                      o.reasonText ??
                      'Passed pause, direction, weekday, trading window and freshness checks.')
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
