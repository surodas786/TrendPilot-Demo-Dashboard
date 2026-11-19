'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { LayersIcon, RefreshCwIcon } from 'lucide-react';
import type { HoldingDto, LiveQuoteDto, PositionDto } from '@trendpilot/db';
import { Decimal, exchangeLabel, FEED_POLICY, unrealizedPnl } from '@trendpilot/domain';
import { request } from '@/lib/api';
import { cn } from '@/lib/cn';
import { EXIT_LABEL, signedUsdt } from '@/lib/exitLabels';
import { ConnectionPill } from '../market/LiveQuotesPanel';
import { useLiveQuotes, type LiveQuoteRow } from '../market/useLiveQuotes';
import { fmtTime, pnlTone, priceOrUnavailable } from '../reporting/format';
import { Button } from '../ui/Button';
import { EmptyState } from '../ui/EmptyState';
import { StatusPill } from '../ui/StatusPill';

/** Fallback when the stream is not live: re-read TrendPilot's stored prices and positions. */
export const HOLDINGS_FALLBACK_MS = 60_000;

type Tab = 'open' | 'closed';

export interface LivePrice {
  mark: string | null;
  sourceLabel: string | null;
  /** Quote currency of the contract (USDT, USDC), when the live quote list knows it. */
  currency: string | null;
  asOf: string | null;
  /** No price, or older than the feed's freshness limit. */
  stale: boolean;
}

/** Current price for a contract: the newest pushed or refreshed quote, else the server snapshot. */
export function livePriceFor(instrumentId: string, rows: LiveQuoteRow[], fallback: HoldingDto['price'] | null, nowMs: number | null): LivePrice {
  const row = rows.find((r) => r.instrumentId === instrumentId);
  const q = row?.quote;
  const mark = q?.mark ?? fallback?.mark ?? null;
  const asOf = q?.asOf ?? fallback?.asOf ?? null;
  const sourceLabel = q?.sourceLabel ?? fallback?.sourceLabel ?? null;
  const stale = !asOf || (nowMs !== null ? nowMs - Date.parse(asOf) > FEED_POLICY.maxQuoteAgeMs : fallback?.freshness === 'STALE');
  return { mark, asOf, sourceLabel, currency: row?.quoteCurrency ?? null, stale };
}

export const unrealizedAt = (h: Pick<PositionDto, 'side' | 'avgEntryPrice' | 'contracts' | 'contractMultiplier'>, mark: string | null) =>
  mark ? unrealizedPnl(h.side as 'LONG' | 'SHORT', h.avgEntryPrice, mark, h.contracts, h.contractMultiplier) : null;

/** Display name of the position's exchange (Live positions trade on their contract's exchange). */
const venueName = (p: { exchange?: string }) => exchangeLabel(p.exchange ?? 'MEXC');

/** The exchange confirms the position is gone, its closing fills are not listed yet (nothing booked). */
export const closedOnMexc = (h: Pick<PositionDto, 'venueSync'>) => h.venueSync?.closeState === 'FILLS_PENDING' && h.venueSync.contracts !== null && new Decimal(h.venueSync.contracts).isZero();

export function ProtectionPill({ h }: { h: Pick<PositionDto, 'status' | 'contracts' | 'stop' | 'venueSync'> & { exchange?: string } }) {
  if (h.status !== 'OPEN') return <StatusPill tone="neutral">Closed</StatusPill>;
  if (closedOnMexc(h)) return <StatusPill tone="warn">Closed on {venueName(h)} · fill details pending</StatusPill>;
  if (h.venueSync?.closeState === 'FILLS_PENDING') return <StatusPill tone="warn">{venueName(h)} holds {h.venueSync.contracts} · fill details pending</StatusPill>;
  const covered = h.stop.protection === 'PROTECTED' && h.stop.contracts !== null && new Decimal(h.stop.contracts).eq(h.contracts);
  if (covered) return <StatusPill tone="gain">Protected</StatusPill>;
  if (h.stop.protection === 'PENDING') return <StatusPill tone="warn">Verifying stop</StatusPill>;
  return <StatusPill tone="loss">Unprotected</StatusPill>;
}

export const SideLabel = ({ side }: { side: string }) => <span className={cn('font-medium', side === 'LONG' ? 'text-gain' : 'text-loss')}>{side === 'LONG' ? 'Long' : 'Short'}</span>;
export const ModePill = ({ mode }: { mode: string }) => <StatusPill tone={mode === 'LIVE' ? 'warn' : 'accent'}>{mode === 'LIVE' ? 'Live' : 'Paper'}</StatusPill>;

/** Time only, in the investor's timezone. */
const clockTime = (iso: string, tz: string) => new Intl.DateTimeFormat('en-GB', { timeZone: tz, timeStyle: 'medium' }).format(new Date(iso));

