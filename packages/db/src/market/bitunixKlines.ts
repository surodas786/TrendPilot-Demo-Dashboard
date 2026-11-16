import { INTERVAL_MS, type CandleInterval } from '@trendpilot/domain';
import { BITUNIX_PUBLIC_DEFAULT_BASE_URL, BitunixPublicError } from './bitunixPublic';
import { decimalString, type MexcContractDetail, type MexcKline, type MexcTicker, type PublicMarketSource } from './mexcPublic';

/**
 * Bitunix Futures closed candles for EMA 200 (Step 4), as a `PublicMarketSource` so the existing
 * candle sync (backfill, gap detection, late revisions) runs unchanged on Bitunix instruments.
 *
 * Documented (market/get_kline, read 2026-11-16) and confirmed on the live API the same day:
 *   GET /api/v1/futures/market/kline?symbol=BTCUSDT&interval=5m|15m&endTime=<ms>&limit=<≤200>
 *   - `time` is the candle OPEN time in Unix ms (sent as a STRING on the live API);
 *   - `endTime` is EXCLUSIVE and the query counts `limit` candles BACKWARD from it;
 *   - only closed candles are returned (the forming candle is never included);
 *   - the live API returns them NEWEST FIRST (the docs do not state an order): sorted here;
 *   - `type` defaults to LAST_PRICE (last-trade candles, as on MEXC).
 * Public endpoint, no credentials; 10 requests / second / IP.
 */

export const BITUNIX_KLINE_PATH = '/api/v1/futures/market/kline';
export const BITUNIX_KLINE_MAX_LIMIT = 200;
const INTERVAL_PARAM: Record<CandleInterval, string> = { '5': '5m', '15': '15m' };

export function parseBitunixKlines(body: unknown, symbol: string, interval: CandleInterval): MexcKline[] {
  const e = body as { code?: unknown; msg?: unknown; data?: unknown };
  if (!e || typeof e !== 'object' || typeof e.code !== 'number') throw new BitunixPublicError(`kline ${symbol}: unexpected response`, 'PARSE');
  if (e.code !== 0) throw new BitunixPublicError(`kline ${symbol}: ${typeof e.msg === 'string' ? e.msg : 'request failed'} (code ${e.code})`, 'API', e.code);
  if (!Array.isArray(e.data)) throw new BitunixPublicError(`kline ${symbol}: data is not a list`, 'PARSE');
  const ms = INTERVAL_MS[interval];
  const rows = (e.data as Record<string, unknown>[]).map((k, i) => {
    const t = typeof k.time === 'string' ? Number(k.time) : k.time;
    if (typeof t !== 'number' || !Number.isSafeInteger(t) || t < 1e12) throw new BitunixPublicError(`kline ${symbol}: bad time at ${i}`, 'PARSE');
    if (t % ms !== 0) throw new BitunixPublicError(`kline ${symbol}: time ${t} is not a ${interval}m open time`, 'PARSE');
    return { openTime: new Date(t), open: decimalString(k.open, 'open'), high: decimalString(k.high, 'high'), low: decimalString(k.low, 'low'), close: decimalString(k.close, 'close') };
  });
  return rows.sort((a, b) => a.openTime.getTime() - b.openTime.getTime());
}

/** Candle-only public source for the shared MarketFeed (quotes come from the Bitunix WebSocket). */
export class BitunixKlineSource implements PublicMarketSource {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  readonly requestCounts: Record<string, number> = {};

  constructor(o: { baseUrl?: string; fetch?: typeof fetch; timeoutMs?: number; now?: () => number } = {}) {
    this.baseUrl = (o.baseUrl ?? BITUNIX_PUBLIC_DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.fetchImpl = o.fetch ?? fetch;
    this.timeoutMs = o.timeoutMs ?? 8_000;
    this.nowMs = o.now ?? Date.now;
  }
  private readonly timeoutMs: number;
  private readonly nowMs: () => number;

  /** Bitunix has no public server-time endpoint: the local clock (offset 0) frames closed bars. */
  async serverTimeMs(): Promise<number> {
    return this.nowMs();
  }

  async ticker(): Promise<MexcTicker> {
    throw new BitunixPublicError('Bitunix quotes come from the public WebSocket, not REST polling', 'NOT_PUBLIC');
  }

  async contractDetail(): Promise<MexcContractDetail> {
    throw new BitunixPublicError('Bitunix contract rules come from trading_pairs (instrument refresh)', 'NOT_PUBLIC');
  }

  private async page(symbol: string, interval: CandleInterval, endTimeMs: number, limit: number): Promise<MexcKline[]> {
    this.requestCounts.kline = (this.requestCounts.kline ?? 0) + 1;
    const url = new URL(this.baseUrl + BITUNIX_KLINE_PATH);
    url.searchParams.set('symbol', symbol);
    url.searchParams.set('interval', INTERVAL_PARAM[interval]);
    url.searchParams.set('endTime', String(endTimeMs));
    url.searchParams.set('limit', String(limit));
    let res: Response;
    try {
      res = await this.fetchImpl(url, { method: 'GET', headers: { accept: 'application/json' }, signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (e) {
      throw new BitunixPublicError(`GET ${BITUNIX_KLINE_PATH}: ${(e as Error).message}`, 'NETWORK');
    }
    if (!res.ok) throw new BitunixPublicError(`GET ${BITUNIX_KLINE_PATH}: HTTP ${res.status}`, 'HTTP', res.status);
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      throw new BitunixPublicError(`GET ${BITUNIX_KLINE_PATH}: invalid JSON`, 'PARSE');
    }
    return parseBitunixKlines(body, symbol, interval);
  }

  /** Closed bars with open time in [fromOpen, toOpen], oldest first, paging backward 200 at a time. */
  async klines(symbol: string, interval: CandleInterval, fromOpen: Date, toOpen: Date): Promise<MexcKline[]> {
    const ms = INTERVAL_MS[interval];
    const out = new Map<number, MexcKline>();
    let end = toOpen.getTime() + ms; // exclusive: includes the bar that opens at toOpen
    while (end > fromOpen.getTime()) {
      const want = Math.min(BITUNIX_KLINE_MAX_LIMIT, Math.ceil((end - fromOpen.getTime()) / ms));
      const rows = await this.page(symbol, interval, end, want);
      if (!rows.length) break;
      for (const r of rows) if (r.openTime >= fromOpen && r.openTime <= toOpen) out.set(r.openTime.getTime(), r);
      const oldest = rows[0]!.openTime.getTime();
      if (oldest >= end) break; // defensive: never loop on a non-advancing page
      end = oldest;
      if (rows.length < want) break;
    }
    return [...out.values()].sort((a, b) => a.openTime.getTime() - b.openTime.getTime());
  }
}
