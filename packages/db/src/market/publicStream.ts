import { inflateRawSync, gunzipSync } from 'node:zlib';
import { backoffMs, clockOffsetMs, FEED_POLICY } from '@trendpilot/domain';

/**
 * Exchange-neutral lifecycle of a PUBLIC market-data WebSocket, shared by the MEXC and Bitunix
 * streams: connect timeout, keepalive ping with silence detection, exponential backoff with jitter
 * on reconnect, resubscription of every wanted symbol on each new socket, per-symbol confirmation,
 * clock samples from pongs, and a status snapshot. Subclasses supply only the wire protocol
 * (subscribe/unsubscribe/ping messages and frame handling). Public channels only: no login message,
 * key or signature is ever sent.
 */

/** The subset of the WHATWG WebSocket the stream uses (Node 22 global WebSocket, or a test fake). */
export interface WsLike {
  readonly readyState: number;
  binaryType?: string;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code?: number; reason?: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}
export type WsFactory = (url: string) => WsLike;

const WS_OPEN = 1;

export type StreamState = 'IDLE' | 'CONNECTING' | 'OPEN' | 'CLOSED' | 'STOPPED';

export interface TickerStreamStatus {
  url: string;
  state: StreamState;
  connectedSince: string | null;
  lastMessageAt: string | null;
  lastPongAt: string | null;
  /** Sockets opened after the first one. */
  reconnects: number;
  /** Consecutive failed connection attempts (resets on the first message of a socket). */
  failures: number;
  nextReconnectAt: string | null;
  lastError: string | null;
  lastCloseCode: number | null;
  /** Symbols we want; `confirmed` have produced a price push on the current socket. */
  subscribed: string[];
  confirmed: string[];
  subscribeAcks: number;
  tickersReceived: number;
}

/** Read-only view the MarketFeed uses to judge socket connectivity. */
export interface TickerStreamView {
  connected(): boolean;
  /** When the current socket opened (null while disconnected). */
  connectedSince(): Date | null;
  /** When the subscription for this symbol was sent on the current socket (null if not subscribed). */
  subscribedSince?(exchangeSymbol: string): Date | null;
}

export interface PublicStreamOptions {
  url: string;
  factory?: WsFactory;
  /** Exchange clock offset from a ping/pong round trip (positive = exchange ahead). */
  onClockSample?: (offsetMs: number) => void;
  log?: (m: string) => void;
  now?: () => Date;
  rand?: () => number;
  pingMs?: number;
  silenceMs?: number;
  connectTimeoutMs?: number;
}

/** One message to send and how it is logged. */
export interface Outgoing {
  msg: object;
  what: string;
  /** Symbols this message subscribes (their subscribe time starts when it is sent). */
  symbols?: string[];
}

const defaultFactory: WsFactory = (url) => {
  const Ctor = (globalThis as { WebSocket?: new (u: string) => WsLike }).WebSocket;
  if (!Ctor) throw new Error('This Node.js has no global WebSocket (Node 22+ required).');
  return new Ctor(url);
};

/** Text frame, or a (possibly gzip/deflate-compressed) binary frame → string. */
export function frameText(data: unknown): string {
  if (typeof data === 'string') return data;
  let buf: Buffer;
  if (data instanceof ArrayBuffer) buf = Buffer.from(data);
  else if (ArrayBuffer.isView(data)) buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  else throw new Error('ws: unsupported frame type');
  if (buf[0] === 0x1f && buf[1] === 0x8b) return gunzipSync(buf).toString('utf8');
  const text = buf.toString('utf8');
  if (text.startsWith('{')) return text;
  return inflateRawSync(buf).toString('utf8');
}

export abstract class PublicStreamSocket implements TickerStreamView {
  protected readonly url: string;
  private readonly factory: WsFactory;
  protected readonly log: (m: string) => void;
  protected readonly now: () => Date;
  private readonly rand: () => number;
  private readonly pingMs: number;
  private readonly silenceMs: number;
  private readonly connectTimeoutMs: number;
  private readonly onClockSample?: (offsetMs: number) => void;

  private ws: WsLike | null = null;
  private state: StreamState = 'IDLE';
  protected readonly wanted = new Set<string>();
  protected readonly confirmed = new Set<string>();
  private readonly subscribedAt = new Map<string, Date>();
  private opened = 0;
  private failures = 0;
  private openedAt: Date | null = null;
  private lastMessageAt: Date | null = null;
  private lastPongAt: Date | null = null;
  private pingSentAt: number | null = null;
  private nextReconnectAt: Date | null = null;
  protected lastError: string | null = null;
  private lastCloseCode: number | null = null;
  protected acks = 0;
  protected tickers = 0;
  private gotMessageOnSocket = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;

