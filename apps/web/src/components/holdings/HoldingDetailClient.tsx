'use client';

import React from 'react';
import type { HoldingDto, LiveQuoteDto, TradeDetailDto } from '@trendpilot/db';
import { cn } from '@/lib/cn';
import { EXIT_LABEL, signedUsdt, takeProfitPlanLabel, TARGET_STATUS_LABEL, TRAILING_STATUS_LABEL, trailingName } from '@/lib/exitLabels';
import { ConnectionPill } from '../market/LiveQuotesPanel';
import { useLiveQuotes } from '../market/useLiveQuotes';
import { fmtTime, pnlTone, priceOrUnavailable } from '../reporting/format';
import { HOLDINGS_FALLBACK_MS, livePriceFor, ModePill, PriceCell, ProtectionPill, SideLabel, unrealizedAt } from './HoldingsClient';
import { PositionChart } from './PositionChart';

const ACTION_LABEL: Record<string, string> = { BULLISH_FLIP: 'Bullish flip', BEARISH_FLIP: 'Bearish flip', CLOSE_LONG: 'Close long', CLOSE_SHORT: 'Close short' };

function Field({ label, children, testId }: { label: string; children: React.ReactNode; testId?: string }) {
  return (
    <div>
      <dt className="text-xs text-subtle">{label}</dt>
      <dd className="mt-0.5 text-sm tabular-nums text-ink" data-testid={testId}>
        {children}
      </dd>
    </div>
  );
}

