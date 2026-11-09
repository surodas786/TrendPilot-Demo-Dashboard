import { inflateRawSync, gunzipSync } from 'node:zlib';
import { backoffMs, clockOffsetMs, FEED_POLICY } from '@trendpilot/domain';
import { isMexcFuturesSymbol, MexcPublicError, tickerFromData, type MexcTicker } from './mexcPublic';

/**
 * MEXC Futures PUBLIC WebSocket ticker stream (MKT-01). One socket per feed process carries every
 * covered contract, so subscriptions are shared by all investors and browser sessions: browsers
 * never talk to MEXC, they read TrendPilot's stored quotes.
 *
 *   → {"method":"sub.ticker","param":{"symbol":"BTC_USDT"}}     ← {"channel":"rs.sub.ticker","data":"success"}
 *   ← {"channel":"push.ticker","symbol":"BTC_USDT","data":{bid1, ask1, fairPrice, lastPrice, timestamp, …},"ts":…}
 *   → {"method":"ping"}                                          ← {"channel":"pong","data":<server ms>}
 *
 * Public channels only: no login message, no API key, no signature is ever sent. MEXC closes a
 * socket that has not pinged for 60 s; we ping every 15 s and use each pong as a clock sample.
 * Reconnects back off exponentially with jitter, and every active subscription is re-sent on open.
 *
 * Docs: https://www.mexc.com/api-docs/futures/websocket-api
 */

export const MEXC_WS_DEFAULT_URL = 'wss://contract.mexc.com/edge';

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

export interface StreamTicker extends MexcTicker {
  /** Local time the push was received by this process. */
  receivedAt: Date;
}

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
  /** Symbols we want; `confirmed` have produced a push.ticker on the current socket. */
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
}

export interface MexcTickerStreamOptions {
  url?: string;
  factory?: WsFactory;
  onTicker: (t: StreamTicker) => void;
  /** Exchange clock offset from a ping/pong round trip (positive = exchange ahead). */
  onClockSample?: (offsetMs: number) => void;
  log?: (m: string) => void;
  now?: () => Date;
  rand?: () => number;
  pingMs?: number;
  silenceMs?: number;
  connectTimeoutMs?: number;
  /** Log every push.ticker (verbose; for verification runs). */
  logTicks?: boolean;
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
  else throw new MexcPublicError('ws: unsupported frame type', 'PARSE');
  if (buf[0] === 0x1f && buf[1] === 0x8b) return gunzipSync(buf).toString('utf8');
  const text = buf.toString('utf8');
  if (text.startsWith('{')) return text;
  return inflateRawSync(buf).toString('utf8');
}

export interface WsMessage {
  channel?: string;
  symbol?: string;
  data?: unknown;
  ts?: number;
}

/** A `push.ticker` frame → ticker. Throws MexcPublicError(PARSE) on anything malformed. */
export function parseWsTicker(msg: WsMessage, receivedAt: Date): StreamTicker {
  const d = msg.data as Record<string, unknown> | undefined;
  const sym = typeof d?.symbol === 'string' ? d.symbol : msg.symbol;
  if (typeof sym !== 'string' || !isMexcFuturesSymbol(sym)) throw new MexcPublicError(`push.ticker: bad symbol ${String(sym)}`, 'PARSE');
  return { ...tickerFromData(d, sym), receivedAt };
}

export class MexcTickerStream implements TickerStreamView {
  private readonly url: string;
  private readonly factory: WsFactory;
  private readonly log: (m: string) => void;
  private readonly now: () => Date;
  private readonly rand: () => number;
  private readonly pingMs: number;
  private readonly silenceMs: number;
  private readonly connectTimeoutMs: number;

