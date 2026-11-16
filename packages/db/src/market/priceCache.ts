import { FEED_POLICY, marketKey, quoteProblem, type ExchangeId } from '@trendpilot/domain';

/**
 * In-memory market-data cache, keyed by EXCHANGE and exchange symbol (`BITUNIX:BTCUSDT`,
 * `MEXC:BTC_USDT`), so two exchanges quoting the same contract can never overwrite each other.
 *
 * The book side (bid / ask / last) and the mark side (mark / index) are stored separately because
 * Bitunix delivers them on different WebSocket channels at different rates. A quote is usable only
 * when both sides are present, both are fresh (received within FEED_POLICY.maxQuoteAgeMs, the same
 * limit entries use), and the book is valid. An older exchange timestamp never replaces a newer one.
 */

export interface BookPart {
  bid: string;
  ask: string;
  last: string;
  exchangeTimeMs: number;
  receivedAt: Date;
}
export interface MarkPart {
  mark: string;
  index: string | null;
  exchangeTimeMs: number;
  receivedAt: Date;
}

export type CachedQuoteState = 'FRESH' | 'STALE' | 'INCOMPLETE' | 'INVALID' | 'MISSING';

export interface CachedQuote {
  exchange: ExchangeId;
  exchangeSymbol: string;
  state: CachedQuoteState;
  /** Why the quote is not FRESH (null when it is). */
  problem: string | null;
  bid: string | null;
  ask: string | null;
  last: string | null;
  mark: string | null;
  index: string | null;
  bookAgeMs: number | null;
  markAgeMs: number | null;
  /** Older of the two receipt times: the quote is only as fresh as its stalest part. */
  asOf: Date | null;
}

interface Entry {
  book?: BookPart;
  mark?: MarkPart;
}

export class ExchangePriceCache {
  private readonly entries = new Map<string, Entry>();

  constructor(private readonly maxAgeMs: number = FEED_POLICY.maxQuoteAgeMs) {}

  private entry(exchange: ExchangeId, sym: string): Entry {
    const k = marketKey(exchange, sym);
    let e = this.entries.get(k);
    if (!e) this.entries.set(k, (e = {}));
    return e;
  }

  /** Stores the book side. Returns false when it is older than what is cached. */
  putBook(exchange: ExchangeId, exchangeSymbol: string, b: BookPart): boolean {
    const e = this.entry(exchange, exchangeSymbol);
    if (e.book && e.book.exchangeTimeMs > b.exchangeTimeMs) return false;
    e.book = { ...b };
    return true;
  }

  /** Stores the mark side. Returns false when it is older than what is cached. */
  putMark(exchange: ExchangeId, exchangeSymbol: string, m: MarkPart): boolean {
    const e = this.entry(exchange, exchangeSymbol);
    if (e.mark && e.mark.exchangeTimeMs > m.exchangeTimeMs) return false;
    e.mark = { ...m };
    return true;
  }

  /** Drops a symbol (unsubscribed, or the exchange does not know it). */
  forget(exchange: ExchangeId, exchangeSymbol: string): void {
    this.entries.delete(marketKey(exchange, exchangeSymbol));
  }

  keys(): string[] {
    return [...this.entries.keys()].sort();
  }

  quote(exchange: ExchangeId, exchangeSymbol: string, now: Date): CachedQuote {
    const e = this.entries.get(marketKey(exchange, exchangeSymbol));
    const base = { exchange, exchangeSymbol };
    if (!e || (!e.book && !e.mark)) return { ...base, state: 'MISSING', problem: 'no price received', bid: null, ask: null, last: null, mark: null, index: null, bookAgeMs: null, markAgeMs: null, asOf: null };
    const bookAgeMs = e.book ? now.getTime() - e.book.receivedAt.getTime() : null;
    const markAgeMs = e.mark ? now.getTime() - e.mark.receivedAt.getTime() : null;
    const parts = { bid: e.book?.bid ?? null, ask: e.book?.ask ?? null, last: e.book?.last ?? null, mark: e.mark?.mark ?? null, index: e.mark?.index ?? null, bookAgeMs, markAgeMs };
    const asOf = e.book && e.mark ? new Date(Math.min(e.book.receivedAt.getTime(), e.mark.receivedAt.getTime())) : null;
    if (!e.book || !e.mark) return { ...base, ...parts, asOf, state: 'INCOMPLETE', problem: e.book ? 'no mark price yet' : 'no bid/ask yet' };
    const stale = [bookAgeMs! > this.maxAgeMs ? `bid/ask ${Math.round(bookAgeMs! / 1000)} s old` : null, markAgeMs! > this.maxAgeMs ? `mark ${Math.round(markAgeMs! / 1000)} s old` : null].filter(Boolean);
    if (stale.length) return { ...base, ...parts, asOf, state: 'STALE', problem: stale.join('; ') };
    const bad = quoteProblem({ bid: e.book.bid, ask: e.book.ask, mark: e.mark.mark, last: e.book.last });
    if (bad) return { ...base, ...parts, asOf, state: 'INVALID', problem: bad };
    return { ...base, ...parts, asOf, state: 'FRESH', problem: null };
  }
}