/** One holding: live price and P&L, the chart, every opening and closing fill, and linked signals. */
export function HoldingDetailClient({ t, holdingPrice, quotes, timezone }: { t: TradeDetailDto; holdingPrice: HoldingDto['price'] | null; quotes: LiveQuoteDto[]; timezone: string }) {
  const { items, connection, nowMs } = useLiveQuotes(quotes, { fallbackRefreshMs: HOLDINGS_FALLBACK_MS });
  const open = t.status === 'OPEN';
  const price = livePriceFor(t.instrumentId, items, holdingPrice, nowMs);
  const unrealized = open ? unrealizedAt(t, price.mark) : null;
  const signalOf = (id: string | null) => (id ? t.signals.find((s) => s.eventId === id) : undefined);
  const openSignal = t.signals.find((s) => s.role === 'OPEN');
  const closedSoFar = t.exits.reduce((sum, x) => sum + Number(x.contracts), 0);

  const fills = [
    ...t.order.fills.map((f) => ({
      key: f.id,
      kind: 'Open',
      at: f.filledAt,
      contracts: f.contracts,
      price: f.price,
      fee: f.feeUsdt,
      pnl: null as string | null,
      reason: 'Entry',
      remaining: f.contracts,
      signal: openSignal
    })),
    ...t.exits.map((x) => ({
      key: x.id,
      kind: 'Close',
      at: x.filledAt,
      contracts: x.contracts,
      price: x.price,
      fee: x.feeUsdt,
      pnl: x.realizedPnlUsdt as string | null,
      reason: EXIT_LABEL[x.reason] ?? x.reason,
      remaining: x.remainingContracts,
      signal: signalOf(x.signalEventId)
    }))
  ].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));

  return (
    <div className="space-y-4">
      <section className="rounded-xl border border-line bg-surface p-4">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <ModePill mode={t.mode} />
          <SideLabel side={t.side} />
          <ProtectionPill h={t} />
          {open && <ConnectionPill connection={connection} />}
        </div>
        <dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4">
          <Field label="Exchange · contract">
            {t.exchange} · {t.exchangeSymbol} perpetual
          </Field>
          <Field label="Remaining quantity" testId="detail-remaining">
            {t.contracts} of {t.initialContracts} contracts
          </Field>
          <Field label="Average entry (confirmed)">{priceOrUnavailable(t.avgEntryPrice)}</Field>
          <Field label="Current price (mark)">{open ? <PriceCell price={price} timezone={timezone} /> : 'Closed'}</Field>
          <Field label="Unrealized P&L">
            <span className={pnlTone(unrealized)} data-testid="detail-unrealized">
              {open ? (unrealized === null ? 'Unavailable' : signedUsdt(unrealized)) : '—'}
            </span>
          </Field>
          <Field label={open ? 'Stop loss (current)' : 'Stop loss (historical)'}>
            {priceOrUnavailable(t.stop.price)} <span className="text-xs text-subtle">{t.stop.basis === 'LAST' ? 'last' : 'mark'}</span>
          </Field>
          <Field label="Stop covers">{t.stop.contracts ?? '—'} contracts</Field>
          <Field label="Leverage · margin">
            {t.leverage}× · {t.marginMode.toLowerCase()}
          </Field>
          <Field label="Realized P&L (gross)">
            <span className={pnlTone(t.realizedPnlUsdt)}>{signedUsdt(t.realizedPnlUsdt)}</span>
          </Field>
          <Field label="Fees (open + close)">{t.feesUsdt} USDT</Field>
          <Field label="Net realized">
            <span className={pnlTone(t.netRealizedUsdt)}>{signedUsdt(t.netRealizedUsdt)}</span>
          </Field>
          <Field label={open ? 'Opened' : 'Closed'}>{fmtTime(open ? t.openedAt : t.closedAt, timezone)}</Field>
        </dl>
        {open && t.exits.length > 0 && (
          <p className="mt-3 text-xs text-muted" data-testid="partial-summary">
            Partly closed: {t.exits.length} exit fill{t.exits.length === 1 ? '' : 's'} closed {closedSoFar} contracts; {t.contracts} remain open and protected by the stop.
          </p>
        )}
      </section>

      <PositionChart positionId={t.id} livePrice={open ? price.mark : null} liveAt={open ? price.asOf : null} />

      <section className="rounded-xl border border-line bg-surface p-4">
        <h3 className="mb-2 text-sm font-semibold text-ink">Fills</h3>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[900px] text-left text-sm" aria-label="Fills">
            <thead className="border-b border-line text-xs text-subtle">
              <tr>
                <th scope="col" className="px-2 py-2 font-medium">Time ({timezone})</th>
                <th scope="col" className="px-2 py-2 font-medium">Fill</th>
                <th scope="col" className="px-2 py-2 text-right font-medium">Contracts</th>
                <th scope="col" className="px-2 py-2 text-right font-medium">Price</th>
                <th scope="col" className="px-2 py-2 text-right font-medium">Fee</th>
                <th scope="col" className="px-2 py-2 text-right font-medium">Realized P&amp;L</th>
                <th scope="col" className="px-2 py-2 text-right font-medium">Remaining after</th>
                <th scope="col" className="px-2 py-2 font-medium">Signal</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line tabular-nums">
              {fills.map((f) => (
                <tr key={f.key} data-testid="fill-row" data-kind={f.kind}>
                  <td className="whitespace-nowrap px-2 py-2 text-muted">{fmtTime(f.at, timezone)}</td>
                  <td className="px-2 py-2 text-ink">
                    {f.kind} <span className="text-xs text-subtle">· {f.reason}</span>
                  </td>
                  <td className="px-2 py-2 text-right text-ink">{f.contracts}</td>
                  <td className="px-2 py-2 text-right text-ink">{priceOrUnavailable(f.price)}</td>
                  <td className="px-2 py-2 text-right text-muted">{f.fee} USDT</td>
                  <td className={cn('px-2 py-2 text-right', pnlTone(f.pnl))}>{f.pnl === null ? '—' : signedUsdt(f.pnl)}</td>
                  <td className="px-2 py-2 text-right text-ink">{f.remaining}</td>
                  <td className="px-2 py-2 text-xs text-muted">{f.signal ? `${ACTION_LABEL[f.signal.action] ?? f.signal.action} · ${f.signal.interval}m · ${fmtTime(f.signal.barCloseAt, timezone)}` : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <div className="grid gap-4 lg:grid-cols-2">
        <section className="rounded-xl border border-line bg-surface p-4 text-sm">
          <h3 className="mb-2 font-semibold text-ink">Exit plan (saved with this position)</h3>
          <p className="mb-2 text-xs text-muted" data-testid="detail-tp-plan">
            {takeProfitPlanLabel(t.takeProfitPlan, t.side)}
          </p>
          {t.targets.length === 0 && !t.trailing && <p className="text-muted">No take-profit target or trailing exit. The stop loss and close signals manage this position.</p>}
          <ul className="space-y-2">
            {t.targets.map((x) => (
              <li key={x.levelId} className="flex flex-wrap justify-between gap-2" data-testid="detail-target" data-armed={x.armedAt ? 'true' : 'false'}>
                <span className="text-ink">
                  Take profit {x.ordinal} · {priceOrUnavailable(x.triggerPrice)}{' '}
                  <span className="text-xs text-subtle">
                    {x.filledContracts}/{x.plannedContracts} contracts ·{' '}
                    {x.triggerRule === 'ARM_PULLBACK' ? (x.armedAt ? `armed at ${priceOrUnavailable(x.armedPrice)} — closes on a pullback through the target` : 'arms when reached') : 'closes when reached (saved rule)'}
                  </span>
                </span>
                <span className="text-xs text-muted">{TARGET_STATUS_LABEL[x.status] ?? x.status}</span>
              </li>
            ))}
            {t.trailing && (
              <li className="flex flex-wrap justify-between gap-2">
                <span className="text-ink">
                  {trailingName(t.trailing.kind)}{' '}
                  <span className="text-xs text-subtle">
                    {t.trailing.plannedContracts !== null ? `${t.trailing.filledContracts}/${t.trailing.plannedContracts} contracts` : `manages ${t.trailing.contracts ?? '—'} contracts`} · activation{' '}
                    {priceOrUnavailable(t.trailing.activationPrice)} · trail {t.trailing.distancePct}%{t.trailing.level ? ` · level ${t.trailing.level}` : ''}
                  </span>
                </span>
                <span className="text-xs text-muted">{TRAILING_STATUS_LABEL[t.trailing.status] ?? t.trailing.status}</span>
              </li>
            )}
          </ul>
        </section>
        <section className="rounded-xl border border-line bg-surface p-4 text-sm">
          <h3 className="mb-2 font-semibold text-ink">Linked signals</h3>
          {t.signals.length === 0 ? (
            <p className="text-muted">No TradingView signal is linked to this position.</p>
          ) : (
            <ul className="space-y-1.5">
              {t.signals.map((s) => (
                <li key={`${s.role}-${s.eventId}`} className="flex flex-wrap justify-between gap-2" data-testid="linked-signal">
                  <span className="text-ink">
                    {s.role === 'OPEN' ? 'Opened by' : 'Closed by'} {ACTION_LABEL[s.action] ?? s.action}{' '}
                    <span className="text-xs text-subtle">
                      {s.source} · {s.interval}m · ref {s.referencePrice}
                    </span>
                  </span>
                  <span className="text-xs text-muted">bar closed {fmtTime(s.barCloseAt, timezone)}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