export function PriceCell({ price, timezone }: { price: LivePrice; timezone: string }) {
  return (
    <div className="text-right" data-testid="holding-price" data-stale={price.stale ? 'true' : 'false'}>
      <span className="text-ink">
        {priceOrUnavailable(price.mark)}
        {price.mark && price.currency ? <span className="text-[11px] text-subtle" data-testid="holding-price-currency">{` ${price.currency}`}</span> : null}
      </span>
      <span className="block text-[11px] text-subtle">
        {price.sourceLabel ?? 'No price'}
        {price.asOf ? ` · ${clockTime(price.asOf, timezone)}` : ''}
      </span>
      {price.stale && (
        <span className="mt-0.5 inline-block" data-testid="price-stale">
          <StatusPill tone="warn">Stale</StatusPill>
        </span>
      )}
    </div>
  );
}

/**
 * My Holdings (MagicPatterns Holdings layout): the signed-in investor's own positions only.
 * Prices stream from TrendPilot (SSE of the stored market feed); if the stream is not live or
 * stays silent, prices and positions are re-read from TrendPilot every 60 seconds.
 */
/**
 * Live: the exchange account's sync state. `stale` = the latest sync failed after (or without) the
 * last successful one, so the positions shown are the last verified snapshot, not a fresh read.
 */
export interface HoldingsSyncState {
  exchange: string;
  stale: boolean;
  lastSyncOkAt: string | null;
  lastSyncAt: string | null;
  error: string | null;
}

