import { LIGHTER_MAINNET } from './lighterPublic';
import { PublicStreamSocket, type Outgoing, type PublicStreamOptions } from './publicStream';

/**
 * Lighter PUBLIC market-data WebSocket (Lighter plan, Step 2), on the shared socket lifecycle
 * (connect timeout, keepalive, silence detection, jittered reconnect, resubscription). Public
 * channels only: no auth token is ever sent. Markets are addressed by catalog market ID.
 *
 * Documented (https://docs.lighter.xyz/api/websocket.md, read 2026-11-17) and observed live the same day:
 *  - URL (Ethereum mainnet): wss://mainnet.zklighter.elliot.ai/stream; keepalive: any frame within
 *    2 minutes; `{"type":"ping"}` → `{"type":"pong"}` (no server time, so no clock sample);
 *  - `ticker/{market}`: best bid/ask (`ticker.b.price` / `ticker.a.price`), `last_updated_at` in
 *    MICROseconds (sequencer time of the processed book batch), envelope `timestamp` in ms;
 *  - `market_stats/{market}`: `mark_price`, `index_price`, `last_trade_price` (and others), envelope
 *    `timestamp` in ms;
 *  - every subscription answers `subscribed/<channel>` with a full snapshot, then `update/<channel>`;
 *    response channels use colons (`ticker:92`);
 *  - an invalid market is answered `{"error":{"code":30005,"message":"Invalid Channel: ..."}}`
 *    WITHOUT naming the channel (observed), so it is logged, not attributed.
 * Bid / ask (ticker) and mark / index / last (market_stats) are delivered separately and kept
 * apart; nothing is derived (no mid, no mark from the book). A frame missing a field is skipped.
 */

export const LIGHTER_WS_MAINNET_URL = 'wss://mainnet.zklighter.elliot.ai/stream';

/** Cache / quote key of a Lighter market: environment and market ID (exchange is the cache's first key part). */
export const lighterMarketKey = (marketId: number | string, environment: string = LIGHTER_MAINNET.environment) => `${environment}/${marketId}`;

export interface LighterTicker {
  marketId: string;
  bid: string;
  ask: string;
  /** Sequencer time of the book batch, ms (from µs `last_updated_at`); falls back to the envelope time. */
  exchangeTimeMs: number;
  nonce: number | null;
  receivedAt: Date;
  snapshot: boolean;
}

export interface LighterStats {
  marketId: string;
  mark: string;
  index: string | null;
  last: string | null;
  /** Envelope frame time, ms (the only time market_stats carries). */
  exchangeTimeMs: number;
  receivedAt: Date;
  snapshot: boolean;
}

export interface LighterStreamOptions extends PublicStreamOptions {
  onTicker: (t: LighterTicker) => void;
  onStats: (s: LighterStats) => void;
  logTicks?: boolean;
}

const POSITIVE = /^\d+(\.\d+)?$/;
const price = (v: unknown): string | null => (typeof v === 'string' && POSITIVE.test(v) && Number(v) > 0 ? v : null);

export class LighterPriceStream extends PublicStreamSocket {
  private readonly onTicker: (t: LighterTicker) => void;
  private readonly onStats: (s: LighterStats) => void;
  private readonly logTicks: boolean;
  private readonly lastNonce = new Map<string, number>();
  errorsReceived = 0;
  skippedFrames = 0;

  constructor(o: LighterStreamOptions) {
    super(o);
    this.onTicker = o.onTicker;
    this.onStats = o.onStats;
    this.logTicks = o.logTicks ?? false;
  }

  protected isSymbol(s: string): boolean {
    return /^\d+$/.test(s);
  }

  protected subscribeMessages(markets: string[]): Outgoing[] {
    // One subscribe per channel (documented single-market channels); a market produces two messages.
    return markets.flatMap((m) => [
      { msg: { type: 'subscribe', channel: `ticker/${m}` }, what: `subscribe ticker/${m}`, symbols: [m] },
      { msg: { type: 'subscribe', channel: `market_stats/${m}` }, what: `subscribe market_stats/${m}` }
    ]);
  }

