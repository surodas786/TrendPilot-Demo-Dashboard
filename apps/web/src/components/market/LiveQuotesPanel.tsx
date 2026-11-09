'use client';

import React from 'react';
import { RadioIcon, RefreshCwIcon, WifiOffIcon } from 'lucide-react';
import type { LiveQuoteDto } from '@trendpilot/db';
import { FEED_POLICY } from '@trendpilot/domain';
import { Button } from '../ui/Button';
import { StatusPill } from '../ui/StatusPill';
import { useLiveQuotes, type LiveConnection } from './useLiveQuotes';

const fmtTime = (iso: string, tz: string) => new Intl.DateTimeFormat('en-GB', { timeZone: tz, timeStyle: 'medium' }).format(new Date(iso));

export function ConnectionPill({ connection }: { connection: LiveConnection }) {
  if (connection === 'live')
    return (
      <StatusPill tone="gain" icon={RadioIcon}>
        <span data-testid="live-connection">Live</span>
      </StatusPill>
    );
  return (
    <StatusPill tone="warn" icon={WifiOffIcon}>
      <span data-testid="live-connection">{connection === 'connecting' ? 'Connecting…' : connection === 'ended' ? 'Session ended' : 'Reconnecting…'}</span>
    </StatusPill>
  );
}

/** Current public prices per contract, pushed from TrendPilot as the feed stores them. */
export function LiveQuotesPanel({ initial, timezone }: { initial: LiveQuoteDto[]; timezone: string }) {
  const { items, connection, nowMs, refresh, busy } = useLiveQuotes(initial);
  return (
    <section className="rounded-xl border border-line bg-surface p-4" aria-label="Live prices" data-testid="live-quotes">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-semibold text-ink">Live prices</h3>
          <ConnectionPill connection={connection} />
        </div>
        <Button variant="secondary" size="sm" icon={RefreshCwIcon} loading={busy} onClick={() => void refresh()} disabled={busy} aria-label="Refresh prices from TrendPilot">
          {busy ? 'Refreshing…' : 'Refresh'}
        </Button>
      </div>
      {items.length === 0 ? (
        <p className="mt-3 text-xs text-subtle">No contracts are published.</p>
      ) : (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[640px] text-left text-sm">
            <thead className="text-xs text-subtle">
              <tr>
                <th scope="col" className="py-1.5 pr-4 font-medium">Contract</th>
                <th scope="col" className="py-1.5 pr-4 text-right font-medium">Bid</th>
                <th scope="col" className="py-1.5 pr-4 text-right font-medium">Ask</th>
                <th scope="col" className="py-1.5 pr-4 text-right font-medium">Mark</th>
                <th scope="col" className="py-1.5 pr-4 font-medium">Source</th>
                <th scope="col" className="py-1.5 font-medium">Last update ({timezone})</th>
              </tr>
            </thead>
            <tbody>
              {items.map((i) => {
                const q = i.quote;
                const age = q && nowMs !== null ? Math.max(0, Math.round((nowMs - Date.parse(q.asOf)) / 1000)) : null;
                const stale = !q || (age !== null && age * 1000 > FEED_POLICY.maxQuoteAgeMs);
                return (
                  <tr key={i.instrumentId} className="border-t border-line/60" data-testid={`live-${i.symbol}`}>
                    <td className="py-2 pr-4 font-medium text-ink">{i.symbol}</td>
                    <td className="py-2 pr-4 text-right font-mono text-xs text-ink" data-testid="bid">{q?.bid ?? '—'}</td>
                    <td className="py-2 pr-4 text-right font-mono text-xs text-ink" data-testid="ask">{q?.ask ?? '—'}</td>
                    <td className="py-2 pr-4 text-right font-mono text-xs text-ink" data-testid="mark">{q?.mark ?? '—'}</td>
                    <td className="py-2 pr-4 text-xs">
                      {q ? (
                        <StatusPill tone={q.channel === 'WS' ? 'accent' : q.channel === 'REST_FALLBACK' ? 'warn' : 'neutral'}>
                          <span data-testid="source">{q.sourceLabel}</span>
                        </StatusPill>
                      ) : (
                        <span className="text-subtle">No price</span>
                      )}
                    </td>
                    <td className={`py-2 text-xs ${stale ? 'text-warn' : 'text-muted'}`} data-testid="updated">
                      {q ? `${fmtTime(q.asOf, timezone)}${age !== null ? ` · ${age} s ago` : ''}${stale ? ' · stale' : ''}` : '—'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <p className="mt-2 text-[11px] text-subtle">Prices come from TrendPilot&apos;s public MEXC feed and update automatically. Refresh re-reads TrendPilot&apos;s latest stored price; it does not contact the exchange.</p>
    </section>
  );
}
