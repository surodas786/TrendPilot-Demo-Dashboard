import { createHash, randomBytes } from 'node:crypto';
import { Decimal } from '@trendpilot/domain';
import { PublicStreamSocket, type Outgoing, type PublicStreamOptions } from '../market/publicStream';
import { originOf, type Origin, type Side } from './bitunixAccount';
import type { BitunixCredentials } from './bitunixPrivate';

/**
 * Bitunix Futures PRIVATE WebSocket (wss://fapi.bitunix.com/private/), one authenticated session
 * per investor connection, backend only. Read-only: it logs in and listens; it never sends an
 * order message.
 *
 * Documented (websocket/prepare/WebSocket.html, private channel pages, read 2026-11-16):
 *  - login: {"op":"login","args":[{apiKey, timestamp, nonce, sign}]}, timestamp in Unix SECONDS,
 *    sign = sha256hex(sha256hex(nonce + timestamp + apiKey) + secretKey). This differs from the
 *    REST signer (Unix ms, sorted query + body); both are kept separately.
 *  - channels: `tpsl` is pushed automatically after login; `order`, `position` and `balance`
 *    "Subscribe the … channel" (no example), so one subscribe message for the three is sent after
 *    login. At most 5 messages per second per connection; ping {"op":"ping","ping":<s>}.
 *  - `ts` is the gateway send time (ms) and must not order business events; order and tpsl carry
 *    ISO-8601 nanosecond `ctime` / `mtime` strings.
 * Observed on the live server with an invalid key (fixtures/bitunix-private/ws-observed.json):
 *  - on open: {"op":"connect","data":{"result":true}}; the private pong has no ms `ts`;
 *  - failed login: {"op":"login","data":{"result":false,"msg":"…Token invalid","nonce":…}} and the
 *    server keeps the socket open; subscribes before login get no answer.
 *
 * Auth failure stops the stream (no reconnect loop with a bad key); the supervisor restarts it when
 * the key is replaced or after a cooldown. Login frames, keys and signatures are never logged.
 */

export const BITUNIX_WS_PRIVATE_URL = 'wss://fapi.bitunix.com/private/';
/** Subscribed after login; `tpsl` arrives without a subscription. */
export const BITUNIX_PRIVATE_CHANNELS = ['balance', 'order', 'position'] as const;

const sha256Hex = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

/** WebSocket login signature: sha256(sha256(nonce + seconds + apiKey) + secret). */
export function signBitunixWsLogin(i: { nonce: string; timestampSec: number; apiKey: string; secretKey: string }): string {
  return sha256Hex(sha256Hex(`${i.nonce}${i.timestampSec}${i.apiKey}`) + i.secretKey);
}

export function buildBitunixLogin(creds: BitunixCredentials, nowMs: number, nonce: string = randomBytes(16).toString('hex')): { op: 'login'; args: [{ apiKey: string; timestamp: number; nonce: string; sign: string }] } {
  const timestampSec = Math.floor(nowMs / 1000);
  return { op: 'login', args: [{ apiKey: creds.apiKey, timestamp: timestampSec, nonce, sign: signBitunixWsLogin({ nonce, timestampSec, apiKey: creds.apiKey, secretKey: creds.secretKey }) }] };
}

/* ───────────────────────── Events ───────────────────────── */

interface EventBase {
  /** Gateway send time (ms). Ordering fallback only when no business time exists. */
  tsMs: number | null;
  receivedAt: Date;
  /** Arrival order on this process (monotonic). */
  seq: number;
}

export interface PositionEvent extends EventBase {
  channel: 'position';
  event: 'OPEN' | 'UPDATE' | 'CLOSE' | string;
  positionId: string;
  symbol: string;
  side: Side;
  qty: string | null;
  positionMode: string | null;
  marginMode: string | null;
  leverage: number | null;
  margin: string | null;
  realizedPNL: string | null;
  unrealizedPNL: string | null;
  fee: string | null;
  funding: string | null;
  ctimeMs: number | null;
}

