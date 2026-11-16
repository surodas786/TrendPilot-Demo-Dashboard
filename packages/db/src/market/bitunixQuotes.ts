import { eq, sql } from 'drizzle-orm';
import type { Db } from '../client';
import { recordMarketTick } from '../paper/exits';
import { instruments } from '../schema';
import type { ExchangePriceCache } from './priceCache';

/**
 * Stores Bitunix public prices for Bitunix INSTRUMENTS as quotes (`source = 'BITUNIX_PUBLIC'`,
 * channel WS), through the same `recordMarketTick` the MEXC feed uses, so entry sizing, the
 * submission freshness check and the exit rules read them like any quote. A quote is written only
 * when the exchange-keyed cache holds a FRESH joined quote (book + mark, both recent, valid book),
 * at most once per `minIntervalMs` per instrument. Quotes are keyed by instrument, and a Bitunix
 * instrument is a separate row from the MEXC one, so the two exchanges never share a quote.
 */
export class BitunixQuoteWriter {
  private bySymbol = new Map<string, string>();
  private readonly lastAt = new Map<string, number>();
  private readonly busy = new Set<string>();
  written = 0;

  constructor(
    private readonly db: Db,
    private readonly cache: ExchangePriceCache,
    private readonly o: { minIntervalMs?: number; log?: (m: string) => void } = {}
  ) {}

  /** Bitunix instruments to price: published ones and any with an open position. */
  async refresh(): Promise<string[]> {
    const rows = await this.db
      .select({ id: instruments.id, symbol: instruments.exchangeSymbol, status: instruments.status, open: sql<number>`(select count(*) from positions p where p.instrument_id = "instruments"."id" and p.status = 'OPEN')`.mapWith(Number) })
      .from(instruments)
      .where(eq(instruments.exchange, 'BITUNIX'));
    this.bySymbol = new Map(rows.filter((r) => r.symbol && (r.status === 'PUBLISHED' || r.open > 0)).map((r) => [r.symbol, r.id]));
    return this.symbols();
  }

  symbols(): string[] {
    return [...this.bySymbol.keys()].sort();
  }

  /** Called after each book or mark update for `symbol`. */
  async onUpdate(symbol: string, now: Date = new Date()): Promise<'WRITTEN' | 'SKIPPED'> {
    const id = this.bySymbol.get(symbol);
    if (!id || this.busy.has(symbol)) return 'SKIPPED';
    const q = this.cache.quote('BITUNIX', symbol, now);
    if (q.state !== 'FRESH' || !q.asOf) return 'SKIPPED';
    if (now.getTime() - (this.lastAt.get(symbol) ?? 0) < (this.o.minIntervalMs ?? 1_000)) return 'SKIPPED';
    this.busy.add(symbol);
    try {
      await recordMarketTick(this.db, { instrumentId: id, asOf: q.asOf, bid: q.bid!, ask: q.ask!, mark: q.mark!, last: q.last!, source: 'BITUNIX_PUBLIC', channel: 'WS', receivedAt: now });
      this.lastAt.set(symbol, now.getTime());
      this.written += 1;
      return 'WRITTEN';
    } catch (e) {
      this.o.log?.(`bitunix quote ${symbol}: ${(e as Error).message}`);
      return 'SKIPPED';
    } finally {
      this.busy.delete(symbol);
    }
  }
}
