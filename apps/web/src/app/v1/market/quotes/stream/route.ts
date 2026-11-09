import { randomUUID } from 'node:crypto';
import { getDb, listLatestQuotes, resolveSession, type QuoteHubEvent } from '@trendpilot/db';
import { quoteSourceLabel } from '@trendpilot/domain';
import { now } from '@/server/clock';
import { route } from '@/server/http';
import { quoteHub } from '@/server/quoteHub';
import { requireSession, sessionTokenFrom } from '@/server/session';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const KEEPALIVE_MS = 15_000;
const SESSION_RECHECK_MS = 60_000;

/**
 * Live quotes over Server-Sent Events. Sends a `snapshot` (TrendPilot's latest stored quote per
 * contract), then one `quote` event per stored quote as the feed commits it (Postgres NOTIFY →
 * one shared LISTEN per web process → every open stream). Read-only; never calls MEXC.
 * Investors receive published contracts; admins every contract. The session is re-checked every
 * minute and the stream ends when it is no longer valid.
 */
export const GET = route(async (req) => {
  const s = await requireSession(req);
  const admin = s.user.role === 'ADMIN';
  const token = sessionTokenFrom(req);
  const enc = new TextEncoder();
  let cleanup: (() => void) | null = null;

  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      let open = true;
      let allowed = new Set<string>();
      const write = (chunk: string) => {
        if (!open) return;
        try {
          controller.enqueue(enc.encode(chunk));
        } catch {
          cleanup?.();
        }
      };
      const send = (event: string, data: unknown) => write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      const snapshot = async () => {
        const items = await listLatestQuotes(getDb(), now(), { publishedOnly: !admin });
        allowed = new Set(items.map((i) => i.instrumentId));
        send('snapshot', { items, serverTime: new Date().toISOString() });
      };

      const unsubscribe = quoteHub().subscribe((e: QuoteHubEvent) => {
        if (e.kind === 'resync') return void snapshot().catch(() => undefined);
        if (!allowed.has(e.note.instrumentId)) return;
        send('quote', { ...e.note, sourceLabel: quoteSourceLabel(e.note.source, e.note.channel), pushedAt: new Date().toISOString() });
      });
      const keepalive = setInterval(() => write(`: keepalive ${Date.now()}\n\n`), KEEPALIVE_MS);
      const recheck = setInterval(() => {
        void resolveSession(getDb(), token)
          .then((ok) => {
            if (!ok) {
              send('end', { reason: 'session ended' });
              cleanup?.();
            }
          })
          .catch(() => undefined);
      }, SESSION_RECHECK_MS);

      cleanup = () => {
        if (!open) return;
        open = false;
        unsubscribe();
        clearInterval(keepalive);
        clearInterval(recheck);
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };
      req.signal.addEventListener('abort', () => cleanup?.());

      write('retry: 3000\n\n');
      try {
        await snapshot();
      } catch {
        send('error', { message: 'Could not load quotes.' });
      }
    },
    cancel() {
      cleanup?.();
    }
  });

  return new Response(body, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
      'x-correlation-id': randomUUID()
    }
  });
});
