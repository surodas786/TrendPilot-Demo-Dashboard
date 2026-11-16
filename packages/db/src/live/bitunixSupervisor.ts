import { and, eq, ne, sql } from 'drizzle-orm';
import type { Db } from '../client';
import { exchangeConnections } from '../schema';
import { bitunixCredentialsOf, bitunixRequesterFor } from './bitunixConnection';
import type { BitunixCredentials, BitunixRequester } from './bitunixPrivate';
import { BitunixPrivateStream, type BitunixPrivateEvent, type BitunixPrivateStreamOptions } from './bitunixPrivateWs';
import { applyBitunixEvent, syncBitunixConnection, type BitunixSyncResult } from './bitunixSync';
import type { ConnectionRow } from './liveMode';

/**
 * Runs the Bitunix private account sync for every VERIFIED Bitunix connection, in the worker:
 *  - one authenticated private WebSocket per connection (one investor's key per session);
 *  - every push and every REST reconciliation for a connection runs on ONE serialized queue, so
 *    pushes that arrive while a REST snapshot is being taken are applied after it, against the
 *    state it wrote (older ones are then ignored by business time, newer ones win);
 *  - a REST reconciliation runs on every login (startup and each reconnect: it covers the gap
 *    while disconnected), when a push needs confirmation, and every `syncEveryMs`;
 *  - a replaced key (credential rotation) restarts the session; a rejected login stops it until
 *    the key changes or `authRetryMs` passes; a removed / failed connection stops it.
 * Private stream health is written to `exchange_connections.stream_state` (separate from the
 * public price feed's health, which lives in the market-feed heartbeat).
 */

export interface SupervisorOptions {
  env?: Record<string, string | undefined>;
  log?: (m: string) => void;
  syncEveryMs?: number;
  authRetryMs?: number;
  /** Tests: stand-ins for the socket and the REST transport. */
  streamFactory?: (o: BitunixPrivateStreamOptions) => Pick<BitunixPrivateStream, 'start' | 'stop' | 'status'>;
  requesterFor?: (conn: ConnectionRow) => BitunixRequester;
  now?: () => Date;
}

interface Session {
  connectionId: string;
  ownerId: string;
  keyStamp: string;
  stream: Pick<BitunixPrivateStream, 'start' | 'stop' | 'status'>;
  chain: Promise<unknown>;
  lastSyncAt: number;
  syncQueued: boolean;
  authFailedAt: number | null;
  lastWrittenState: string;
}

export class BitunixAccountSupervisor {
  private readonly sessions = new Map<string, Session>();
  private readonly log: (m: string) => void;
  private readonly env: Record<string, string | undefined>;
  private readonly syncEveryMs: number;
  private readonly authRetryMs: number;
  private readonly now: () => Date;
  private stopped = false;
  readonly results: BitunixSyncResult[] = [];

  constructor(
    private readonly db: Db,
    private readonly o: SupervisorOptions = {}
  ) {
    this.env = o.env ?? process.env;
    this.log = o.log ?? (() => {});
    this.syncEveryMs = o.syncEveryMs ?? 60_000;
    this.authRetryMs = o.authRetryMs ?? 15 * 60_000;
    this.now = o.now ?? (() => new Date());
  }

  get sessionCount(): number {
    return this.sessions.size;
  }

  /** The key identity: a replaced key (same or different fingerprint) changes the sealed value. */
  private static stamp(c: ConnectionRow): string {
    return `${c.apiKeySealed.slice(-24)}:${c.secretSealed.slice(-24)}`;
  }

  private requester(conn: ConnectionRow): BitunixRequester {
    return this.o.requesterFor ? this.o.requesterFor(conn) : bitunixRequesterFor(conn, this.env);
  }

  /** Serializes work for one connection; failures are logged, never thrown into the queue. */
  private enqueue(s: Session, what: string, fn: () => Promise<unknown>): Promise<unknown> {
    const run = s.chain.then(fn).catch((e) => this.log(`bitunix ${s.connectionId}: ${what} failed: ${(e as Error).message}`));
    s.chain = run;
    return run;
  }

  private queueSync(s: Session, reason: string): void {
    if (s.syncQueued || this.stopped) return;
    s.syncQueued = true;
    void this.enqueue(s, `sync (${reason})`, async () => {
      s.syncQueued = false;
      const r = await syncBitunixConnection(this.db, s.connectionId, this.requester(await this.load(s.connectionId)), { now: this.now });
      s.lastSyncAt = this.now().getTime();
      this.results.push(r);
      if (this.results.length > 50) this.results.shift();
      if (!r.ok && !r.busy) this.log(`bitunix ${s.connectionId}: sync (${reason}) failed: ${r.error}`);
      else if (r.opened || r.reduced || r.closed || r.closePending || r.tpslConfirmed) this.log(`bitunix ${s.connectionId}: sync (${reason}) opened=${r.opened} reduced=${r.reduced} closed=${r.closed} closePending=${r.closePending} tpslConfirmed=${r.tpslConfirmed}`);
      await this.writeStreamState(s);
    });
  }

