import { Decimal, type CandleInterval } from '@trendpilot/domain';

/**
 * MEXC Futures PUBLIC market-data adapter (MKT-01). Read-only: ticker, klines, server time and
 * contract detail. It never sends credentials or signatures, and it refuses any path outside the
 * public allowlist, so it cannot reach a private (account or order) endpoint by mistake.
 *
 * Docs: https://www.mexc.com/api-docs/futures/market-endpoints
 */

export const MEXC_PUBLIC_DEFAULT_BASE_URL = 'https://contract.mexc.com';

/** The only paths this adapter may request. Everything under /private/ is out of reach. */
const PUBLIC_PATHS = [/^\/api\/v1\/contract\/ping$/, /^\/api\/v1\/contract\/ticker$/, /^\/api\/v1\/contract\/kline\/[A-Z0-9]+_[A-Z0-9]+$/, /^\/api\/v1\/contract\/detail$/, /^\/api\/v1\/contract\/funding_rate\/history$/];

export class MexcPublicError extends Error {
  constructor(
    message: string,
    readonly kind: 'NETWORK' | 'HTTP' | 'API' | 'PARSE' | 'NOT_PUBLIC',
    readonly code?: number
  ) {
    super(message);
    this.name = 'MexcPublicError';
  }
}

export interface MexcTicker {
  exchangeSymbol: string;
  bid: string;
  ask: string;
  /** MEXC "fairPrice": the mark price used for liquidation and PnL. */
  mark: string;
  last: string;
  index: string | null;
  /** Exchange timestamp of this ticker (exchange clock, ms). */
  exchangeTimeMs: number;
}

export interface MexcKline {
  openTime: Date;
  open: string;
  high: string;
  low: string;
  close: string;
}

export interface MexcContractDetail {
  exchangeSymbol: string;
  contractSize: string;
  priceUnit: string;
  volUnit: string;
  minVol: string;
  maxVol: string;
  /** 0 = enabled on the exchange. */
  state: number;
  apiAllowed: boolean | null;
}

/** A SETTLED funding rate (public history). The ticker's predicted rate is never used for booking. */
export interface MexcSettledFunding {
  settledAt: Date;
  rate: string;
}

/** What the feed needs from a public data source. A stub implements it in tests. */
export interface PublicMarketSource {
  serverTimeMs(): Promise<number>;
  ticker(exchangeSymbol: string): Promise<MexcTicker>;
  klines(exchangeSymbol: string, interval: CandleInterval, fromOpen: Date, toOpen: Date): Promise<MexcKline[]>;
  contractDetail(exchangeSymbol: string): Promise<MexcContractDetail>;
  /** Newest settled funding rates, newest first. Optional: sources without it book no funding. */
  fundingHistory?(exchangeSymbol: string, pageSize?: number): Promise<MexcSettledFunding[]>;
  /** REST requests sent so far, by endpoint (for logs and the zero-REST-ticker check). */
  readonly requestCounts?: Record<string, number>;
}

const KLINE_INTERVAL: Record<CandleInterval, string> = { '5': 'Min5', '15': 'Min15' };

/** JSON number → exact decimal string ("1e-7" → "0.0000001"). */
export function decimalString(v: unknown, field: string): string {
  if (typeof v !== 'number' && typeof v !== 'string') throw new MexcPublicError(`${field} is missing`, 'PARSE');
  let d: Decimal;
  try {
    d = new Decimal(v);
  } catch {
    throw new MexcPublicError(`${field} is not a number`, 'PARSE');
  }
  if (!d.isFinite()) throw new MexcPublicError(`${field} is not finite`, 'PARSE');
  return d.toFixed();
}

interface Envelope {
  success?: boolean;
  code?: number;
  message?: string;
  data?: unknown;
}

function unwrap(body: unknown, what: string): unknown {
  const e = body as Envelope;
  if (!e || typeof e !== 'object') throw new MexcPublicError(`${what}: unexpected response`, 'PARSE');
  if (e.success !== true || e.code !== 0) throw new MexcPublicError(`${what}: ${e.message ?? 'request failed'} (code ${e.code})`, 'API', e.code);
  return e.data;
}

