import { bitunixSymbolFor, Decimal } from '@trendpilot/domain';

/**
 * Bitunix Futures PUBLIC market data: contract discovery (`trading_pairs`) and the REST ticker used
 * by smoke checks. Read-only, no credentials, and only allowlisted public paths, so it cannot reach
 * an account or order endpoint by mistake.
 *
 * Docs: https://www.bitunix.com/api-docs/futures/market/get_trading_pairs.html (read 2026-11-16).
 * Observed on the live API the same day (fixtures under test/fixtures/bitunix-public):
 *  - `symbolStatus` also takes `PREVIEW` (not in the docs: listed, not yet launched);
 *  - `launchTime` / `delistTime` arrive as millisecond strings; `delistTime` is omitted when unset;
 *  - `defaultMarginMode` arrives as the string "1" / "2";
 *  - an unknown symbol answers `{"code":20015,"data":null,"msg":"this Futures is not allowed to trade."}`;
 *  - the catalogue also lists USD-quoted contracts (e.g. BTCUSD), which TrendPilot does not trade.
 * Quantities are in the BASE coin (Bitunix has no contract multiplier): `minTradeVolume` is the
 * minimum opening amount and `basePrecision` its decimals; `quotePrecision` is the price decimals.
 */

export const BITUNIX_PUBLIC_DEFAULT_BASE_URL = 'https://fapi.bitunix.com';

const PUBLIC_PATHS = [/^\/api\/v1\/futures\/market\/trading_pairs$/, /^\/api\/v1\/futures\/market\/tickers$/];

export class BitunixPublicError extends Error {
  constructor(
    message: string,
    readonly kind: 'NETWORK' | 'HTTP' | 'API' | 'PARSE' | 'NOT_PUBLIC',
    readonly code?: number
  ) {
    super(message);
    this.name = 'BitunixPublicError';
  }
}

/** Bitunix "market not exists" / "this futures is not supported / not allowed to trade". */
export const BITUNIX_UNKNOWN_SYMBOL_CODES = [20001, 20012, 20015];

export type BitunixSymbolStatus = 'OPEN' | 'CANCEL_ONLY' | 'STOP' | 'PREVIEW' | string;

export interface BitunixContract {
  /** Exchange execution symbol, e.g. BTCUSDT. */
  exchangeSymbol: string;
  base: string;
  quote: string;
  symbolStatus: BitunixSymbolStatus;
  isApiSupported: boolean;
  /** Quantity step = 10^-basePrecision (base coin). */
  basePrecision: number;
  qtyStep: string;
  /** Price tick = 10^-quotePrecision. */
  quotePrecision: number;
  priceTick: string;
  /** Minimum opening quantity (base coin). */
  minTradeVolume: string;
  maxMarketOrderVolume: string | null;
  maxLimitOrderVolume: string | null;
  minLeverage: number | null;
  maxLeverage: number | null;
  defaultLeverage: number | null;
  /** "1" / "2" as Bitunix sends it (meaning not documented by value). */
  defaultMarginMode: string | null;
  priceProtectScope: string | null;
  launchTime: number | null;
  delistTime: number | null;
}

const num = (v: unknown, field: string, sym: string): string => {
  if (typeof v !== 'number' && typeof v !== 'string') throw new BitunixPublicError(`trading_pairs ${sym}: ${field} is missing`, 'PARSE');
  let d: Decimal;
  try {
    d = new Decimal(v);
  } catch {
    throw new BitunixPublicError(`trading_pairs ${sym}: ${field} is not a number`, 'PARSE');
  }
  if (!d.isFinite()) throw new BitunixPublicError(`trading_pairs ${sym}: ${field} is not finite`, 'PARSE');
  return d.toFixed();
};
const optNum = (v: unknown, field: string, sym: string) => (v === null || v === undefined || v === '' ? null : num(v, field, sym));
const optInt = (v: unknown) => {
  const n = typeof v === 'string' && v.trim() ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? Math.trunc(n) : null;
};
const precision = (v: unknown, field: string, sym: string): number => {
  const n = optInt(v);
  if (n === null || n < 0 || n > 18) throw new BitunixPublicError(`trading_pairs ${sym}: ${field} is not a precision`, 'PARSE');
  return n;
};

