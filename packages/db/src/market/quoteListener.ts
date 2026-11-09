import pg from 'pg';
import { QUOTE_NOTIFY_CHANNEL, type QuoteNotification } from '../paper/exits';

/**
 * One Postgres LISTEN connection per web process, fanned out to every live-quote subscriber
 * (each browser session's SSE stream). Browsers never reach MEXC; they receive what the feed
 * process stored, the moment its transaction commits.
 */
export type QuoteHubEvent = { kind: 'quote'; note: QuoteNotification } | { kind: 'resync' };

export interface QuoteListenerOptions {
  connectionString: string;
  log?: (m: string) => void;
}

export class QuoteListener {
  private client: pg.Client | null = null;
  private readonly subs = new Set<(e: QuoteHubEvent) => void>();
  private connecting = false;
  private failures = 0;
  private everConnected = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  connectedSince: Date | null = null;

  constructor(private readonly o: QuoteListenerOptions) {}

  get subscribers(): number {
    return this.subs.size;
  }

  subscribe(fn: (e: QuoteHubEvent) => void): () => void {
    this.subs.add(fn);
    if (!this.client && !this.connecting && !this.timer) void this.connect();
    return () => {
      this.subs.delete(fn);
    };
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    const c = this.client;
    this.client = null;
    await c?.end().catch(() => undefined);
  }

  private emit(e: QuoteHubEvent): void {
    for (const fn of this.subs) {
      try {
        fn(e);
      } catch {
        /* a broken subscriber must not stop the others */
      }
    }
  }

  private async connect(): Promise<void> {
    if (this.closed) return;
    this.connecting = true;
    const c = new pg.Client({ connectionString: this.o.connectionString });
    c.on('notification', (m) => {
      if (m.channel !== QUOTE_NOTIFY_CHANNEL || !m.payload) return;
      try {
        this.emit({ kind: 'quote', note: JSON.parse(m.payload) as QuoteNotification });
      } catch {
        /* ignore malformed payloads */
      }
    });
    const lost = (why: string) => {
      if (this.client !== c) return;
      this.client = null;
      this.connectedSince = null;
      c.end().catch(() => undefined);
      this.o.log?.(`quote listener lost (${why}); reconnecting`);
      this.schedule();
    };
    c.on('error', (e) => lost(e.message));
    c.on('end', () => lost('connection ended'));
    try {
      await c.connect();
      await c.query(`LISTEN ${QUOTE_NOTIFY_CHANNEL}`);
      this.client = c;
      this.connectedSince = new Date();
      this.failures = 0;
      // Quotes stored while we were not listening are picked up by a fresh snapshot.
      if (this.everConnected) this.emit({ kind: 'resync' });
      this.everConnected = true;
    } catch (e) {
      c.end().catch(() => undefined);
      this.o.log?.(`quote listener connect failed: ${(e as Error).message}`);
      this.schedule();
    } finally {
      this.connecting = false;
    }
  }

  private schedule(): void {
    if (this.closed || this.timer) return;
    this.failures += 1;
    const delay = Math.min(30_000, 500 * 2 ** Math.min(6, this.failures - 1));
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.connect();
    }, delay);
  }
}