export function parseServerTime(body: unknown): number {
  const t = unwrap(body, 'ping');
  if (typeof t !== 'number' || !Number.isFinite(t)) throw new MexcPublicError('ping: no server time', 'PARSE');
  return t;
}

export function parseTicker(body: unknown, exchangeSymbol: string): MexcTicker {
  return tickerFromData(unwrap(body, `ticker ${exchangeSymbol}`), exchangeSymbol);
}

/** The ticker object shared by REST `/contract/ticker` and WebSocket `push.ticker`. */
export function tickerFromData(data: unknown, exchangeSymbol: string): MexcTicker {
  const d = data as Record<string, unknown>;
  if (!d || typeof d !== 'object' || Array.isArray(d)) throw new MexcPublicError(`ticker ${exchangeSymbol}: expected one contract`, 'PARSE');
  if (d.symbol !== exchangeSymbol) throw new MexcPublicError(`ticker ${exchangeSymbol}: response is for ${String(d.symbol)}`, 'PARSE');
  const ts = d.timestamp;
  if (typeof ts !== 'number' || !Number.isFinite(ts)) throw new MexcPublicError(`ticker ${exchangeSymbol}: no timestamp`, 'PARSE');
  return {
    exchangeSymbol,
    bid: decimalString(d.bid1, 'bid1'),
    ask: decimalString(d.ask1, 'ask1'),
    mark: decimalString(d.fairPrice, 'fairPrice'),
    last: decimalString(d.lastPrice, 'lastPrice'),
    index: d.indexPrice === undefined || d.indexPrice === null ? null : decimalString(d.indexPrice, 'indexPrice'),
    exchangeTimeMs: ts
  };
}

/** Column-oriented kline arrays → rows, oldest first. `time` is the bar open in seconds. */
export function parseKlines(body: unknown, exchangeSymbol: string): MexcKline[] {
  const d = unwrap(body, `kline ${exchangeSymbol}`) as Record<string, unknown>;
  const cols = ['time', 'open', 'high', 'low', 'close'] as const;
  for (const c of cols) if (!Array.isArray(d?.[c])) throw new MexcPublicError(`kline ${exchangeSymbol}: missing ${c}[]`, 'PARSE');
  const time = d.time as unknown[];
  if (cols.some((c) => (d[c] as unknown[]).length !== time.length)) throw new MexcPublicError(`kline ${exchangeSymbol}: column lengths differ`, 'PARSE');
  const rows = time.map((t, i) => {
    if (typeof t !== 'number' || !Number.isInteger(t)) throw new MexcPublicError(`kline ${exchangeSymbol}: bad time at ${i}`, 'PARSE');
    return {
      openTime: new Date(t * 1000),
      open: decimalString((d.open as unknown[])[i], 'open'),
      high: decimalString((d.high as unknown[])[i], 'high'),
      low: decimalString((d.low as unknown[])[i], 'low'),
      close: decimalString((d.close as unknown[])[i], 'close')
    };
  });
  return rows.sort((a, b) => a.openTime.getTime() - b.openTime.getTime());
}

export function parseContractDetail(body: unknown, exchangeSymbol: string): MexcContractDetail {
  const d = unwrap(body, `detail ${exchangeSymbol}`) as Record<string, unknown>;
  if (!d || typeof d !== 'object' || Array.isArray(d) || d.symbol !== exchangeSymbol) throw new MexcPublicError(`detail ${exchangeSymbol}: unexpected response`, 'PARSE');
  return {
    exchangeSymbol,
    contractSize: decimalString(d.contractSize, 'contractSize'),
    priceUnit: decimalString(d.priceUnit, 'priceUnit'),
    volUnit: decimalString(d.volUnit, 'volUnit'),
    minVol: decimalString(d.minVol, 'minVol'),
    maxVol: decimalString(d.maxVol, 'maxVol'),
    state: typeof d.state === 'number' ? d.state : -1,
    apiAllowed: typeof d.apiAllowed === 'boolean' ? d.apiAllowed : null
  };
}

