'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { LiveQuoteDto } from '@trendpilot/db';
import { request } from '@/lib/api';

export type LiveConnection = 'connecting' | 'live' | 'reconnecting' | 'ended';

export interface LiveQuoteRow extends LiveQuoteDto {
  /** Browser time this row last changed from a pushed quote. */
  pushedAtMs?: number;
  /** Feed receipt → browser display, approximate (server and browser clocks may differ). */
  latencyMs?: number;
}

interface QuoteEvent {
  instrumentId: string;
  asOf: string;
  bid: string;
  ask: string;
  mark: string;
  last: string;
  source: string;
  channel: string | null;
  sourceLabel: string;
  receivedAt: string;
}

const newer = (a: string | undefined, b: string) => !a || Date.parse(b) >= Date.parse(a);

/**
 * Live quotes from TrendPilot (never from MEXC): an initial snapshot, then one SSE `quote` event
 * per stored quote. `refresh` re-reads TrendPilot's latest stored quotes. `nowMs` ticks every
 * second so ages stay current between pushes.
 */
export function useLiveQuotes(initial: LiveQuoteDto[], o: { fallbackRefreshMs?: number } = {}) {
  const [items, setItems] = useState<LiveQuoteRow[]>(initial);
  const [connection, setConnection] = useState<LiveConnection>('connecting');
  // null until mounted: ages are computed in the browser only (server and client clocks differ,
  // and a server-rendered age would not match on hydration).
  const [nowMs, setNowMs] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  /** Browser time of the last pushed or refreshed quote (drives the streaming fallback). */
  const lastDataMs = useRef(0);
  const connectionRef = useRef<LiveConnection>('connecting');
  useEffect(() => {
    connectionRef.current = connection;
  }, [connection]);

  useEffect(() => {
    setNowMs(Date.now());
    const t = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (typeof EventSource === 'undefined') return;
    const es = new EventSource('/v1/market/quotes/stream');
    es.addEventListener('snapshot', (e) => {
      const d = JSON.parse((e as MessageEvent).data) as { items: LiveQuoteDto[] };
      setItems((cur) => d.items.map((n) => ({ ...cur.find((c) => c.instrumentId === n.instrumentId), ...n })));
      setConnection('live');
    });
    es.addEventListener('quote', (e) => {
      const q = JSON.parse((e as MessageEvent).data) as QuoteEvent;
      const at = Date.now();
      lastDataMs.current = at;
      setItems((cur) =>
        cur.map((row) =>
          row.instrumentId === q.instrumentId && newer(row.quote?.asOf, q.asOf)
            ? {
                ...row,
                quote: { bid: q.bid, ask: q.ask, mark: q.mark, last: q.last, source: q.source, channel: q.channel, sourceLabel: q.sourceLabel, asOf: q.asOf },
                pushedAtMs: at,
                latencyMs: Math.max(0, at - Date.parse(q.receivedAt))
              }
            : row
        )
      );
      setConnection('live');
    });
    es.addEventListener('end', () => {
      es.close();
      setConnection('ended');
    });
    es.onopen = () => setConnection((c) => (c === 'ended' ? c : 'live'));
    es.onerror = () => setConnection((c) => (c === 'ended' ? c : 'reconnecting'));
    return () => es.close();
  }, []);

  /** Re-reads TrendPilot's latest stored quotes (database only; no MEXC call). */
  const refresh = useCallback(async () => {
    setBusy(true);
    const r = await request<{ items: LiveQuoteDto[] }>('GET', '/v1/market/quotes');
    if (r.ok) {
      lastDataMs.current = Date.now();
      setItems((cur) => r.data.items.map((n) => ({ ...cur.find((c) => c.instrumentId === n.instrumentId), ...n })));
    }
    setBusy(false);
  }, []);

  // Fallback: when the stream is not live, or has pushed nothing for a whole interval, re-read
  // TrendPilot's stored quotes on that interval (database only; never MEXC).
  const fallbackMs = o.fallbackRefreshMs;
  useEffect(() => {
    if (!fallbackMs) return;
    lastDataMs.current = Date.now();
    const t = setInterval(() => {
      if (connectionRef.current !== 'live' || Date.now() - lastDataMs.current >= fallbackMs) void refresh();
    }, fallbackMs);
    return () => clearInterval(t);
  }, [fallbackMs, refresh]);

  return { items, connection, nowMs, refresh, busy };
}