  constructor(o: PublicStreamOptions) {
    this.url = o.url;
    this.factory = o.factory ?? defaultFactory;
    this.log = o.log ?? (() => {});
    this.now = o.now ?? (() => new Date());
    this.rand = o.rand ?? Math.random;
    this.pingMs = o.pingMs ?? FEED_POLICY.streamPingMs;
    this.silenceMs = o.silenceMs ?? FEED_POLICY.streamSilenceMs;
    this.connectTimeoutMs = o.connectTimeoutMs ?? FEED_POLICY.streamConnectTimeoutMs;
    this.onClockSample = o.onClockSample;
  }

  /* ─── protocol hooks ─── */

  /** Whether a symbol is in this exchange's format (others are ignored by setSymbols). */
  protected abstract isSymbol(s: string): boolean;
  /** Messages that subscribe these symbols (on open: every wanted symbol; later: additions). */
  protected abstract subscribeMessages(symbols: string[]): Outgoing[];
  protected abstract unsubscribeMessages(symbols: string[]): Outgoing[];
  protected abstract pingMessage(nowMs: number): object;
  /** One parsed JSON frame. Call `confirm`, `notePong`, `noteAck` as the protocol requires. */
  protected abstract onFrame(msg: Record<string, unknown>, at: Date): void;
  /** A socket just opened (after resubscription and the first ping). Private streams log in here. */
  protected onOpened(): void {}
  /** The current socket is gone (network, silence, forced). Not called by stop(). */
  protected onClosed(): void {}

  /* ─── helpers for subclasses ─── */

  /** A pong arrived; `serverMs` (exchange clock) turns the round trip into a clock sample. */
  protected notePong(at: Date, serverMs: unknown): void {
    this.lastPongAt = at;
    if (this.pingSentAt !== null && typeof serverMs === 'number' && Number.isFinite(serverMs)) {
      this.onClockSample?.(clockOffsetMs(this.pingSentAt, serverMs, at.getTime()));
    }
    this.pingSentAt = null;
  }

  /** First push for a symbol on this socket? Records it either way; returns whether it was new. */
  protected confirm(sym: string): boolean {
    if (this.confirmed.has(sym)) return false;
    this.confirmed.add(sym);
    return true;
  }

  /* ─── public API ─── */

  connected(): boolean {
    return this.state === 'OPEN';
  }

  connectedSince(): Date | null {
    return this.state === 'OPEN' ? this.openedAt : null;
  }

  subscribedSince(exchangeSymbol: string): Date | null {
    return this.state === 'OPEN' ? (this.subscribedAt.get(exchangeSymbol) ?? null) : null;
  }

  status(): TickerStreamStatus {
    const iso = (d: Date | null) => (d ? d.toISOString() : null);
    return {
      url: this.url,
      state: this.state,
      connectedSince: iso(this.connectedSince()),
      lastMessageAt: iso(this.lastMessageAt),
      lastPongAt: iso(this.lastPongAt),
      reconnects: Math.max(0, this.opened - 1),
      failures: this.failures,
      nextReconnectAt: iso(this.nextReconnectAt),
      lastError: this.lastError,
      lastCloseCode: this.lastCloseCode,
      subscribed: [...this.wanted].sort(),
      confirmed: [...this.confirmed].sort(),
      subscribeAcks: this.acks,
      tickersReceived: this.tickers
    };
  }

  start(): void {
    if (this.state !== 'IDLE' && this.state !== 'STOPPED') return;
    this.state = 'CLOSED';
    this.connect();
  }

