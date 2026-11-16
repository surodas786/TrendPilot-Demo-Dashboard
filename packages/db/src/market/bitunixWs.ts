import { Decimal, isBitunixFuturesSymbol } from '@trendpilot/domain';
import { PublicStreamSocket, type Outgoing, type PublicStreamOptions } from './publicStream';

/**
 * Bitunix Futures PUBLIC WebSocket (https://www.bitunix.com/api-docs/futures/websocket/prepare/WebSocket.html,
 * read 2026-11-16; frames below were also captured from the live server that day).
 *
 *   ← {"op":"connect","ts":…,"data":{"result":true}}                       (on open)
 *   → {"op":"subscribe","args":[{"symbol":"BTCUSDT","ch":"tickers"},{"symbol":"BTCUSDT","ch":"price"}]}
 *     (no acknowledgement is sent for a subscribe; `unsubscribe` answers {"op":"unsubscribe","data":"success"})
 *   ← {"ch":"tickers","ts":…,"data":[{"s":"BTCUSDT","la":last,"bd":best bid,"ak":best ask,…}]}
 *   ← {"ch":"price","symbol":"BTCUSDT","ts":…,"data":{"mp":mark,"ip":index,"fr":funding rate,"ft":…,"nft":…}}
 *   → {"op":"ping","ping":<unix s>}   ← {"op":"ping","ts":<server ms>,"pong":<s>,"ping":<s>}
 *   ← an unknown symbol is not refused: it pushes {"ch":…,"symbol":"NOPEUSDT","data":{}}.
 *
 * Two channels per symbol, handled separately: `tickers` carries the book top and last trade (the
 * single-symbol `ticker` channel has no bid/ask, so it is not used); `price` carries the mark and
 * index price. A quote needs both; the market-data cache joins them per exchange and symbol.
 * Server limits: at most 5 messages per second per connection (subscriptions are batched into one
 * message on open) and 300 channel subscriptions per connection (150 symbols × 2 channels).
 */

export const BITUNIX_WS_PUBLIC_URL = 'wss://fapi.bitunix.com/public/';
/** Channel subscriptions Bitunix allows per connection. */
export const BITUNIX_WS_MAX_CHANNELS = 300;
const CHANNELS = ['tickers', 'price'] as const;

/** Book top and last trade from the `tickers` channel. */
export interface BitunixBookTicker {
  exchangeSymbol: string;
  bid: string;
  ask: string;
  last: string;
  /** Exchange timestamp of the push (ms). */
  exchangeTimeMs: number;
  receivedAt: Date;
}

/** Mark and index price from the `price` channel. */
export interface BitunixMarkPrice {
  exchangeSymbol: string;
  mark: string;
  index: string | null;
  fundingRate: string | null;
  nextFundingTime: string | null;
  exchangeTimeMs: number;
  receivedAt: Date;
}

export class BitunixWsParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BitunixWsParseError';
  }
}

const positive = (v: unknown, field: string, sym: string): string => {
  if (typeof v !== 'string' && typeof v !== 'number') throw new BitunixWsParseError(`${sym}: ${field} is missing`);
  let d: Decimal;
  try {
    d = new Decimal(v);
  } catch {
    throw new BitunixWsParseError(`${sym}: ${field} is not a number`);
  }
  if (!d.isFinite() || d.lte(0)) throw new BitunixWsParseError(`${sym}: ${field} must be positive`);
  return d.toFixed();
};
const tsOf = (msg: Record<string, unknown>): number => {
  const ts = msg.ts;
  if (typeof ts !== 'number' || !Number.isFinite(ts) || ts < 1e12) throw new BitunixWsParseError(`${String(msg.ch)}: no millisecond timestamp`);
  return ts;
};

/** True when Bitunix pushed an empty payload: how it answers a subscription to an unknown symbol. */
export const isEmptyPush = (msg: Record<string, unknown>) => {
  const d = msg.data;
  return d === null || d === undefined || (Array.isArray(d) ? d.length === 0 : typeof d === 'object' && Object.keys(d as object).length === 0);
};