export interface OrderEvent extends EventBase {
  channel: 'order';
  event: string;
  orderId: string;
  clientId: string | null;
  origin: Origin;
  symbol: string;
  side: string | null;
  type: string | null;
  status: string;
  qty: string | null;
  dealAmount: string | null;
  averagePrice: string | null;
  fee: string | null;
  ctimeMs: number | null;
  mtimeMs: number | null;
}

export interface BalanceEvent extends EventBase {
  channel: 'balance';
  coin: string;
  available: string | null;
  frozen: string | null;
  margin: string | null;
}

export interface TpslEvent extends EventBase {
  channel: 'tpsl';
  event: string;
  status: string;
  orderId: string;
  positionId: string | null;
  symbol: string;
  side: string | null;
  tpPrice: string | null;
  slPrice: string | null;
  tpQty: string | null;
  slQty: string | null;
  ctimeMs: number | null;
}

export type BitunixPrivateEvent = PositionEvent | OrderEvent | BalanceEvent | TpslEvent;

export class BitunixPrivateParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BitunixPrivateParseError';
  }
}

/** ISO-8601 with up to nanoseconds ("2024-05-16T08:13:09.123456789Z"), or ms digits → Unix ms. */
export function bitunixTimeMs(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) && v > 0 ? Math.trunc(v) : null;
  if (typeof v !== 'string' || !v) return null;
  if (/^\d{12,14}$/.test(v)) return Number(v);
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:?\d{2})$/.exec(v);
  if (!m) return null;
  const t = Date.parse(`${m[1]}.${(m[2] ?? '0').padEnd(3, '0').slice(0, 3)}${m[3]}`);
  return Number.isFinite(t) ? t : null;
}

const s = (v: unknown) => (v === null || v === undefined || v === '' ? null : String(v));
const d = (v: unknown, f: string): string | null => {
  if (v === null || v === undefined || v === '') return null;
  try {
    const x = new Decimal(v as Decimal.Value);
    if (!x.isFinite()) throw new Error();
    return x.toFixed();
  } catch {
    throw new BitunixPrivateParseError(`${f} is not a number`);
  }
};
const need = (v: unknown, f: string, ch: string): string => {
  if ((typeof v !== 'string' && typeof v !== 'number') || String(v) === '') throw new BitunixPrivateParseError(`${ch}: ${f} is missing`);
  return String(v);
};

