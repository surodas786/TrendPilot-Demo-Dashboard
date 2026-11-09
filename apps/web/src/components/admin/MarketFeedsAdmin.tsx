'use client';

import React, { useState } from 'react';
import type { FeedEventDto, FeedHealthDto } from '@trendpilot/db';
import { request } from '@/lib/api';
import { Button } from '../ui/Button';
import { StatusPill, type PillTone } from '../ui/StatusPill';

const stateTone: Record<string, PillTone> = { HEALTHY: 'gain', STARTING: 'neutral', STALE: 'warn', DOWN: 'loss', CLOCK_SKEW: 'warn', SYMBOL_UNAVAILABLE: 'loss' };
const stateLabel: Record<string, string> = { HEALTHY: 'Healthy', STARTING: 'Starting', STALE: 'Stale', DOWN: 'Down', CLOCK_SKEW: 'Clock skew', SYMBOL_UNAVAILABLE: 'Symbol unavailable' };

const fmt = (iso: string | null, tz: string) =>
  iso ? new Intl.DateTimeFormat('en-GB', { timeZone: tz, dateStyle: 'short', timeStyle: 'medium' }).format(new Date(iso)) : '—';

/** MKT-02 feed health for admins: per contract state, freshness, data source and recent events. */
export function MarketFeedsAdmin({ initial, timezone }: { initial: { items: FeedHealthDto[]; events: FeedEventDto[]; checkedAt: string }; timezone: string }) {
  const [data, setData] = useState(initial);
  const [busy, setBusy] = useState(false);
  const refresh = async () => {
    setBusy(true);
    const r = await request<typeof initial>('GET', '/v1/admin/market-feeds');
    if (r.ok) setData(r.data);
    setBusy(false);
  };

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-subtle">Checked {fmt(data.checkedAt, timezone)} ({timezone})</p>
        <Button variant="secondary" onClick={() => void refresh()} disabled={busy}>
          {busy ? 'Refreshing…' : 'Refresh'}
        </Button>
      </div>

      <div className="overflow-x-auto rounded-xl border border-line bg-surface">
        <table className="w-full min-w-[960px] text-left text-sm" aria-label="Market data feeds">
          <thead className="border-b border-line text-xs text-subtle">
            <tr>
              <th scope="col" className="px-4 py-2.5 font-medium">Contract</th>
              <th scope="col" className="px-4 py-2.5 font-medium">Public MEXC feed</th>
              <th scope="col" className="px-4 py-2.5 font-medium">Current price source</th>
              <th scope="col" className="px-4 py-2.5 font-medium">Bid / Ask · Mark</th>
              <th scope="col" className="px-4 py-2.5 font-medium">Closed candles</th>
              <th scope="col" className="px-4 py-2.5 font-medium">Notes</th>
            </tr>
          </thead>
          <tbody>
            {data.items.map((i) => (
              <tr key={i.instrumentId} className="border-b border-line/60 align-top last:border-0" data-testid={`feed-${i.symbol}`}>
                <td className="px-4 py-3">
                  <div className="font-medium text-ink">{i.symbol}</div>
                  <div className="text-xs text-subtle">
                    {i.exchangeSymbol || 'no exchange symbol'} · {i.instrumentStatus === 'PUBLISHED' ? 'Published' : 'Disabled'}
                  </div>
                </td>
                <td className="px-4 py-3">
                  {i.feed ? (
                    <div className="space-y-1">
                      <StatusPill tone={i.feed.reporting ? (stateTone[i.feed.state] ?? 'neutral') : 'warn'}>
                        {i.feed.reporting ? (stateLabel[i.feed.state] ?? i.feed.state) : 'Not reporting'}
                      </StatusPill>
                      <div className="text-xs text-muted">{i.feed.reporting ? i.feed.stateText : `Feed process last reported ${fmt(i.feed.updatedAt, timezone)}.`}</div>
                      {i.feed.consecutiveFailures > 0 && (
                        <div className="text-xs text-loss">
                          {i.feed.consecutiveFailures} failure(s); retry {fmt(i.feed.nextRetryAt, timezone)}
                        </div>
                      )}
                      {i.feed.clockOffsetMs !== null && <div className="text-xs text-subtle">Clock offset {i.feed.clockOffsetMs} ms</div>}
                    </div>
                  ) : (
                    <span className="text-xs text-subtle">Not started</span>
                  )}
                </td>
                <td className="px-4 py-3">
                  {i.latestQuote ? (
                    <div className="space-y-1">
                      <StatusPill tone={i.latestQuote.source === 'MEXC_PUBLIC' ? 'accent' : 'neutral'}>{i.latestQuote.sourceLabel}</StatusPill>
                      <div className={`text-xs ${i.latestQuote.freshness === 'FRESH' ? 'text-muted' : 'text-warn'}`}>
                        {i.latestQuote.freshness === 'FRESH' ? 'Fresh' : 'Stale'} · {i.latestQuote.ageSeconds} s old
                      </div>
                    </div>
                  ) : (
                    <span className="text-xs text-subtle">No price</span>
                  )}
                </td>
                <td className="px-4 py-3 font-mono text-xs text-ink">{i.latestQuote ? `${i.latestQuote.bid} / ${i.latestQuote.ask} · ${i.latestQuote.mark}` : '—'}</td>
                <td className="px-4 py-3 text-xs text-muted">
                  {i.feed && Object.keys(i.feed.lastCandleOpen).length
                    ? Object.entries(i.feed.lastCandleOpen)
                        .sort(([a], [b]) => Number(a) - Number(b))
                        .map(([k, v]) => (
                          <div key={k}>
                            {k}m to {fmt(v, timezone)}
                          </div>
                        ))
                    : '—'}
                </td>
                <td className="px-4 py-3 text-xs">
                  {i.feed?.contractMismatches.length ? (
                    <div className="text-warn">
                      Spec differs from MEXC:{' '}
                      {i.feed.contractMismatches.map((m) => `${m.field} ${m.platform} vs ${m.exchange}`).join('; ')}
                    </div>
                  ) : null}
                  {i.feed?.lastError && <div className="text-loss">{i.feed.lastError}</div>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <section className="space-y-2">
        <h3 className="text-sm font-semibold text-ink">Recent feed events</h3>
        {data.events.length === 0 ? (
          <p className="text-xs text-subtle">No feed events yet.</p>
        ) : (
          <ul className="divide-y divide-line/60 rounded-xl border border-line bg-surface text-sm" aria-label="Feed events">
            {data.events.map((e) => (
              <li key={e.id} className="flex flex-col gap-0.5 px-4 py-2.5 md:flex-row md:gap-4">
                <span className="w-44 shrink-0 text-xs text-subtle">{fmt(e.createdAt, timezone)}</span>
                <span className="w-40 shrink-0 font-mono text-xs text-muted">{e.kind}</span>
                <span className="text-xs text-ink">{e.message}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