/** A `tickers` frame → one book ticker per symbol it carries. Rows that fail to parse are skipped and reported. */
export function parseBitunixTickers(msg: Record<string, unknown>, receivedAt: Date): { tickers: BitunixBookTicker[]; errors: string[] } {
  const ts = tsOf(msg);
  const rows = Array.isArray(msg.data) ? msg.data : msg.data && typeof msg.data === 'object' ? [msg.data] : [];
  const tickers: BitunixBookTicker[] = [];
  const errors: string[] = [];
  for (const r of rows as Record<string, unknown>[]) {
    try {
      const sym = typeof r?.s === 'string' ? r.s : typeof msg.symbol === 'string' ? msg.symbol : '';
      if (!isBitunixFuturesSymbol(sym)) throw new BitunixWsParseError(`tickers: bad symbol ${JSON.stringify(sym)}`);
      const t = { exchangeSymbol: sym, bid: positive(r.bd, 'bd (best bid)', sym), ask: positive(r.ak, 'ak (best ask)', sym), last: positive(r.la, 'la (last price)', sym), exchangeTimeMs: ts, receivedAt };
      if (new Decimal(t.ask).lt(t.bid)) throw new BitunixWsParseError(`${sym}: crossed book (ask below bid)`);
      tickers.push(t);
    } catch (e) {
      errors.push((e as Error).message);
    }
  }
  return { tickers, errors };
}

/** A `price` frame → mark price. Throws BitunixWsParseError on anything malformed. */
export function parseBitunixPrice(msg: Record<string, unknown>, receivedAt: Date): BitunixMarkPrice {
  const sym = typeof msg.symbol === 'string' ? msg.symbol : '';
  if (!isBitunixFuturesSymbol(sym)) throw new BitunixWsParseError(`price: bad symbol ${JSON.stringify(sym)}`);
  const ts = tsOf(msg);
  const d = msg.data as Record<string, unknown> | undefined;
  if (!d || typeof d !== 'object' || Array.isArray(d)) throw new BitunixWsParseError(`price ${sym}: expected an object`);
  let fundingRate: string | null = null;
  try {
    fundingRate = d.fr === undefined || d.fr === null || d.fr === '' ? null : new Decimal(d.fr as Decimal.Value).toFixed();
  } catch {
    fundingRate = null;
  }
  return {
    exchangeSymbol: sym,
    mark: positive(d.mp, 'mp (mark price)', sym),
    index: d.ip === undefined || d.ip === null || d.ip === '' ? null : positive(d.ip, 'ip (index price)', sym),
    fundingRate,
    nextFundingTime: typeof d.nft === 'string' ? d.nft : null,
    exchangeTimeMs: ts,
    receivedAt
  };
}

export interface BitunixPriceStreamStatus extends ReturnType<PublicStreamSocket['status']> {
  /** Symbols with a `tickers` / `price` push on the current socket. */
  tickerConfirmed: string[];
  priceConfirmed: string[];
  /** Symbols Bitunix answered with an empty payload (unknown / unsupported). */
  unsupported: string[];
  pricesReceived: number;
}

export interface BitunixPriceStreamOptions extends Partial<Omit<PublicStreamOptions, 'url'>> {
  url?: string;
  onTicker: (t: BitunixBookTicker) => void;
  onPrice: (p: BitunixMarkPrice) => void;
  /** Bitunix pushed an empty payload for a wanted symbol: it does not know it. */
  onUnsupported?: (exchangeSymbol: string) => void;
  logTicks?: boolean;
}

export class BitunixPriceStream extends PublicStreamSocket {
  private readonly tickerSeen = new Set<string>();
  private readonly priceSeen = new Set<string>();
  private readonly unsupported = new Set<string>();
  private prices = 0;

  constructor(private readonly b: BitunixPriceStreamOptions) {
    super({ ...b, url: b.url ?? BITUNIX_WS_PUBLIC_URL });
  }

  override setSymbols(symbols: Iterable<string>): void {
    const list = [...symbols].filter(isBitunixFuturesSymbol);
    const max = BITUNIX_WS_MAX_CHANNELS / CHANNELS.length;
    if (list.length > max) this.log(`ws: ${list.length} symbols exceed Bitunix's ${BITUNIX_WS_MAX_CHANNELS} channels per connection; only the first ${max} are subscribed`);
    super.setSymbols(list.slice(0, max));
    for (const s of [...this.unsupported]) if (!this.wanted.has(s)) this.unsupported.delete(s);
  }

  override status(): BitunixPriceStreamStatus {
    return { ...super.status(), tickerConfirmed: [...this.tickerSeen].sort(), priceConfirmed: [...this.priceSeen].sort(), unsupported: [...this.unsupported].sort(), pricesReceived: this.prices };
  }