/** One private channel frame → events (a frame may carry an object or a list). */
export function parseBitunixPrivateFrame(msg: Record<string, unknown>, receivedAt: Date, nextSeq: () => number): BitunixPrivateEvent[] {
  const ch = msg.ch;
  const tsMs = typeof msg.ts === 'number' && Number.isFinite(msg.ts) ? msg.ts : null;
  const rows = (Array.isArray(msg.data) ? msg.data : msg.data && typeof msg.data === 'object' ? [msg.data] : []) as Record<string, unknown>[];
  return rows.map((r): BitunixPrivateEvent => {
    const base = { tsMs, receivedAt, seq: nextSeq() };
    switch (ch) {
      case 'position': {
        const side = String(r.side ?? '').toUpperCase();
        if (side !== 'LONG' && side !== 'SHORT') throw new BitunixPrivateParseError(`position: unknown side ${JSON.stringify(r.side ?? null)}`);
        return {
          ...base,
          channel: 'position',
          event: String(r.event ?? 'UPDATE').toUpperCase(),
          positionId: need(r.positionId, 'positionId', 'position'),
          symbol: need(r.symbol, 'symbol', 'position'),
          side,
          qty: d(r.qty, 'qty'),
          positionMode: s(r.positionMode),
          marginMode: s(r.marginMode),
          leverage: r.leverage === undefined || r.leverage === null || r.leverage === '' ? null : Number(r.leverage),
          margin: d(r.margin, 'margin'),
          realizedPNL: d(r.realizedPNL, 'realizedPNL'),
          unrealizedPNL: d(r.unrealizedPNL, 'unrealizedPNL'),
          fee: d(r.fee, 'fee'),
          funding: d(r.funding, 'funding'),
          ctimeMs: bitunixTimeMs(r.ctime)
        };
      }
      case 'order': {
        const clientId = s(r.clientId);
        return {
          ...base,
          channel: 'order',
          event: String(r.event ?? '').toUpperCase(),
          orderId: need(r.orderId, 'orderId', 'order'),
          clientId,
          origin: originOf(clientId),
          symbol: need(r.symbol, 'symbol', 'order'),
          side: s(r.side),
          type: s(r.type ?? r.orderType),
          status: String(r.orderStatus ?? r.status ?? 'UNKNOWN').toUpperCase(),
          qty: d(r.qty, 'qty'),
          dealAmount: d(r.dealAmount, 'dealAmount'),
          averagePrice: d(r.averagePrice, 'averagePrice'),
          fee: d(r.fee, 'fee'),
          ctimeMs: bitunixTimeMs(r.ctime),
          mtimeMs: bitunixTimeMs(r.mtime)
        };
      }
      case 'balance':
        return { ...base, channel: 'balance', coin: need(r.coin, 'coin', 'balance').toUpperCase(), available: d(r.available, 'available'), frozen: d(r.frozen, 'frozen'), margin: d(r.margin, 'margin') };
      case 'tpsl':
        return {
          ...base,
          channel: 'tpsl',
          event: String(r.event ?? '').toUpperCase(),
          status: String(r.status ?? '').toUpperCase(),
          orderId: need(r.orderId ?? r.id, 'orderId', 'tpsl'),
          positionId: s(r.positionId),
          symbol: need(r.symbol, 'symbol', 'tpsl'),
          side: s(r.side),
          tpPrice: d(r.tpPrice, 'tpPrice'),
          slPrice: d(r.slPrice, 'slPrice'),
          tpQty: d(r.tpQty, 'tpQty'),
          slQty: d(r.slQty, 'slQty'),
          ctimeMs: bitunixTimeMs(r.ctime)
        };
      default:
        throw new BitunixPrivateParseError(`unknown private channel ${String(ch)}`);
    }
  });
}

/* ───────────────────────── Stream ───────────────────────── */

export type BitunixAuthState = 'DISCONNECTED' | 'LOGGING_IN' | 'AUTHENTICATED' | 'AUTH_FAILED';

export interface BitunixPrivateStreamStatus extends ReturnType<PublicStreamSocket['status']> {
  auth: BitunixAuthState;
  authError: string | null;
  lastLoginAt: string | null;
  readyAt: string | null;
  events: Record<string, number>;
  parseErrors: number;
}

export interface BitunixPrivateStreamOptions extends Partial<Omit<PublicStreamOptions, 'url' | 'onClockSample'>> {
  url?: string;
  /** Read at every login, so a replaced key is used on the next session. */
  credentials: () => BitunixCredentials;
  onEvent: (e: BitunixPrivateEvent) => void;
  /** Logged in and subscribed (startup and every reconnect): reconcile REST now. */
  onReady?: (at: Date) => void;
  /** Bitunix rejected the login; the stream has stopped. */
  onAuthFailed?: (message: string) => void;
  loginTimeoutMs?: number;
}

export class BitunixPrivateStream extends PublicStreamSocket {
  private auth: BitunixAuthState = 'DISCONNECTED';
  private authError: string | null = null;
  private lastLoginAt: Date | null = null;
  private readyAt: Date | null = null;
  private loginTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly counts: Record<string, number> = {};
  private parseErrors = 0;
  private seq = 0;

  constructor(private readonly p: BitunixPrivateStreamOptions) {
    super({ ...p, url: p.url ?? BITUNIX_WS_PRIVATE_URL });
  }

  /** Authenticated and subscribed. */
  authenticated(): boolean {
    return this.connected() && this.auth === 'AUTHENTICATED';
  }

  override status(): BitunixPrivateStreamStatus {
    return {
      ...super.status(),
      auth: this.auth,
      authError: this.authError,
      lastLoginAt: this.lastLoginAt?.toISOString() ?? null,
      readyAt: this.readyAt?.toISOString() ?? null,
      events: { ...this.counts },
      parseErrors: this.parseErrors
    };
  }

  override stop(): void {
    this.clearLoginTimer();
    super.stop();
  }