  private async load(connectionId: string): Promise<ConnectionRow> {
    const [c] = await this.db.select().from(exchangeConnections).where(eq(exchangeConnections.id, connectionId));
    if (!c) throw new Error('connection removed');
    return c;
  }

  private onEvent(s: Session, e: BitunixPrivateEvent): void {
    void this.enqueue(s, `${e.channel} event`, async () => {
      const r = await applyBitunixEvent(this.db, await this.load(s.connectionId), e);
      if (r.needsSync) this.queueSync(s, `${e.channel} push`);
    });
  }

  private async writeStreamState(s: Session): Promise<void> {
    const st = s.stream.status() as unknown as Record<string, unknown>;
    const state = {
      state: st.state,
      auth: st.auth ?? null,
      authError: st.authError ?? null,
      connectedSince: st.connectedSince ?? null,
      readyAt: st.readyAt ?? null,
      lastMessageAt: st.lastMessageAt ?? null,
      reconnects: st.reconnects ?? 0,
      lastError: st.lastError ?? null,
      events: st.events ?? {},
      updatedAt: this.now().toISOString()
    };
    const key = JSON.stringify({ ...state, lastMessageAt: null, updatedAt: null, events: null });
    if (key === s.lastWrittenState && this.now().getTime() - s.lastSyncAt < 30_000) return;
    s.lastWrittenState = key;
    await this.db.update(exchangeConnections).set({ streamState: state }).where(eq(exchangeConnections.id, s.connectionId));
  }

  private start(c: ConnectionRow): void {
    const s: Session = { connectionId: c.id, ownerId: c.ownerId, keyStamp: BitunixAccountSupervisor.stamp(c), stream: null as never, chain: Promise.resolve(), lastSyncAt: 0, syncQueued: false, authFailedAt: null, lastWrittenState: '' };
    // Unsealed on the first login of this session only; a replaced key starts a new session.
    let credentials: BitunixCredentials | null = null;
    const streamOptions: BitunixPrivateStreamOptions = {
      url: this.env.BITUNIX_PRIVATE_WS_URL || undefined,
      credentials: () => (credentials ??= bitunixCredentialsOf(c)),
      log: (m) => this.log(`bitunix ${c.id} ${m}`),
      onEvent: (e) => this.onEvent(s, e),
      onReady: () => {
        s.authFailedAt = null;
        this.queueSync(s, 'login');
        void this.writeStreamState(s).catch(() => undefined);
      },
      onAuthFailed: (msg) => {
        s.authFailedAt = this.now().getTime();
        this.log(`bitunix ${c.id}: login rejected (${msg}); waiting for a new key or ${Math.round(this.authRetryMs / 60_000)} min`);
        void this.writeStreamState(s).catch(() => undefined);
      }
    };
    s.stream = this.o.streamFactory ? this.o.streamFactory(streamOptions) : new BitunixPrivateStream(streamOptions);
    this.sessions.set(c.id, s);
    s.stream.start();
    this.log(`bitunix ${c.id}: private session started for owner ${c.ownerId}`);
  }

  private async stopSession(s: Session, why: string): Promise<void> {
    this.sessions.delete(s.connectionId);
    s.stream.stop();
    await s.chain.catch(() => undefined);
    this.log(`bitunix ${s.connectionId}: private session stopped (${why})`);
    await this.db
      .update(exchangeConnections)
      .set({ streamState: sql`${exchangeConnections.streamState} || ${JSON.stringify({ state: 'STOPPED', auth: null, stoppedReason: why, updatedAt: this.now().toISOString() })}::jsonb` })
      .where(eq(exchangeConnections.id, s.connectionId))
      .catch(() => undefined);
  }

  /** Brings sessions in line with the connections table, then runs due periodic syncs. */
  async tick(): Promise<void> {
    if (this.stopped) return;
    const conns = await this.db
      .select()
      .from(exchangeConnections)
      .where(and(eq(exchangeConnections.exchange, 'BITUNIX'), eq(exchangeConnections.status, 'VERIFIED'), ne(exchangeConnections.apiKeySealed, '')));
    const wanted = new Map(conns.map((c) => [c.id, c]));
    for (const s of [...this.sessions.values()]) {
      const c = wanted.get(s.connectionId);
      if (!c) await this.stopSession(s, 'connection no longer verified');
      else if (BitunixAccountSupervisor.stamp(c) !== s.keyStamp) await this.stopSession(s, 'API key replaced');
      else if (s.authFailedAt !== null && this.now().getTime() - s.authFailedAt >= this.authRetryMs) await this.stopSession(s, 'retrying after a rejected login');
    }
    for (const c of conns) if (!this.sessions.has(c.id)) this.start(c);
    const t = this.now().getTime();
    for (const s of this.sessions.values()) {
      if (s.authFailedAt === null && t - s.lastSyncAt >= this.syncEveryMs) this.queueSync(s, 'periodic');
      await this.writeStreamState(s).catch(() => undefined);
    }
  }

  /** Waits for every queued push and sync (tests). */
  async idle(): Promise<void> {
    for (let i = 0; i < 5; i++) await Promise.all([...this.sessions.values()].map((s) => s.chain));
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const s of [...this.sessions.values()]) await this.stopSession(s, 'worker stopping');
  }
}