  protected isSymbol(s: string): boolean {
    return isBitunixFuturesSymbol(s);
  }

  protected subscribeMessages(symbols: string[]): Outgoing[] {
    // A fresh socket starts unconfirmed; one batched message keeps under 5 messages per second.
    for (const s of symbols) {
      this.tickerSeen.delete(s);
      this.priceSeen.delete(s);
    }
    return [{ msg: { op: 'subscribe', args: symbols.flatMap((symbol) => CHANNELS.map((ch) => ({ symbol, ch }))) }, what: `subscribe ${CHANNELS.join('+')} ${symbols.join(',')}`, symbols }];
  }

  protected unsubscribeMessages(symbols: string[]): Outgoing[] {
    for (const s of symbols) {
      this.tickerSeen.delete(s);
      this.priceSeen.delete(s);
    }
    return [{ msg: { op: 'unsubscribe', args: symbols.flatMap((symbol) => CHANNELS.map((ch) => ({ symbol, ch }))) }, what: `unsubscribe ${symbols.join(',')}` }];
  }

  protected pingMessage(nowMs: number): object {
    return { op: 'ping', ping: Math.floor(nowMs / 1000) };
  }

  private seen(set: Set<string>, sym: string, line: string): void {
    if (!set.has(sym)) {
      set.add(sym);
      this.log(`ws: ← first ${line}`);
    } else if (this.b.logTicks) this.log(`ws: ← ${line}`);
    // A symbol is confirmed (fresh on this socket) once both of its channels have pushed.
    if (this.tickerSeen.has(sym) && this.priceSeen.has(sym)) this.confirm(sym);
  }

  protected onFrame(msg: Record<string, unknown>, at: Date): void {
    if (typeof msg.op === 'string') {
      if (msg.op === 'ping') this.notePong(at, msg.ts);
      else if (msg.op === 'connect' || msg.op === 'subscribe' || msg.op === 'unsubscribe') {
        if (msg.op !== 'connect') this.acks += 1;
        this.log(`ws: ← ${msg.op} ${JSON.stringify(msg.data ?? null)}`);
      } else if (msg.op === 'error' || msg.code !== undefined) {
        this.lastError = `Bitunix: ${JSON.stringify(msg).slice(0, 200)}`;
        this.log(`ws: ← ${this.lastError}`);
      }
      return;
    }
    const ch = msg.ch;
    if (ch !== 'tickers' && ch !== 'price') return;
    if (isEmptyPush(msg)) {
      const sym = typeof msg.symbol === 'string' ? msg.symbol : null;
      if (sym && this.wanted.has(sym) && !this.unsupported.has(sym)) {
        this.unsupported.add(sym);
        this.lastError = `Bitunix sent no ${ch} data for ${sym} (unknown or unsupported symbol)`;
        this.log(`ws: ${this.lastError}`);
        this.b.onUnsupported?.(sym);
      }
      return;
    }
    if (ch === 'tickers') {
      let parsed;
      try {
        parsed = parseBitunixTickers(msg, at);
      } catch (e) {
        this.log(`ws: ${(e as Error).message}`);
        return;
      }
      for (const err of parsed.errors) this.log(`ws: ${err}`);
      for (const t of parsed.tickers) {
        if (!this.wanted.has(t.exchangeSymbol)) continue; // late push after an unsubscribe
        this.unsupported.delete(t.exchangeSymbol);
        this.tickers += 1;
        this.seen(this.tickerSeen, t.exchangeSymbol, `tickers ${t.exchangeSymbol} bid=${t.bid} ask=${t.ask} last=${t.last} ts=${new Date(t.exchangeTimeMs).toISOString()}`);
        this.b.onTicker(t);
      }
      return;
    }
    let p: BitunixMarkPrice;
    try {
      p = parseBitunixPrice(msg, at);
    } catch (e) {
      this.log(`ws: ${(e as Error).message}`);
      return;
    }
    if (!this.wanted.has(p.exchangeSymbol)) return;
    this.unsupported.delete(p.exchangeSymbol);
    this.prices += 1;
    this.seen(this.priceSeen, p.exchangeSymbol, `price ${p.exchangeSymbol} mark=${p.mark} index=${p.index ?? '-'} ts=${new Date(p.exchangeTimeMs).toISOString()}`);
    this.b.onPrice(p);
  }
}