export function HoldingsClient({
  open: initialOpen,
  closed,
  quotes,
  timezone,
  mode = 'PAPER',
  currency = 'USDT',
  sync = null
}: {
  open: HoldingDto[];
  closed: PositionDto[];
  quotes: LiveQuoteDto[];
  timezone: string;
  mode?: 'PAPER' | 'LIVE';
  /** The viewed account's currency (one account per view, never mixed). */ currency?: string;
  sync?: HoldingsSyncState | null;
}) {
  const router = useRouter();
  const [tab, setTab] = useState<Tab>('open');
  const [open, setOpen] = useState(initialOpen);
  const [polledAt, setPolledAt] = useState<number | null>(null);
  const { items, connection, nowMs, refresh, busy } = useLiveQuotes(quotes, { fallbackRefreshMs: HOLDINGS_FALLBACK_MS });

  const reloadPositions = useCallback(async () => {
    const r = await request<{ positions: HoldingDto[] }>('GET', `/v1/me/holdings?mode=${mode}`);
    if (r.ok) {
      setOpen(r.data.positions);
      setPolledAt(Date.now());
    }
  }, [mode]);
  // Remaining quantity, stop coverage and closes change with exits: re-read them every 60 s.
  useEffect(() => {
    const t = setInterval(() => void reloadPositions(), HOLDINGS_FALLBACK_MS);
    return () => clearInterval(t);
  }, [reloadPositions]);

  const rows = useMemo(
    () =>
      open.map((h) => {
        const price = livePriceFor(h.instrumentId, items, h.price, nowMs);
        // Closed on the exchange (fills pending): no exposure left, so no unrealized P&L.
        const gone = closedOnMexc(h);
        return { h, price, gone, unrealized: gone ? null : unrealizedAt(h, price.mark) };
      }),
    [open, items, nowMs]
  );
  const counted = rows.filter((r) => !r.gone);
  const total = counted.every((r) => r.unrealized !== null) ? counted.reduce((s, r) => s.plus(r.unrealized!), new Decimal(0)).toFixed() : null;
  const go = (id: string) => router.push(`/my-holdings/${id}`);
  const stale = mode === 'LIVE' && !!sync?.stale;
  const venue = sync ? exchangeLabel(sync.exchange) : '';

  return (
    <div className="space-y-4">
      {stale && (
        <div role="status" data-testid="holdings-sync-stale" className="rounded-lg border border-warn/40 bg-warn/10 px-4 py-3 text-sm text-ink">
          <p className="font-medium">Holdings may be incomplete: the latest {venue} sync failed{sync!.lastSyncAt ? ` at ${fmtTime(sync!.lastSyncAt, timezone)}` : ''}.</p>
          <p className="mt-0.5 text-muted">
            Showing the last verified state{sync!.lastSyncOkAt ? ` (last successful sync ${fmtTime(sync!.lastSyncOkAt, timezone)})` : ' (no successful sync yet)'}. Positions opened or closed on {venue} since then are not reflected; this is not a confirmed flat account.
          </p>
          {sync!.error && <p className="mt-1 break-words font-mono text-[11px] text-subtle">{sync!.error}</p>}
        </div>
      )}
      <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <dl className="flex flex-wrap gap-x-10 gap-y-3">
          <div>
            <dt className="text-xs text-subtle">Open positions</dt>
            <dd className="mt-0.5 text-2xl font-semibold tabular-nums text-ink" data-testid="holdings-open-count" data-stale={stale ? 'true' : 'false'}>
              {counted.length}
              {stale && <span className="ml-2 align-middle text-xs font-normal text-warn">as of last successful sync</span>}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-subtle">Unrealized P&amp;L (mark)</dt>
            <dd className={cn('mt-0.5 text-2xl font-semibold tabular-nums', pnlTone(total))} data-testid="holdings-unrealized">
              {total === null ? 'Unavailable' : signedUsdt(total, currency)}
            </dd>
          </div>
        </dl>
        <div className="flex flex-wrap items-center gap-2">
          <ConnectionPill connection={connection} />
          <Button
            variant="secondary"
            size="sm"
            icon={RefreshCwIcon}
            loading={busy}
            onClick={() => void Promise.all([refresh(), reloadPositions()])}
            aria-label="Refresh prices and positions from TrendPilot"
          >
            Refresh
          </Button>
        </div>
      </div>
      <p className="text-xs text-subtle">
        Prices stream from TrendPilot&apos;s market feed. If the stream is not live, prices and positions refresh from TrendPilot every 60 seconds. A price older than{' '}
        {Math.round(FEED_POLICY.maxQuoteAgeMs / 1000)} s is marked Stale.{polledAt ? ` Positions last refreshed ${clockTime(new Date(polledAt).toISOString(), timezone)}.` : ''}
      </p>

      <div role="tablist" aria-label="Holdings" className="flex gap-1 border-b border-line">
        {(
          [
            ['open', `Open positions (${open.length})`],
            ['closed', `Closed positions (${closed.length})`]
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            role="tab"
            aria-selected={tab === id}
            onClick={() => setTab(id)}
            className={cn('-mb-px border-b-2 px-3 py-2 text-sm font-medium transition-colors duration-150', tab === id ? 'border-accent text-ink' : 'border-transparent text-muted hover:text-ink')}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === 'open' ? (
        open.length === 0 ? (
          stale ? (
            <EmptyState icon={LayersIcon} title="No verified open positions" body={`None as of the last successful ${venue} sync. The latest sync failed, so this does not confirm the account is flat.`} />
          ) : (
            <EmptyState icon={LayersIcon} title="No open positions" body="Positions open here when an accepted signal matches one of your active order blocks." />
          )
        ) : (
          <div className="overflow-x-auto rounded-xl border border-line bg-surface">
            <table className="w-full min-w-[1100px] text-sm" aria-label="Open positions">
              <thead className="text-left text-xs text-subtle">
                <tr className="border-b border-line">
                  <th scope="col" className="px-4 py-2.5 font-medium">Pair · exchange</th>
                  <th scope="col" className="px-3 py-2.5 font-medium">Mode</th>
                  <th scope="col" className="px-3 py-2.5 font-medium">Side</th>
                  <th scope="col" className="px-3 py-2.5 text-right font-medium">Remaining</th>
                  <th scope="col" className="px-3 py-2.5 text-right font-medium">Avg entry</th>
                  <th scope="col" className="px-3 py-2.5 text-right font-medium">Current (mark)</th>
                  <th scope="col" className="px-3 py-2.5 text-right font-medium">Unrealized P&amp;L</th>
                  <th scope="col" className="px-3 py-2.5 text-right font-medium">Stop loss</th>
                  <th scope="col" className="px-3 py-2.5 font-medium">Protection</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line tabular-nums">
                {rows.map(({ h, price, gone, unrealized }) => (
                  <tr key={h.id} data-testid="holding-row" data-id={h.id} className="cursor-pointer transition-colors duration-150 hover:bg-inset/60" onClick={() => go(h.id)}>
                    <td className="px-4 py-2.5">
                      <Link href={`/my-holdings/${h.id}`} onClick={(e) => e.stopPropagation()} className="font-medium text-ink hover:text-accent">
                        {h.pair}
                      </Link>
                      <span className="block text-[11px] text-subtle">
                        {h.exchange} · {h.exchangeSymbol} perpetual · {h.leverage}×
                      </span>
                    </td>
                    <td className="px-3 py-2.5">
                      <ModePill mode={h.mode} />
                    </td>
                    <td className="px-3 py-2.5">
                      <SideLabel side={h.side} />
                    </td>
                    <td className="px-3 py-2.5 text-right text-ink">
                      {h.contracts}
                      <span className="block text-[11px] text-subtle">of {h.initialContracts} contracts</span>
                      {h.venueSync?.closeState === 'FILLS_PENDING' && <span className="block text-[11px] text-warn">{venueName(h)}: {h.venueSync.contracts}</span>}
                      {h.exitHalt && (
                        <span className="block text-[11px] text-loss" data-testid="exit-halt" title={h.exitHalt.text}>
                          Automatic exits paused · {h.exitHalt.reason.split(' ')[0]}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-right text-ink">
                      {priceOrUnavailable(h.avgEntryPrice)}
                      {h.venueLeg && (
                        <span className="block text-[11px] text-subtle" data-testid="holding-venue-leg">
                          {venueName(h)}: {h.venueLeg.qty} @ {h.venueLeg.avgOpenPrice ?? '—'} · margin {h.venueLeg.marginUsdt ?? '—'} {currency} · liq. {h.venueLeg.liqPrice ?? 'none'}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2.5">
                      <PriceCell price={price} timezone={timezone} />
                    </td>
                    <td className={cn('px-3 py-2.5 text-right', pnlTone(unrealized))} data-testid="holding-unrealized">
                      {gone ? <span className="text-subtle">Closed on {venueName(h)}</span> : unrealized === null ? 'Unavailable' : signedUsdt(unrealized, currency)}
                    </td>
                    <td className="px-3 py-2.5 text-right text-ink">
                      {priceOrUnavailable(h.stop.price)}
                      <span className="block text-[11px] text-subtle">{h.stop.basis === 'LAST' ? 'Last price' : 'Mark price'}</span>
                    </td>
                    <td className="px-3 py-2.5">
                      <ProtectionPill h={h} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      ) : closed.length === 0 ? (
        <EmptyState icon={LayersIcon} title="No closed positions" body="Closed positions and their results appear here." />
      ) : (
        <div className="overflow-x-auto rounded-xl border border-line bg-surface">
          <table className="w-full min-w-[960px] text-sm" aria-label="Closed positions">
            <thead className="text-left text-xs text-subtle">
              <tr className="border-b border-line">
                <th scope="col" className="px-4 py-2.5 font-medium">Pair · exchange</th>
                <th scope="col" className="px-3 py-2.5 font-medium">Mode</th>
                <th scope="col" className="px-3 py-2.5 font-medium">Side</th>
                <th scope="col" className="px-3 py-2.5 text-right font-medium">Quantity</th>
                <th scope="col" className="px-3 py-2.5 text-right font-medium">Avg entry</th>
                <th scope="col" className="px-3 py-2.5 font-medium">Exit reason</th>
                <th scope="col" className="px-3 py-2.5 text-right font-medium">Net realized</th>
                <th scope="col" className="px-3 py-2.5 font-medium">Closed ({timezone})</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line tabular-nums">
              {closed.map((p) => (
                <tr key={p.id} data-testid="closed-row" data-fills-pending={p.venueSync?.closeState === 'FILLS_PENDING' ? 'true' : undefined} className="cursor-pointer transition-colors duration-150 hover:bg-inset/60" onClick={() => go(p.id)}>
                  <td className="px-4 py-2.5">
                    <Link href={`/my-holdings/${p.id}`} onClick={(e) => e.stopPropagation()} className="font-medium text-ink hover:text-accent">
                      {p.pair}
                    </Link>
                    <span className="block text-[11px] text-subtle">
                      {p.exchange} · {p.exchangeSymbol} perpetual
                    </span>
                  </td>
                  <td className="px-3 py-2.5">
                    <ModePill mode={p.mode} />
                  </td>
                  <td className="px-3 py-2.5">
                    <SideLabel side={p.side} />
                  </td>
                  <td className="px-3 py-2.5 text-right text-ink">
                    {p.initialContracts}
                    <span className="block text-[11px] text-subtle">{p.contracts} remaining</span>
                  </td>
                  <td className="px-3 py-2.5 text-right text-ink">{priceOrUnavailable(p.avgEntryPrice)}</td>
                  <td className="px-3 py-2.5 text-muted">
                    {p.closeReason ? (EXIT_LABEL[p.closeReason] ?? p.closeReason) : '—'}
                    {p.venueSync?.closeState === 'FILLS_PENDING' && (
                      <span className="block">
                        <StatusPill tone="warn">Closed on {venueName(p)} · fill details pending</StatusPill>
                        {p.venueSync.pendingReason && <span className="mt-0.5 block text-[11px] text-subtle">{p.venueSync.pendingReason}</span>}
                      </span>
                    )}
                  </td>
                  <td className={cn('px-3 py-2.5 text-right', pnlTone(p.netRealizedUsdt))}>{p.venueSync?.closeState === 'FILLS_PENDING' ? <span className="text-subtle">Pending</span> : signedUsdt(p.netRealizedUsdt, currency)}</td>
                  <td className="whitespace-nowrap px-3 py-2.5 text-muted">{fmtTime(p.closedAt, timezone)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