/** One `trading_pairs` row → contract. Throws PARSE on a row it cannot trust. */
export function parseBitunixContract(r: Record<string, unknown>): BitunixContract {
  if (!r || typeof r !== 'object' || typeof r.symbol !== 'string' || !r.symbol) throw new BitunixPublicError('trading_pairs: row without a symbol', 'PARSE');
  const sym = r.symbol;
  const basePrecision = precision(r.basePrecision, 'basePrecision', sym);
  const quotePrecision = precision(r.quotePrecision, 'quotePrecision', sym);
  return {
    exchangeSymbol: sym,
    base: typeof r.base === 'string' ? r.base : '',
    quote: typeof r.quote === 'string' ? r.quote : '',
    symbolStatus: typeof r.symbolStatus === 'string' ? r.symbolStatus : 'UNKNOWN',
    isApiSupported: r.isApiSupported === true,
    basePrecision,
    qtyStep: new Decimal(10).pow(-basePrecision).toFixed(),
    quotePrecision,
    priceTick: new Decimal(10).pow(-quotePrecision).toFixed(),
    minTradeVolume: num(r.minTradeVolume, 'minTradeVolume', sym),
    maxMarketOrderVolume: optNum(r.maxMarketOrderVolume, 'maxMarketOrderVolume', sym),
    maxLimitOrderVolume: optNum(r.maxLimitOrderVolume, 'maxLimitOrderVolume', sym),
    minLeverage: optInt(r.minLeverage),
    maxLeverage: optInt(r.maxLeverage),
    defaultLeverage: optInt(r.defaultLeverage),
    defaultMarginMode: r.defaultMarginMode === null || r.defaultMarginMode === undefined ? null : String(r.defaultMarginMode),
    priceProtectScope: optNum(r.priceProtectScope, 'priceProtectScope', sym),
    launchTime: optInt(r.launchTime),
    delistTime: optInt(r.delistTime)
  };
}

/** `{code, data: [...], msg}` → contracts. A non-zero code → BitunixPublicError(API, code). */
export function parseBitunixTradingPairs(body: unknown): BitunixContract[] {
  const e = body as { code?: unknown; msg?: unknown; data?: unknown };
  if (!e || typeof e !== 'object' || typeof e.code !== 'number') throw new BitunixPublicError('trading_pairs: unexpected response', 'PARSE');
  if (e.code !== 0) throw new BitunixPublicError(`trading_pairs: ${typeof e.msg === 'string' ? e.msg : 'request failed'} (code ${e.code})`, 'API', e.code);
  if (!Array.isArray(e.data)) throw new BitunixPublicError('trading_pairs: data is not a list', 'PARSE');
  return (e.data as Record<string, unknown>[]).map(parseBitunixContract);
}

/**
 * Why a contract cannot be traded through the API by TrendPilot (empty = eligible): USDT-quoted,
 * status OPEN, API trading enabled, launched, not delisted, sane quantity/price rules.
 */
export function bitunixContractProblems(c: BitunixContract, nowMs: number = Date.now()): string[] {
  const out: string[] = [];
  if (c.quote !== 'USDT') out.push(`it is not USDT-quoted (quote ${c.quote || '?'})`);
  if (c.symbolStatus !== 'OPEN') out.push(`it is not open for trading on Bitunix (status ${c.symbolStatus})`);
  if (!c.isApiSupported) out.push('Bitunix does not allow API trading on it');
  if (c.launchTime !== null && c.launchTime > nowMs) out.push(`it launches ${new Date(c.launchTime).toISOString()}`);
  if (c.delistTime !== null && c.delistTime <= nowMs) out.push(`it was delisted ${new Date(c.delistTime).toISOString()}`);
  if (!new Decimal(c.minTradeVolume).gt(0)) out.push('its minimum opening quantity is not positive');
  if (c.maxMarketOrderVolume !== null && new Decimal(c.maxMarketOrderVolume).lt(c.minTradeVolume)) out.push('its maximum market order is below the minimum opening quantity');
  return out;
}

export type BitunixSymbolLookup =
  | { ok: true; contract: BitunixContract; warnings: string[] }
  | { ok: false; reason: 'INVALID_INPUT' | 'UNKNOWN_SYMBOL' | 'NOT_ELIGIBLE'; message: string; contract?: BitunixContract };

/**
 * Validates a symbol (a TradingView source symbol or a Bitunix symbol) against loaded contracts.
 * The source symbol is only used to look the contract up; the result carries the execution symbol.
 */
export function validateBitunixSymbol(input: string, contracts: BitunixContract[], nowMs: number = Date.now()): BitunixSymbolLookup {
  const sym = bitunixSymbolFor(input);
  if (!sym) return { ok: false, reason: 'INVALID_INPUT', message: `${input || '(empty)'} is not a USDT perpetual symbol such as BTCUSDT.` };
  const c = contracts.find((x) => x.exchangeSymbol === sym);
  if (!c) return { ok: false, reason: 'UNKNOWN_SYMBOL', message: `${sym} is not a Bitunix Futures contract.` };
  const problems = bitunixContractProblems(c, nowMs);
  if (problems.length) return { ok: false, reason: 'NOT_ELIGIBLE', message: `${sym} cannot be used: ${problems.join('; ')}.`, contract: c };
  const warnings: string[] = [];
  if (c.delistTime !== null) warnings.push(`Bitunix schedules delisting at ${new Date(c.delistTime).toISOString()}.`);
  if (c.maxLeverage === null) warnings.push('Bitunix did not report a leverage range.');
  if (c.maxMarketOrderVolume === null) warnings.push('Bitunix did not report a maximum market order quantity.');
  return { ok: true, contract: c, warnings };
}

