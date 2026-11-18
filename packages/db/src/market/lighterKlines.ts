import { INTERVAL_MS, type CandleInterval } from '@trendpilot/domain';
import { assertLighterMainnet, LIGHTER_MAINNET, LIGHTER_MAINNET_BASE_URL, LighterPublicError, type LighterEnvironmentIdentity } from './lighterPublic';
import { decimalString, type MexcContractDetail, type MexcKline, type MexcTicker, type PublicMarketSource } from './mexcPublic';

/**
 * Lighter closed 5m / 15m candles as a `PublicMarketSource`, so the shared candle sync (backfill,
 * gap detection, late revisions) runs unchanged on Lighter instruments (Lighter plan, Step 2).
 *
 * Documented (https://docs.lighter.xyz/api/candlesticks/candles.md, read 2026-11-17):
 *   GET /api/v1/candles?market_id=<id>&resolution=5m|15m&start_timestamp=<ms>&end_timestamp=<ms>&count_back=<n>
 *   - native resolutions include 5m and 15m (no aggregation needed);
 *   - at most 500 candles per call; `count_back` is a hint only, an explicit range wins;
 *   - `t` is the candle OPEN time in Unix ms (the start; `set_timestamp_to_end` is not sent);
 *   - prices are JSON numbers; "zero values are omitted".
 * Observed on the live API (2026-11-17): the newest row is the candle still FORMING. TrendPilot
 * only ever asks for bars up to the newest CLOSED open time (the caller's `toOpen`) and drops
 * anything later, so a forming candle is never stored as closed.
 *
 * `market` is the catalog market ID as a string ("92"). Only the Ethereum-based mainnet is used:
 * the environment identity is checked once before the first request.
 */

export const LIGHTER_CANDLES_PATH = '/api/v1/candles';
export const LIGHTER_CANDLES_MAX_PER_CALL = 500;
const RESOLUTION: Record<CandleInterval, string> = { '5': '5m', '15': '15m' };

const num = (v: unknown, field: string, at: string): string => {
  // A documented candle field may be omitted when zero; a price of zero is not a valid candle.
  if (v === undefined || v === null) throw new LighterPublicError(`candles ${at}: ${field} missing`, 'PARSE');
  const s = decimalString(v, field);
  if (Number(s) <= 0) throw new LighterPublicError(`candles ${at}: ${field} is not positive`, 'PARSE');
  return s;
};

/** `GET /api/v1/candles` body → closed-candle rows (open time aligned to the interval), oldest first. */
export function parseLighterCandles(body: unknown, market: string, interval: CandleInterval): MexcKline[] {
  const b = body as { code?: unknown; r?: unknown; c?: unknown; message?: unknown };
  if (!b || typeof b !== 'object') throw new LighterPublicError(`candles ${market}: unexpected response`, 'PARSE');
  if (b.code !== 200) throw new LighterPublicError(`candles ${market}: ${typeof b.message === 'string' ? b.message : 'request failed'} (code ${String(b.code)})`, 'API');
  if (b.r !== undefined && b.r !== RESOLUTION[interval]) throw new LighterPublicError(`candles ${market}: resolution ${String(b.r)} returned for ${RESOLUTION[interval]}`, 'PARSE');
  // An empty range may come back without the list ("zero values are omitted").
  if (b.c === undefined) return [];
  if (!Array.isArray(b.c)) throw new LighterPublicError(`candles ${market}: c is not a list`, 'PARSE');
  const ms = INTERVAL_MS[interval];
  const rows = (b.c as Record<string, unknown>[]).map((k, i) => {
    const t = k.t;
    if (typeof t !== 'number' || !Number.isSafeInteger(t) || t < 1e12) throw new LighterPublicError(`candles ${market}: bad open time at ${i}`, 'PARSE');
    if (t % ms !== 0) throw new LighterPublicError(`candles ${market}: open time ${t} is not aligned to ${interval}m`, 'PARSE');
    const at = `${market} ${new Date(t).toISOString()}`;
    const row = { openTime: new Date(t), open: num(k.o, 'o', at), high: num(k.h, 'h', at), low: num(k.l, 'l', at), close: num(k.c, 'c', at) };
    const hi = Number(row.high);
    const lo = Number(row.low);
    if (hi < lo || hi < Number(row.open) || hi < Number(row.close) || lo > Number(row.open) || lo > Number(row.close)) throw new LighterPublicError(`candles ${at}: high/low inconsistent with open/close`, 'PARSE');
    return row;
  });
  const byOpen = new Map(rows.map((r) => [r.openTime.getTime(), r]));
  return [...byOpen.values()].sort((a, b2) => a.openTime.getTime() - b2.openTime.getTime());
}

/** Candle-only public source for the shared MarketFeed (Lighter quotes come from the public WebSocket). */
export class LighterKlineSource implements PublicMarketSource {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly nowMs: () => number;
  private environmentChecked: Promise<void> | null = null;
  readonly requestCounts: Record<string, number> = {};