export function parseFundingHistory(body: unknown, exchangeSymbol: string): MexcSettledFunding[] {
  const d = unwrap(body, `funding history ${exchangeSymbol}`) as { resultList?: unknown };
  if (!d || !Array.isArray(d.resultList)) throw new MexcPublicError(`funding history ${exchangeSymbol}: missing resultList`, 'PARSE');
  return (d.resultList as Record<string, unknown>[])
    .filter((r) => r.symbol === exchangeSymbol)
    .map((r) => {
      if (typeof r.settleTime !== 'number') throw new MexcPublicError(`funding history ${exchangeSymbol}: bad settleTime`, 'PARSE');
      return { settledAt: new Date(r.settleTime), rate: decimalString(r.fundingRate, 'fundingRate') };
    })
    .sort((a, b) => b.settledAt.getTime() - a.settledAt.getTime());
}

export interface MexcPublicClientOptions {
  baseUrl?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

/** HTTP client for the public endpoints. No headers beyond Accept; no credentials, ever. */
export class MexcPublicClient implements PublicMarketSource {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  /** REST requests sent since start, by endpoint (ping, ticker, kline, detail, funding_rate). */
  readonly requestCounts: Record<string, number> = {};

  constructor(o: MexcPublicClientOptions = {}) {
    this.baseUrl = (o.baseUrl ?? MEXC_PUBLIC_DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.timeoutMs = o.timeoutMs ?? 5_000;
    this.fetchImpl = o.fetch ?? fetch;
  }

  async get(path: string, query: Record<string, string> = {}): Promise<unknown> {
    if (!PUBLIC_PATHS.some((re) => re.test(path))) throw new MexcPublicError(`Refusing non-public path ${path}`, 'NOT_PUBLIC');
    const endpoint = path.split('/')[4] ?? path;
    this.requestCounts[endpoint] = (this.requestCounts[endpoint] ?? 0) + 1;
    const url = new URL(this.baseUrl + path);
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
    let res: Response;
    try {
      res = await this.fetchImpl(url, { method: 'GET', headers: { accept: 'application/json' }, signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (e) {
      throw new MexcPublicError(`GET ${path}: ${(e as Error).message}`, 'NETWORK');
    }
    if (!res.ok) throw new MexcPublicError(`GET ${path}: HTTP ${res.status}`, 'HTTP', res.status);
    try {
      return await res.json();
    } catch {
      throw new MexcPublicError(`GET ${path}: invalid JSON`, 'PARSE');
    }
  }

  async serverTimeMs(): Promise<number> {
    return parseServerTime(await this.get('/api/v1/contract/ping'));
  }

  async ticker(exchangeSymbol: string): Promise<MexcTicker> {
    return parseTicker(await this.get('/api/v1/contract/ticker', { symbol: exchangeSymbol }), exchangeSymbol);
  }

  async klines(exchangeSymbol: string, interval: CandleInterval, fromOpen: Date, toOpen: Date): Promise<MexcKline[]> {
    const body = await this.get(`/api/v1/contract/kline/${exchangeSymbol}`, {
      interval: KLINE_INTERVAL[interval],
      start: String(Math.floor(fromOpen.getTime() / 1000)),
      end: String(Math.floor(toOpen.getTime() / 1000))
    });
    return parseKlines(body, exchangeSymbol);
  }

  async fundingHistory(exchangeSymbol: string, pageSize = 10): Promise<MexcSettledFunding[]> {
    return parseFundingHistory(await this.get('/api/v1/contract/funding_rate/history', { symbol: exchangeSymbol, page_num: '1', page_size: String(pageSize) }), exchangeSymbol);
  }

  async contractDetail(exchangeSymbol: string): Promise<MexcContractDetail> {
    return parseContractDetail(await this.get('/api/v1/contract/detail', { symbol: exchangeSymbol }), exchangeSymbol);
  }
}

/** MEXC Futures symbol format, e.g. BTC_USDT. */
export const isMexcFuturesSymbol = (s: string) => /^[A-Z0-9]+_USDT$/.test(s);
