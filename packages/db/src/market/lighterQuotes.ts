import { eq, sql } from 'drizzle-orm';
import type { Db } from '../client';
import { recordMarketTick } from '../paper/exits';
import { instruments } from '../schema';
import { LIGHTER_MAINNET } from './lighterPublic';
import { lighterMarketKey, type LighterStats, type LighterTicker } from './lighterWs';
import type { CachedQuote, ExchangePriceCache } from './priceCache';

/**
 * Lighter public prices → the exchange-keyed cache → stored quotes for Lighter INSTRUMENTS
 * (`source = 'LIGHTER_PUBLIC'`, channel WS), through the same `recordMarketTick` the MEXC and
 * Bitunix feeds use: the commit NOTIFYs the web app's live quote stream (no browser refresh).
 *
 * Cache key: exchange LIGHTER + `<environment>/<market ID>` (e.g. `LIGHTER:MAINNET/92`). The book
 * side holds the ticker's bid / ask at the ticker's sequencer time; the mark side holds
 * market_stats' mark / index at its frame time. `last` is market_stats' `last_trade_price`: it is
 * attached to the book only once a market_stats frame supplied it (never derived from bid/ask).
 * A quote is written only when the cache judges the joined quote FRESH (both parts within
 * FEED_POLICY.maxQuoteAgeMs, valid uncrossed book) and at most once per `minIntervalMs` per market.
 * A Lighter quote is stored only on a Lighter instrument, so no other exchange's price is ever
 * displayed or used for it, and a Lighter price never reaches a MEXC or Bitunix instrument.
 */
export class LighterQuoteWriter {
  /** market ID → instrument ID (published Lighter instruments and any with an open position). */
  private byMarket = new Map<string, string>();
  private readonly lastTrade = new Map<string, string>();
  private readonly lastAt = new Map<string, number>();
  private readonly busy = new Set<string>();
  written = 0;

  constructor(
    private readonly db: Db,
    private readonly cache: ExchangePriceCache,
    private readonly o: { minIntervalMs?: number; log?: (m: string) => void; environment?: string } = {}
  ) {}

  private key(marketId: string): string {
    return lighterMarketKey(marketId, this.o.environment ?? LIGHTER_MAINNET.environment);
  }

  /** Lighter market IDs to subscribe: published instruments plus any with an open position. */
  async refresh(): Promise<string[]> {
    const rows = await this.db
      .select({ id: instruments.id, marketId: instruments.exchangeMarketId, status: instruments.status, open: sql<number>`(select count(*) from positions p where p.instrument_id = "instruments"."id" and p.status = 'OPEN')`.mapWith(Number) })
      .from(instruments)
      .where(eq(instruments.exchange, 'LIGHTER'));
    this.byMarket = new Map(rows.filter((r) => r.marketId !== null && (r.status === 'PUBLISHED' || r.open > 0)).map((r) => [String(r.marketId), r.id]));
    return this.markets();
  }

  markets(): string[] {
    return [...this.byMarket.keys()].sort((a, b) => Number(a) - Number(b));
  }

  /** The joined cached quote for a market (what the heartbeat and diagnostics report). */
  quote(marketId: string, now: Date = new Date()): CachedQuote {
    return this.cache.quote('LIGHTER', this.key(marketId), now);
  }

  onTicker(t: LighterTicker): boolean {
    const last = this.lastTrade.get(t.marketId);
    // Without a last trade price from market_stats the book part is held back (not synthesized).
    if (!last) return false;
    return this.cache.putBook('LIGHTER', this.key(t.marketId), { bid: t.bid, ask: t.ask, last, exchangeTimeMs: t.exchangeTimeMs, receivedAt: t.receivedAt });
  }

  onStats(s: LighterStats): boolean {
    if (s.last) this.lastTrade.set(s.marketId, s.last);
    return this.cache.putMark('LIGHTER', this.key(s.marketId), { mark: s.mark, index: s.index, exchangeTimeMs: s.exchangeTimeMs, receivedAt: s.receivedAt });
  }

  /** Called after each update for a market: stores a FRESH joined quote (rate-limited). */
  async onUpdate(marketId: string, now: Date = new Date()): Promise<'WRITTEN' | 'SKIPPED'> {
    const id = this.byMarket.get(marketId);
    if (!id || this.busy.has(marketId)) return 'SKIPPED';
    const q = this.quote(marketId, now);
    if (q.state !== 'FRESH' || !q.asOf) return 'SKIPPED';
    if (now.getTime() - (this.lastAt.get(marketId) ?? 0) < (this.o.minIntervalMs ?? 1_000)) return 'SKIPPED';
    this.busy.add(marketId);
    try {
      await recordMarketTick(this.db, { instrumentId: id, asOf: q.asOf, bid: q.bid!, ask: q.ask!, mark: q.mark!, last: q.last!, source: 'LIGHTER_PUBLIC', channel: 'WS', receivedAt: now });
      this.lastAt.set(marketId, now.getTime());
      this.written += 1;
      return 'WRITTEN';
    } catch (e) {
      this.o.log?.(`lighter quote market ${marketId}: ${(e as Error).message}`);
      return 'SKIPPED';
    } finally {
      this.busy.delete(marketId);
    }
  }

  /** Forgets cached values for markets no longer covered. */
  forget(marketId: string): void {
    this.cache.forget('LIGHTER', this.key(marketId));
    this.lastTrade.delete(marketId);
  }
}