  protected unsubscribeMessages(markets: string[]): Outgoing[] {
    for (const m of markets) this.lastNonce.delete(m);
    return markets.flatMap((m) => [
      { msg: { type: 'unsubscribe', channel: `ticker/${m}` }, what: `unsubscribe ticker/${m}` },
      { msg: { type: 'unsubscribe', channel: `market_stats/${m}` }, what: `unsubscribe market_stats/${m}` }
    ]);
  }

  protected pingMessage(): object {
    return { type: 'ping' };
  }

  /** A new socket starts a new nonce sequence (the API server may differ). */
  protected onClosed(): void {
    this.lastNonce.clear();
  }

  protected onFrame(msg: Record<string, unknown>, at: Date): void {
    if (msg.error && typeof msg.error === 'object') {
      this.errorsReceived += 1;
      const e = msg.error as { code?: unknown; message?: unknown };
      this.lastError = `lighter error ${String(e.code)}: ${String(e.message).slice(0, 120)}`;
      this.log(`ws: ← ${this.lastError}`);
      return;
    }
    const type = typeof msg.type === 'string' ? msg.type : '';
    if (type === 'connected') return;
    if (type === 'pong') return this.notePong(at, undefined);
    const channel = typeof msg.channel === 'string' ? msg.channel : '';
    const [kind, market] = channel.split(':');
    if (!market || !this.wanted.has(market)) return;
    const snapshot = type.startsWith('subscribed/');
    if (!snapshot && !type.startsWith('update/')) return;
    const envelopeMs = typeof msg.timestamp === 'number' && Number.isFinite(msg.timestamp) ? msg.timestamp : null;
    if (kind === 'ticker') {
      if (snapshot) this.acks += 1;
      const t = msg.ticker as { a?: { price?: unknown }; b?: { price?: unknown }; last_updated_at?: unknown } | undefined;
      const bid = price(t?.b?.price);
      const ask = price(t?.a?.price);
      const luUs = typeof t?.last_updated_at === 'number' ? t.last_updated_at : typeof msg.last_updated_at === 'number' ? msg.last_updated_at : null;
      const exchangeTimeMs = luUs !== null && luUs > 0 ? Math.floor(luUs / 1000) : envelopeMs;
      if (!bid || !ask || exchangeTimeMs === null) {
        this.skippedFrames += 1;
        return;
      }
      const nonce = typeof msg.nonce === 'number' && Number.isFinite(msg.nonce) ? msg.nonce : null;
      // On one socket the nonce only increases; an older one is a late frame and is ignored.
      const prev = this.lastNonce.get(market);
      if (nonce !== null && prev !== undefined && nonce < prev && !snapshot) {
        this.skippedFrames += 1;
        return;
      }
      if (nonce !== null) this.lastNonce.set(market, nonce);
      this.tickers += 1;
      if (this.confirm(market)) this.log(`ws: ← first ticker ${market} bid=${bid} ask=${ask} at=${new Date(exchangeTimeMs).toISOString()}`);
      else if (this.logTicks) this.log(`ws: ← ticker ${market} bid=${bid} ask=${ask}`);
      this.onTicker({ marketId: market, bid, ask, exchangeTimeMs, nonce, receivedAt: at, snapshot });
      return;
    }
    if (kind === 'market_stats') {
      const s = msg.market_stats as { market_id?: unknown; mark_price?: unknown; index_price?: unknown; last_trade_price?: unknown } | undefined;
      const mark = price(s?.mark_price);
      if (!s || String(s.market_id) !== market || !mark || envelopeMs === null) {
        this.skippedFrames += 1;
        return;
      }
      this.onStats({ marketId: market, mark, index: price(s.index_price), last: price(s.last_trade_price), exchangeTimeMs: envelopeMs, receivedAt: at, snapshot });
    }
  }
}