  protected isSymbol(): boolean {
    return false;
  }
  protected subscribeMessages(): Outgoing[] {
    return [];
  }
  protected unsubscribeMessages(): Outgoing[] {
    return [];
  }
  protected pingMessage(nowMs: number): object {
    return { op: 'ping', ping: Math.floor(nowMs / 1000) };
  }

  private clearLoginTimer(): void {
    if (this.loginTimer) clearTimeout(this.loginTimer);
    this.loginTimer = null;
  }

  protected override onOpened(): void {
    let creds: BitunixCredentials;
    try {
      creds = this.p.credentials();
    } catch (e) {
      this.failAuth(`credentials unavailable: ${(e as Error).message}`);
      return;
    }
    this.auth = 'LOGGING_IN';
    this.lastLoginAt = this.now();
    // `what` is all that is ever logged for this message: never the frame itself.
    if (!this.send(buildBitunixLogin(creds, this.now().getTime()), 'login')) return;
    this.loginTimer = setTimeout(() => {
      if (this.auth !== 'LOGGING_IN') return;
      this.lastError = `no login answer within ${this.p.loginTimeoutMs ?? 10_000} ms`;
      this.forceDisconnect(this.lastError); // normal backoff + retry
    }, this.p.loginTimeoutMs ?? 10_000);
  }

  protected override onClosed(): void {
    this.clearLoginTimer();
    if (this.auth !== 'AUTH_FAILED') this.auth = 'DISCONNECTED';
  }

  private failAuth(message: string): void {
    this.clearLoginTimer();
    this.auth = 'AUTH_FAILED';
    this.authError = message.slice(0, 200);
    this.lastError = `login rejected: ${this.authError}`;
    this.log(`ws: ${this.lastError}; stopping (no retry with this key)`);
    this.stop();
    this.auth = 'AUTH_FAILED';
    this.p.onAuthFailed?.(this.authError);
  }

  protected onFrame(msg: Record<string, unknown>, at: Date): void {
    if (typeof msg.op === 'string') {
      const data = (msg.data ?? {}) as Record<string, unknown>;
      switch (msg.op) {
        case 'login': {
          if (this.auth !== 'LOGGING_IN') return;
          if (data.result === true) {
            this.clearLoginTimer();
            this.auth = 'AUTHENTICATED';
            this.authError = null;
            this.readyAt = at;
            this.log('ws: ← login accepted; subscribing balance, order, position (tpsl is pushed automatically)');
            this.send({ op: 'subscribe', args: BITUNIX_PRIVATE_CHANNELS.map((ch) => ({ ch })) }, `subscribe ${BITUNIX_PRIVATE_CHANNELS.join('+')}`);
            this.p.onReady?.(at);
          } else {
            // Only Bitunix's message text: the echoed nonce and anything else stay out of logs.
            this.failAuth(typeof data.msg === 'string' ? data.msg : 'login failed');
          }
          return;
        }
        case 'ping':
          this.notePong(at, null); // the private pong carries seconds only: no clock sample
          return;
        case 'connect':
          this.log('ws: ← connect');
          return;
        case 'subscribe':
          this.acks += 1;
          return;
        default:
          if (msg.code !== undefined || msg.op === 'error') {
            this.lastError = `Bitunix: ${String((data.msg as string) ?? msg.msg ?? msg.code)}`.slice(0, 200);
            this.log(`ws: ← ${this.lastError}`);
          }
          return;
      }
    }
    if (typeof msg.ch !== 'string') return;
    if (this.auth !== 'AUTHENTICATED') return; // never act on account data outside an authenticated session
    let events: BitunixPrivateEvent[];
    try {
      events = parseBitunixPrivateFrame(msg, at, () => ++this.seq);
    } catch (e) {
      this.parseErrors += 1;
      this.log(`ws: ${msg.ch}: ${(e as Error).message}`);
      return;
    }
    for (const e of events) {
      this.counts[e.channel] = (this.counts[e.channel] ?? 0) + 1;
      this.tickers += 1;
      this.p.onEvent(e);
    }
  }
}
