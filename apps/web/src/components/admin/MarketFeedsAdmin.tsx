'use client';

import React, { useState } from 'react';
import type { FeedEventDto, FeedHealthDto, FeedTransportDto, LiveQuoteDto } from '@trendpilot/db';
import { FEED_POLICY } from '@trendpilot/domain';
import { request } from '@/lib/api';
import { ConnectionPill } from '../market/LiveQuotesPanel';
import { useLiveQuotes } from '../market/useLiveQuotes';
import { Button } from '../ui/Button';
import { StatusPill, type PillTone } from '../ui/StatusPill';

const stateTone: Record<string, PillTone> = { HEALTHY: 'gain', STARTING: 'neutral', STALE: 'warn', DOWN: 'loss', CLOCK_SKEW: 'warn', SYMBOL_UNAVAILABLE: 'loss' };
const stateLabel: Record<string, string> = { HEALTHY: 'Healthy', STARTING: 'Starting', STALE: 'Stale', DOWN: 'Down', CLOCK_SKEW: 'Clock skew', SYMBOL_UNAVAILABLE: 'Symbol unavailable' };

const fmt = (iso: string | null, tz: string) =>
  iso ? new Intl.DateTimeFormat('en-GB', { timeZone: tz, dateStyle: 'short', timeStyle: 'medium' }).format(new Date(iso)) : '—';

/** "74651.000000000000" → "74651", matching the live stream. */
const trim = (v: string) => (v.includes('.') ? v.replace(/\.?0+$/, '') : v);

const toLive = (items: FeedHealthDto[]): LiveQuoteDto[] =>
  items.map((i) => ({
    instrumentId: i.instrumentId,
    symbol: i.symbol,
    exchangeSymbol: i.exchangeSymbol,
    quote: i.latestQuote ? { bid: trim(i.latestQuote.bid), ask: trim(i.latestQuote.ask), mark: trim(i.latestQuote.mark), last: trim(i.latestQuote.last), source: i.latestQuote.source, channel: i.latestQuote.channel, sourceLabel: i.latestQuote.sourceLabel, asOf: i.latestQuote.asOf } : null
  }));

function TransportBanner({ t, timezone }: { t: FeedTransportDto | null; timezone: string }) {
  if (!t) return <p className="rounded-xl border border-line bg-surface px-4 py-3 text-xs text-subtle" data-testid="feed-transport">No market feed process has reported yet.</p>;
  const s = t.stream;
  const ws = t.tickerSource === 'ws';
  return (
    <div className="space-y-1 rounded-xl border border-line bg-surface px-4 py-3 text-xs" data-testid="feed-transport">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-semibold text-ink">Ticker transport</span>
        {!t.reporting ? (
          <StatusPill tone="warn">Feed not reporting</StatusPill>
        ) : ws ? (
          <StatusPill tone={s?.state === 'OPEN' ? 'gain' : 'loss'}>{s?.state === 'OPEN' ? 'WebSocket connected' : `WebSocket ${s?.state?.toLowerCase() ?? 'unknown'}`}</StatusPill>
        ) : (
          <StatusPill tone="warn">REST polling (MARKET_FEED_TICKER_SOURCE=rest)</StatusPill>
        )}
        {ws && <span className="text-muted">REST ticker fallback {t.restFallback ? 'on (rate-limited)' : 'off'}</span>}
        {t.restPausedUntil && <StatusPill tone="warn">REST paused (MEXC rate limit) until {fmt(t.restPausedUntil, timezone)}</StatusPill>}
      </div>
      {ws && s && (
        <div className="text-muted">
          {s.connectedSince ? `Connected since ${fmt(s.connectedSince, timezone)}` : s.nextReconnectAt ? `Reconnecting at ${fmt(s.nextReconnectAt, timezone)}` : 'Not connected'} · subscribed {s.subscribed.join(', ') || 'none'} · receiving{' '}
          {s.confirmed.join(', ') || 'none yet'} · {s.reconnects} reconnect(s) · last message {fmt(s.lastMessageAt, timezone)}
          {s.lastError ? ` · last error: ${s.lastError}` : ''}
        </div>
      )}
      <div className="text-subtle">
        REST calls since feed start: ticker {t.restCalls.ticker ?? 0} · kline {t.restCalls.kline ?? 0} · detail {t.restCalls.detail ?? 0} · funding {t.restCalls.funding_rate ?? 0} · ping {t.restCalls.ping ?? 0} · instance {t.instance}, reported{' '}
        {fmt(t.lastSeenAt, timezone)}
      </div>
      {t.otherInstances.length > 0 && <div className="text-loss">Another active feed instance is reporting ({t.otherInstances.join(', ')}). Run exactly one feed per deployment.</div>}
    </div>
  );
}

/** MKT-02 feed health for admins: per contract state, freshness, data source and recent events. */
export function MarketFeedsAdmin({
  initial,
  timezone
}: {
  initial: { items: FeedHealthDto[]; events: FeedEventDto[]; transport: FeedTransportDto | null; checkedAt: string };
  timezone: string;
}) {
  const [data, setData] = useState(initial);
  const [busy, setBusy] = useState(false);
  const live = useLiveQuotes(toLive(initial.items));
  const liveById = new Map(live.items.map((q) => [q.instrumentId, q]));
  // Refresh reads TrendPilot's own stored state; it never calls MEXC.
  const refresh = async () => {
    setBusy(true);
    const r = await request<typeof initial>('GET', '/v1/admin/market-feeds');
    if (r.ok) setData(r.data);
    await live.refresh();
    setBusy(false);
  };

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <ConnectionPill connection={live.connection} />
          <p className="text-xs text-subtle">
            Prices update live. Feed state checked {fmt(data.checkedAt, timezone)} ({timezone})
          </p>
        </div>
        <Button variant="secondary" onClick={() => void refresh()} disabled={busy}>
          {busy ? 'Refreshing…' : 'Refresh'}
        </Button>
      </div>

      <TransportBanner t={data.transport} timezone={timezone} />

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
                  {(() => {
                    const lq = liveById.get(i.instrumentId);
                    const q = lq?.quote;
                    if (!q) return <span className="text-xs text-subtle">No price</span>;
                    const age = live.nowMs === null ? null : Math.max(0, Math.round((live.nowMs - Date.parse(q.asOf)) / 1000));
                    const fresh = age === null ? i.latestQuote?.freshness !== 'STALE' : age * 1000 <= FEED_POLICY.maxQuoteAgeMs;
                    return (
                      <div className="space-y-1">
                        <StatusPill tone={q.channel === 'REST_FALLBACK' ? 'warn' : q.source === 'MEXC_PUBLIC' ? 'accent' : 'neutral'}>
                          <span data-testid="quote-source">{q.sourceLabel}</span>
                        </StatusPill>
                        <div className={`text-xs ${fresh ? 'text-muted' : 'text-warn'}`} data-testid="quote-age">
                          {fresh ? 'Fresh' : 'Stale'}
                          {age !== null ? ` · ${age} s old` : ''} · {fmt(q.asOf, timezone)}
                        </div>
                        {lq?.latencyMs !== undefined && <div className="text-[11px] text-subtle">pushed ~{lq.latencyMs} ms after feed receipt</div>}
                      </div>
                    );
                  })()}
                </td>
                <td className="px-4 py-3 font-mono text-xs text-ink" data-testid="quote-prices">
                  {(() => {
                    const q = liveById.get(i.instrumentId)?.quote;
                    return q ? `${q.bid} / ${q.ask} · ${q.mark}` : '—';
                  })()}
                </td>
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