  constructor(o: { baseUrl?: string; fetch?: typeof fetch; timeoutMs?: number; now?: () => number; environment?: () => Promise<LighterEnvironmentIdentity> } = {}) {
    this.baseUrl = (o.baseUrl ?? LIGHTER_MAINNET_BASE_URL).replace(/\/+$/, '');
    this.fetchImpl = o.fetch ?? fetch;
    this.timeoutMs = o.timeoutMs ?? 8_000;
    this.nowMs = o.now ?? Date.now;
    this.environment = o.environment ?? (async () => this.readEnvironment());
  }
  private readonly environment: () => Promise<LighterEnvironmentIdentity>;

  private async getJson(path: string, query: Record<string, string> = {}): Promise<unknown> {
    const endpoint = path === '/' ? 'root' : (path.split('/').pop() ?? path);
    this.requestCounts[endpoint] = (this.requestCounts[endpoint] ?? 0) + 1;
    const url = new URL(this.baseUrl + path);
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
    let res: Response;
    try {
      res = await this.fetchImpl(url, { method: 'GET', headers: { accept: 'application/json' }, signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (e) {
      throw new LighterPublicError(`GET ${path}: ${(e as Error).message}`, 'NETWORK');
    }
    if (!res.ok) throw new LighterPublicError(`GET ${path}: HTTP ${res.status}`, 'HTTP', res.status);
    try {
      return await res.json();
    } catch {
      throw new LighterPublicError(`GET ${path}: invalid JSON`, 'PARSE');
    }
  }

  private async readEnvironment(): Promise<LighterEnvironmentIdentity> {
    const root = (await this.getJson('/')) as { network_id?: unknown };
    const info = (await this.getJson('/info')) as { contract_address?: unknown };
    if (typeof root?.network_id !== 'number' || typeof info?.contract_address !== 'string') throw new LighterPublicError('environment identity missing', 'PARSE');
    return { networkId: root.network_id, contractAddress: info.contract_address };
  }

  /** Refuses every request against an API that is not the Ethereum-based mainnet (checked once). */
  private async ensureMainnet(): Promise<void> {
    this.environmentChecked ??= this.environment().then(assertLighterMainnet);
    try {
      await this.environmentChecked;
    } catch (e) {
      this.environmentChecked = null; // re-check next time (network errors are transient)
      throw e;
    }
  }

  /** Lighter's REST `GET /` reports Unix SECONDS only; the local clock (offset 0) frames closed bars. */
  async serverTimeMs(): Promise<number> {
    return this.nowMs();
  }

  async ticker(): Promise<MexcTicker> {
    throw new LighterPublicError('Lighter quotes come from the public WebSocket, not REST polling', 'NOT_PUBLIC');
  }

  async contractDetail(): Promise<MexcContractDetail> {
    throw new LighterPublicError('Lighter market rules come from the catalog (instrument refresh)', 'NOT_PUBLIC');
  }

  /** Closed bars with open time in [fromOpen, toOpen] for one market ID, oldest first, ≤ 500 per call. */
  async klines(market: string, interval: CandleInterval, fromOpen: Date, toOpen: Date): Promise<MexcKline[]> {
    if (!/^\d+$/.test(market)) throw new LighterPublicError(`candles: "${market}" is not a Lighter market ID`, 'PARSE');
    await this.ensureMainnet();
    const ms = INTERVAL_MS[interval];
    const out = new Map<number, MexcKline>();
    for (let start = fromOpen.getTime(); start <= toOpen.getTime(); start += LIGHTER_CANDLES_MAX_PER_CALL * ms) {
      const lastOpen = Math.min(toOpen.getTime(), start + (LIGHTER_CANDLES_MAX_PER_CALL - 1) * ms);
      const count = Math.floor((lastOpen - start) / ms) + 1;
      this.requestCounts.candles = (this.requestCounts.candles ?? 0) + 1;
      // end_timestamp = the last wanted OPEN time: the response is filtered to [start, lastOpen] anyway,
      // so whether the API treats it as inclusive or exclusive cannot add a forming candle.
      const body = await this.getJson(LIGHTER_CANDLES_PATH, { market_id: market, resolution: RESOLUTION[interval], start_timestamp: String(start), end_timestamp: String(lastOpen + ms - 1), count_back: String(count) });
      for (const r of parseLighterCandles(body, market, interval)) {
        const t = r.openTime.getTime();
        if (t >= start && t <= lastOpen) out.set(t, r);
      }
    }
    return [...out.values()].sort((a, b) => a.openTime.getTime() - b.openTime.getTime());
  }
}

/** The environment the Lighter market data is read from (mainnet only in this release). */
export const LIGHTER_MARKET_DATA_ENVIRONMENT = LIGHTER_MAINNET.environment;