  private ws: WsLike | null = null;
  private state: StreamState = 'IDLE';
  private readonly wanted = new Set<string>();
  private readonly confirmed = new Set<string>();
  private opened = 0;
  private failures = 0;
  private openedAt: Date | null = null;
  private lastMessageAt: Date | null = null;
  private lastPongAt: Date | null = null;
  private pingSentAt: number | null = null;
  private nextReconnectAt: Date | null = null;
  private lastError: string | null = null;
  private lastCloseCode: number | null = null;
  private acks = 0;
  private tickers = 0;
  private gotMessageOnSocket = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly o: MexcTickerStreamOptions) {
    this.url = o.url ?? MEXC_WS_DEFAULT_URL;
    this.factory = o.factory ?? defaultFactory;
    this.log = o.log ?? (() => {});
    this.now = o.now ?? (() => new Date());
    this.rand = o.rand ?? Math.random;
    this.pingMs = o.pingMs ?? FEED_POLICY.streamPingMs;
    this.silenceMs = o.silenceMs ?? FEED_POLICY.streamSilenceMs;
    this.connectTimeoutMs = o.connectTimeoutMs ?? FEED_POLICY.streamConnectTimeoutMs;
  }

  connected(): boolean {
    return this.state === 'OPEN';
  }

  connectedSince(): Date | null {
    return this.state === 'OPEN' ? this.openedAt : null;
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

  /** Desired contract set. New symbols are subscribed now (when open), removed ones unsubscribed. */
  setSymbols(symbols: Iterable<string>): void {
    const next = new Set([...symbols].filter(isMexcFuturesSymbol));
    const added = [...next].filter((s) => !this.wanted.has(s));
    const removed = [...this.wanted].filter((s) => !next.has(s));
    for (const s of removed) {
      this.wanted.delete(s);
      this.confirmed.delete(s);
      this.send({ method: 'unsub.ticker', param: { symbol: s } }, `unsub.ticker ${s}`);
    }
    for (const s of added) {
      this.wanted.add(s);
      this.send({ method: 'sub.ticker', param: { symbol: s } }, `sub.ticker ${s}`);
    }
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

  private send(msg: object, what: string): boolean {
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
      for (const s of this.wanted) this.send({ method: 'sub.ticker', param: { symbol: s } }, `sub.ticker ${s}`);
      this.ping();
      this.pingTimer = setInterval(() => this.keepalive(), this.pingMs);
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
    if (this.send({ method: 'ping' }, 'ping')) this.pingSentAt = this.now().getTime();
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
    let msg: WsMessage;
    try {
      msg = JSON.parse(frameText(raw)) as WsMessage;
    } catch (e) {
      this.log(`ws: unreadable frame: ${(e as Error).message}`);
      return;
    }
    switch (msg.channel) {
      case 'push.ticker': {
        let t: StreamTicker;
        try {
          t = parseWsTicker(msg, at);
        } catch (e) {
          this.log(`ws: ${(e as Error).message}`);
          return;
        }
        if (!this.wanted.has(t.exchangeSymbol)) return; // late push after an unsubscribe
        this.tickers += 1;
        if (!this.confirmed.has(t.exchangeSymbol)) {
          this.confirmed.add(t.exchangeSymbol);
          this.log(`ws: ← first push.ticker ${t.exchangeSymbol} bid=${t.bid} ask=${t.ask} mark=${t.mark} ts=${new Date(t.exchangeTimeMs).toISOString()}`);
        } else if (this.o.logTicks) {
          this.log(`ws: ← push.ticker ${t.exchangeSymbol} bid=${t.bid} ask=${t.ask} mark=${t.mark} ts=${new Date(t.exchangeTimeMs).toISOString()}`);
        }
        this.o.onTicker(t);
        return;
      }
      case 'pong': {
        this.lastPongAt = at;
        if (this.pingSentAt !== null && typeof msg.data === 'number' && Number.isFinite(msg.data)) {
          this.o.onClockSample?.(clockOffsetMs(this.pingSentAt, msg.data, at.getTime()));
        }
        this.pingSentAt = null;
        return;
      }
      case 'rs.sub.ticker':
        if (msg.data === 'success') this.acks += 1;
        this.log(`ws: ← rs.sub.ticker ${typeof msg.data === 'string' ? msg.data : JSON.stringify(msg.data)}`);
        return;
      case 'rs.unsub.ticker':
        return;
      default:
        if (msg.channel?.startsWith('rs.error') || msg.channel === 'rs.error') {
          this.lastError = `MEXC: ${JSON.stringify(msg.data)}`;
          this.log(`ws: ← ${msg.channel} ${JSON.stringify(msg.data)}`);
        }
    }
  }
}
