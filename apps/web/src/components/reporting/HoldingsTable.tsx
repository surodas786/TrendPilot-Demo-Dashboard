import Link from 'next/link';
import type { HoldingDto } from '@trendpilot/db';
import { fmtTime, pnlTone, priceOrUnavailable, usdtOrUnavailable } from './format';
import { StatusPill } from '../ui/StatusPill';
import { TRAILING_STATUS_LABEL, trailingName } from '@/lib/exitLabels';

/** REP-04 Holdings: each open paper position with current price, stop coverage and unrealized P&L. */
export function HoldingsTable({ holdings, timezone }: { holdings: HoldingDto[]; timezone: string }) {
  if (!holdings.length) return <p className="text-sm text-muted">No open paper positions.</p>;
  return (
    <div className="overflow-x-auto rounded-xl border border-line">
      <table className="w-full min-w-[1240px] text-left text-sm" aria-label="Holdings">
        <thead className="border-b border-line text-xs text-subtle">
          <tr>
            <th scope="col" className="px-3 py-2 font-medium">Contract</th>
            <th scope="col" className="px-3 py-2 font-medium">Side</th>
            <th scope="col" className="px-3 py-2 font-medium">Remaining</th>
            <th scope="col" className="px-3 py-2 font-medium">Entry</th>
            <th scope="col" className="px-3 py-2 font-medium">Current (mark · last)</th>
            <th scope="col" className="px-3 py-2 font-medium">Stop coverage</th>
            <th scope="col" className="px-3 py-2 font-medium">Trailing take profit</th>
            <th scope="col" className="px-3 py-2 font-medium">Unrealized (mark)</th>
            <th scope="col" className="px-3 py-2 font-medium">Liquidation</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {holdings.map((h) => {
            const covered = h.stop.protection === 'PROTECTED' && h.stop.contracts !== null && Number(h.stop.contracts) === Number(h.contracts);
            return (
              <tr key={h.id} data-testid="holding" data-symbol={h.symbol} data-side={h.side}>
                <td className="px-3 py-2.5">
                  <Link href={`/my-trades/${h.id}`} className="font-semibold text-accent hover:underline">
                    {h.symbol}
                  </Link>
                  <span className="block text-xs text-subtle">
                    {h.leverage}× · {h.marginMode.toLowerCase()} · opened {fmtTime(h.openedAt, timezone)}
                  </span>
                </td>
                <td className="px-3 py-2.5">
                  <StatusPill tone={h.side === 'LONG' ? 'gain' : 'loss'}>{h.side === 'LONG' ? 'Long' : 'Short'}</StatusPill>
                </td>
                <td className="px-3 py-2.5 text-ink" data-testid="holding-remaining">
                  {Number(h.contracts)} of {Number(h.initialContracts)}
                  <span className="block text-xs text-subtle">notional {usdtOrUnavailable(h.notionalUsdt)}</span>
                </td>
                <td className="px-3 py-2.5 text-ink" data-testid="holding-entry">
                  {priceOrUnavailable(h.avgEntryPrice)}
                </td>
                <td className="px-3 py-2.5" data-testid="holding-price" data-freshness={h.price?.freshness ?? 'UNAVAILABLE'}>
                  {h.price ? (
                    <>
                      <span className="text-ink">
                        {priceOrUnavailable(h.price.mark)} · {priceOrUnavailable(h.price.last)}
                      </span>
                      <span className={`block text-xs ${h.price.freshness === 'STALE' ? 'font-semibold text-warn' : 'text-subtle'}`}>
                        {h.price.freshness === 'STALE' ? 'Stale · ' : ''}
                        {h.price.sourceLabel} · {fmtTime(h.price.asOf, timezone)}
                      </span>
                    </>
                  ) : (
                    <span className="text-muted">Unavailable</span>
                  )}
                </td>
                <td className="px-3 py-2.5" data-testid="holding-stop">
                  <StatusPill tone={covered ? 'gain' : 'loss'}>{covered ? `Covers ${Number(h.stop.contracts)}` : h.stop.protection === 'PROTECTED' ? `Covers ${Number(h.stop.contracts ?? 0)} of ${Number(h.contracts)}` : 'Not protected'}</StatusPill>
                  <span className="block text-xs text-subtle">
                    stop {priceOrUnavailable(h.stop.price)} ({h.stop.basis.toLowerCase()})
                  </span>
                </td>
                <td className="px-3 py-2.5 text-xs" data-testid="holding-trailing" data-status={h.trailing?.status ?? 'OFF'} data-kind={h.trailing?.kind ?? 'NONE'}>
                  {!h.trailing ? (
                    <span className="text-muted">Off</span>
                  ) : (
                    <>
                      <StatusPill tone={h.trailing.status === 'ACTIVE' ? 'gain' : 'neutral'}>{TRAILING_STATUS_LABEL[h.trailing.status] ?? h.trailing.status}</StatusPill>
                      <span className="block text-subtle">
                        {h.trailing.status === 'ACTIVE'
                          ? `closes at ${priceOrUnavailable(h.trailing.level)} · best ${priceOrUnavailable(h.trailing.watermark)}`
                          : h.trailing.activationPrice
                            ? `activates at ${priceOrUnavailable(h.trailing.activationPrice)}`
                            : 'from entry'}
                      </span>
                      <span className="block text-subtle">
                        {h.trailing.contracts !== null ? `${Number(h.trailing.contracts)} contracts · ` : ''}trail {h.trailing.distancePct}%{h.trailing.kind === 'STOP' ? ` · ${trailingName('STOP')}` : ''}
                      </span>
                    </>
                  )}
                </td>
                <td className={`px-3 py-2.5 font-semibold ${pnlTone(h.unrealizedPnlUsdt)}`} data-testid="holding-unrealized">
                  {usdtOrUnavailable(h.unrealizedPnlUsdt, true)}
                  {h.price?.freshness === 'STALE' && <span className="block text-xs font-normal text-warn">on a stale price</span>}
                </td>
                <td className="px-3 py-2.5 text-xs" data-testid="holding-liquidation">
                  {h.liquidation ? (
                    <>
                      <span className="text-ink">{priceOrUnavailable(h.liquidation.price)}</span>
                      <span className="block text-subtle">{h.liquidation.label}</span>
                    </>
                  ) : (
                    <span className="text-muted">Unavailable</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