export interface BitunixRestTicker {
  exchangeSymbol: string;
  last: string;
  mark: string;
}

export interface BitunixPublicClientOptions {
  baseUrl?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

/** HTTP client for the public endpoints. No headers beyond Accept; no credentials, ever. */
export class BitunixPublicClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  readonly requestCounts: Record<string, number> = {};

  constructor(o: BitunixPublicClientOptions = {}) {
    this.baseUrl = (o.baseUrl ?? BITUNIX_PUBLIC_DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.timeoutMs = o.timeoutMs ?? 8_000;
    this.fetchImpl = o.fetch ?? fetch;
  }

  async get(path: string, query: Record<string, string> = {}): Promise<unknown> {
    if (!PUBLIC_PATHS.some((re) => re.test(path))) throw new BitunixPublicError(`Refusing non-public path ${path}`, 'NOT_PUBLIC');
    const endpoint = path.split('/').pop() ?? path;
    this.requestCounts[endpoint] = (this.requestCounts[endpoint] ?? 0) + 1;
    const url = new URL(this.baseUrl + path);
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
    let res: Response;
    try {
      res = await this.fetchImpl(url, { method: 'GET', headers: { accept: 'application/json' }, signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (e) {
      throw new BitunixPublicError(`GET ${path}: ${(e as Error).message}`, 'NETWORK');
    }
    if (!res.ok) throw new BitunixPublicError(`GET ${path}: HTTP ${res.status}`, 'HTTP', res.status);
    try {
      return await res.json();
    } catch {
      throw new BitunixPublicError(`GET ${path}: invalid JSON`, 'PARSE');
    }
  }

  /** Contracts by execution symbol (all of them when `symbols` is empty). */
  async tradingPairs(symbols: string[] = []): Promise<BitunixContract[]> {
    return parseBitunixTradingPairs(await this.get('/api/v1/futures/market/trading_pairs', symbols.length ? { symbols: symbols.join(',') } : {}));
  }

  async tickers(symbols: string[]): Promise<BitunixRestTicker[]> {
    const body = (await this.get('/api/v1/futures/market/tickers', { symbols: symbols.join(',') })) as { code?: number; msg?: string; data?: unknown };
    if (!body || body.code !== 0 || !Array.isArray(body.data)) throw new BitunixPublicError(`tickers: ${body?.msg ?? 'unexpected response'} (code ${body?.code})`, body && typeof body.code === 'number' && body.code !== 0 ? 'API' : 'PARSE', body?.code);
    return (body.data as Record<string, unknown>[]).map((t) => ({ exchangeSymbol: String(t.symbol), last: num(t.lastPrice, 'lastPrice', String(t.symbol)), mark: num(t.markPrice, 'markPrice', String(t.symbol)) }));
  }
}

export interface BitunixDiscovery {
  checkedAt: string;
  contracts: BitunixContract[];
  /** Per requested symbol: eligible, or why not. */
  results: Record<string, BitunixSymbolLookup>;
}

/** Contract discovery for the requested symbols (default BTCUSDT and XAUUSDT). */
export async function discoverBitunixContracts(client: Pick<BitunixPublicClient, 'tradingPairs'>, symbols: string[] = ['BTCUSDT', 'XAUUSDT'], now: () => Date = () => new Date()): Promise<BitunixDiscovery> {
  const wanted = symbols.map((s) => bitunixSymbolFor(s) ?? s);
  let contracts: BitunixContract[];
  try {
    contracts = await client.tradingPairs(wanted.filter((s) => bitunixSymbolFor(s)));
  } catch (e) {
    // Bitunix rejects the whole request when one symbol is unknown (20015); fall back to the full list.
    if (e instanceof BitunixPublicError && e.kind === 'API' && BITUNIX_UNKNOWN_SYMBOL_CODES.includes(e.code ?? -1)) contracts = await client.tradingPairs([]);
    else throw e;
  }
  const at = now();
  return { checkedAt: at.toISOString(), contracts, results: Object.fromEntries(symbols.map((s) => [s, validateBitunixSymbol(s, contracts, at.getTime())])) };
}