  stop(): void {
    this.state = 'STOPPED';
    this.clearTimers();
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      this.detach(ws);
      try {
        ws.close(1000, 'feed stopping');
      } catch {
        /* already closed */
      }
    }
  }

  /** Desired symbol set. New symbols are subscribed now (when open), removed ones unsubscribed. */
  setSymbols(symbols: Iterable<string>): void {
    const next = new Set([...symbols].filter((s) => this.isSymbol(s)));
    const added = [...next].filter((s) => !this.wanted.has(s));
    const removed = [...this.wanted].filter((s) => !next.has(s));
    for (const s of removed) {
      this.wanted.delete(s);
      this.confirmed.delete(s);
      this.subscribedAt.delete(s);
    }
    if (removed.length) for (const o of this.unsubscribeMessages(removed)) this.send(o.msg, o.what);
    for (const s of added) this.wanted.add(s);
    if (added.length) this.subscribe(added);
  }

  /** Drops the current socket as if the network failed; the normal reconnect path takes over. */
  forceDisconnect(reason = 'forced disconnect'): void {
    const ws = this.ws;
    if (!ws) return;
    this.log(`ws: ${reason}; closing socket`);
    this.onSocketGone(ws, 4000, reason);
    try {
      ws.close(4000, reason.slice(0, 100));
    } catch {
      /* ignore */
    }
  }

  /* ─── lifecycle ─── */

  private subscribe(symbols: string[]): void {
    const at = this.now();
    for (const o of this.subscribeMessages(symbols)) {
      if (!this.send(o.msg, o.what)) continue;
      for (const s of o.symbols ?? []) this.subscribedAt.set(s, at);
    }
  }

  protected send(msg: object, what: string): boolean {
    const ws = this.ws;
    if (!ws || this.state !== 'OPEN' || ws.readyState !== WS_OPEN) return false;
    try {
      ws.send(JSON.stringify(msg));
      if (what !== 'ping') this.log(`ws: → ${what}`);
      return true;
    } catch (e) {
      this.log(`ws: send ${what} failed: ${(e as Error).message}`);
      return false;
    }
  }

  private connect(): void {
    if (this.state === 'STOPPED') return;
    this.nextReconnectAt = null;
    this.state = 'CONNECTING';
    this.gotMessageOnSocket = false;
    let ws: WsLike;
    try {
      ws = this.factory(this.url);
    } catch (e) {
      this.lastError = (e as Error).message;
      this.state = 'CLOSED';
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    try {
      ws.binaryType = 'arraybuffer';
    } catch {
      /* not supported by the implementation */
    }
    this.log(`ws: connecting to ${this.url}`);
    this.connectTimer = setTimeout(() => {
      if (this.ws === ws && this.state === 'CONNECTING') {
        this.lastError = `no connection within ${this.connectTimeoutMs} ms`;
        this.log(`ws: ${this.lastError}`);
        this.onSocketGone(ws, null, this.lastError);
        try {
          ws.close();
        } catch {
          /* ignore */
        }
      }
    }, this.connectTimeoutMs);
    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.clearConnectTimer();
      this.state = 'OPEN';
      this.opened += 1;
      this.openedAt = this.now();
      this.lastMessageAt = this.openedAt;
      this.confirmed.clear();
      this.log(`ws: connected${this.opened > 1 ? ` (reconnect #${this.opened - 1})` : ''}; subscribing ${this.wanted.size} contract(s)`);
      if (this.wanted.size) this.subscribe([...this.wanted]);
      this.ping();
      this.pingTimer = setInterval(() => this.keepalive(), this.pingMs);
      this.onOpened();
    };
    ws.onmessage = (ev) => {
      if (this.ws === ws) this.onMessage(ev.data);
    };
    ws.onerror = (ev) => {
      if (this.ws !== ws) return;
      const m = (ev as { message?: string; error?: Error })?.message ?? (ev as { error?: Error })?.error?.message ?? 'socket error';
      this.lastError = m;
      this.log(`ws: error: ${m}`);
    };
    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      this.onSocketGone(ws, ev?.code ?? null, ev?.reason || `closed (code ${ev?.code ?? '?'})`);
    };
  }

  private detach(ws: WsLike): void {
    ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
  }

  private onSocketGone(ws: WsLike, code: number | null, reason: string): void {
    if (this.ws !== ws) return;
    this.detach(ws);
    this.ws = null;
    this.clearTimers();
    this.lastCloseCode = code;
    const wasOpen = this.state === 'OPEN';
    this.confirmed.clear();
    this.subscribedAt.clear();
    this.onClosed();
    if (this.state === 'STOPPED') return;
    this.state = 'CLOSED';
    this.openedAt = null;
    if (!this.gotMessageOnSocket) this.failures += 1;
    else this.failures = 1;
    this.log(`ws: ${wasOpen ? 'disconnected' : 'connection failed'}: ${reason}`);
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.state === 'STOPPED') return;
    const delay = backoffMs(Math.max(1, this.failures), this.rand(), FEED_POLICY.streamBackoffBaseMs, FEED_POLICY.streamBackoffMaxMs);
    this.nextReconnectAt = new Date(this.now().getTime() + delay);
    this.log(`ws: reconnecting in ${delay} ms (attempt ${this.failures})`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private clearConnectTimer(): void {
    if (this.connectTimer) clearTimeout(this.connectTimer);
    this.connectTimer = null;
  }

  private clearTimers(): void {
    this.clearConnectTimer();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.reconnectTimer = null;
    this.pingTimer = null;
    this.pingSentAt = null;
  }

  private ping(): void {
    const t = this.now().getTime();
    if (this.send(this.pingMessage(t), 'ping')) this.pingSentAt = t;
  }

  /** Every pingMs: drop a silent socket, otherwise ping. */
  private keepalive(): void {
    const ws = this.ws;
    if (!ws || this.state !== 'OPEN') return;
    const silent = this.now().getTime() - (this.lastMessageAt?.getTime() ?? 0);
    if (silent > this.silenceMs) {
      this.lastError = `no message for ${Math.round(silent / 1000)} s`;
      this.forceDisconnect(this.lastError);
      return;
    }
    this.ping();
  }

  private onMessage(raw: unknown): void {
    const at = this.now();
    this.lastMessageAt = at;
    if (!this.gotMessageOnSocket) {
      this.gotMessageOnSocket = true;
      this.failures = 0;
    }
    let msg: Record<string, unknown>;
    try {
      const parsed = JSON.parse(frameText(raw)) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not a JSON object');
      msg = parsed as Record<string, unknown>;
    } catch (e) {
      this.log(`ws: unreadable frame: ${(e as Error).message}`);
      return;
    }
    this.onFrame(msg, at);
  }
}
