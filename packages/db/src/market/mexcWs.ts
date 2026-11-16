import { isMexcFuturesSymbol, MexcPublicError, tickerFromData, type MexcTicker } from './mexcPublic';
import { PublicStreamSocket, type Outgoing, type WsFactory } from './publicStream';

// Socket types and helpers moved to the exchange-neutral base; re-exported for existing imports.
export { frameText, type StreamState, type TickerStreamStatus, type TickerStreamView, type WsFactory, type WsLike } from './publicStream';

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

export interface StreamTicker extends MexcTicker {
  /** Local time the push was received by this process. */
  receivedAt: Date;
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

/** The MEXC wire protocol on the shared public-socket lifecycle (heartbeat, reconnect, resubscribe). */
export class MexcTickerStream extends PublicStreamSocket {
  constructor(private readonly m: MexcTickerStreamOptions) {
    super({ ...m, url: m.url ?? MEXC_WS_DEFAULT_URL });
  }

  protected isSymbol(s: string): boolean {
    return isMexcFuturesSymbol(s);
  }

  protected subscribeMessages(symbols: string[]): Outgoing[] {
    return symbols.map((s) => ({ msg: { method: 'sub.ticker', param: { symbol: s } }, what: `sub.ticker ${s}`, symbols: [s] }));
  }

  protected unsubscribeMessages(symbols: string[]): Outgoing[] {
    return symbols.map((s) => ({ msg: { method: 'unsub.ticker', param: { symbol: s } }, what: `unsub.ticker ${s}` }));
  }

  protected pingMessage(): object {
    return { method: 'ping' };
  }

  protected onFrame(raw: Record<string, unknown>, at: Date): void {
    const msg = raw as WsMessage;
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
        if (this.confirm(t.exchangeSymbol)) {
          this.log(`ws: ← first push.ticker ${t.exchangeSymbol} bid=${t.bid} ask=${t.ask} mark=${t.mark} ts=${new Date(t.exchangeTimeMs).toISOString()}`);
        } else if (this.m.logTicks) {
          this.log(`ws: ← push.ticker ${t.exchangeSymbol} bid=${t.bid} ask=${t.ask} mark=${t.mark} ts=${new Date(t.exchangeTimeMs).toISOString()}`);
        }
        this.m.onTicker(t);
        return;
      }
      case 'pong':
        this.notePong(at, msg.data);
        return;
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
