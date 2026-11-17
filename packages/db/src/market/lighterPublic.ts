import { Decimal, isLighterMarketId } from '@trendpilot/domain';

/**
 * Lighter (zkLighter) PUBLIC market catalog, read-only (Lighter plan, Step 1: market registration).
 * No account, no signing, no orders, no prices: only GET requests to the public catalog and the
 * environment identity. Sources (read 2026-11-17):
 *  - https://docs.lighter.xyz/developers/getting-started/environments.md : Ethereum mainnet REST base
 *    https://mainnet.zklighter.elliot.ai, L1 chain Ethereum (1), ZkLighter contract
 *    0x3B4D794a66304F130a4Db8F2551B0070dfCf5ca7. Robinhood Chain is a separate exchange
 *    (api.rh.lighter.xyz, collateral USDG) and is never accepted here.
 *  - https://docs.lighter.xyz/developers/robinhood-chain/overview.md : main collateral on Ethereum
 *    Lighter is USDC.
 *  - https://docs.lighter.xyz/developers/getting-started/core-concepts.md : `min_quote_amount` is in
 *    USDC; sizes and prices are integers scaled by `size_decimals` / `price_decimals`.
 *  - https://docs.lighter.xyz/developers/integration-guides/market-data.md : orderBookDetails returns
 *    perps (`order_book_details`) and spot (`spot_order_book_details`); "Only trade active markets";
 *    "Never hard-code market IDs other than for tests".
 * Observed on the live API (2026-11-17), not stated in the docs: every perp reports quote_asset_id 0,
 * while assetDetails lists USDC as asset 3 (used by spot pairs). TrendPilot therefore treats
 * "perp with quote_asset_id 0 on the verified Ethereum mainnet" as USDC-settled, and refuses any
 * other quote asset rather than guessing.
 */

export const LIGHTER_MAINNET_BASE_URL = 'https://mainnet.zklighter.elliot.ai';

/** The one Lighter environment TrendPilot registers markets for: Ethereum-based mainnet. */
export const LIGHTER_MAINNET = {
  environment: 'MAINNET' as const,
  /** `GET /` → `network_id` (Ethereum L1 chain ID, docs: "L1 chain | Ethereum (1)"). */
  networkId: 1,
  /** `GET /info` → `contract_address` (docs: ZkLighter mainnet contract). */
  contractAddress: '0x3B4D794a66304F130a4Db8F2551B0070dfCf5ca7',
  /** Main collateral of Ethereum Lighter (docs); perps settle in it. */
  settlementCurrency: 'USDC' as const,
  /** Perp collateral asset ID as the catalog reports it (observed, see header). */
  perpQuoteAssetId: 0
};

/** Only these public paths are ever requested. */
const PUBLIC_PATHS = [/^\/$/, /^\/info$/, /^\/api\/v1\/orderBookDetails$/];

export type LighterPublicErrorKind = 'NOT_PUBLIC' | 'NETWORK' | 'HTTP' | 'PARSE' | 'API' | 'WRONG_ENVIRONMENT';

export class LighterPublicError extends Error {
  constructor(
    message: string,
    readonly kind: LighterPublicErrorKind,
    readonly status?: number
  ) {
    super(message);
    this.name = 'LighterPublicError';
  }
}

/** One market from the official catalog, as TrendPilot needs it (raw values kept as strings). */
export interface LighterMarket {
  marketId: number;
  /** Native symbol (e.g. "XAU"), kept exactly as the catalog lists it. */
  symbol: string;
  marketType: 'perp' | 'spot' | string;
  status: string;
  quoteAssetId: number;
  sizeDecimals: number;
  priceDecimals: number;
  minBaseAmount: string;
  minQuoteAmount: string;
  takerFee: string;
  makerFee: string;
  /** Margin fractions in 1/10000 (docs: leverage = 10000 / fraction). Null when not reported (spot). */
  minInitialMarginFraction: number | null;
  defaultInitialMarginFraction: number | null;
  maintenanceMarginFraction: number | null;
  isFrozen: boolean;
  deployer: string;
  /** Dated / binary-outcome markets carry a non-zero end, settlement type or outcome. */
  endTimestamp: number;
  settlementType: number;
  outcome: number;
  hidden: boolean;
}

export interface LighterEnvironmentIdentity {
  networkId: number;
  contractAddress: string;
}

export interface LighterPublicClientOptions {
  baseUrl?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

const int = (v: unknown, field: string, sym: string): number => {
  if (typeof v !== 'number' || !Number.isInteger(v)) throw new LighterPublicError(`${sym}: ${field} is not an integer`, 'PARSE');
  return v;
};
const dec = (v: unknown, field: string, sym: string): string => {
  if (typeof v !== 'string' || !/^\d+(\.\d+)?$/.test(v)) throw new LighterPublicError(`${sym}: ${field} is not a decimal string`, 'PARSE');
  return new Decimal(v).toFixed();
};
const optInt = (v: unknown, field: string, sym: string): number | null => (v === undefined || v === null ? null : int(v, field, sym));

function parseMarket(raw: unknown, listedAs: 'perp' | 'spot'): LighterMarket {
  const m = raw as Record<string, unknown>;
  const sym = typeof m?.symbol === 'string' ? m.symbol : '(no symbol)';
  if (typeof m?.symbol !== 'string' || !m.symbol) throw new LighterPublicError('market without symbol', 'PARSE');
  const marketId = int(m.market_id, 'market_id', sym);
  if (!isLighterMarketId(marketId)) throw new LighterPublicError(`${sym}: market_id out of range`, 'PARSE');
  const cfg = (m.market_config ?? {}) as Record<string, unknown>;
  return {
    marketId,
    symbol: m.symbol,
    // The list a market comes from is authoritative; a contradicting market_type is kept and refused.
    marketType: typeof m.market_type === 'string' ? m.market_type : listedAs,
    status: typeof m.status === 'string' ? m.status : '',
    quoteAssetId: int(m.quote_asset_id, 'quote_asset_id', sym),
    sizeDecimals: int(m.size_decimals ?? m.supported_size_decimals, 'size_decimals', sym),
    priceDecimals: int(m.price_decimals ?? m.supported_price_decimals, 'price_decimals', sym),
    minBaseAmount: dec(m.min_base_amount, 'min_base_amount', sym),
    minQuoteAmount: dec(m.min_quote_amount, 'min_quote_amount', sym),
    takerFee: dec(m.taker_fee, 'taker_fee', sym),
    makerFee: dec(m.maker_fee, 'maker_fee', sym),
    minInitialMarginFraction: optInt(m.min_initial_margin_fraction, 'min_initial_margin_fraction', sym),
    defaultInitialMarginFraction: optInt(m.default_initial_margin_fraction, 'default_initial_margin_fraction', sym),
    maintenanceMarginFraction: optInt(m.maintenance_margin_fraction, 'maintenance_margin_fraction', sym),
    isFrozen: m.is_frozen === true,
    deployer: typeof m.market_deployer === 'string' ? m.market_deployer : '',
    endTimestamp: typeof m.end_timestamp === 'number' ? m.end_timestamp : 0,
    settlementType: typeof m.settlement_type === 'number' ? m.settlement_type : 0,
    outcome: typeof m.outcome === 'number' ? m.outcome : 0,
    hidden: cfg.hidden === true
  };
}

/** `GET /api/v1/orderBookDetails` body → perps and spot markets (spot kept so it can be refused by name). */
export function parseLighterOrderBookDetails(body: unknown): LighterMarket[] {
  const b = body as { code?: unknown; order_book_details?: unknown; spot_order_book_details?: unknown };
  if (!b || typeof b !== 'object') throw new LighterPublicError('orderBookDetails: unexpected response', 'PARSE');
  if (b.code !== 200) throw new LighterPublicError(`orderBookDetails: code ${String(b.code)}`, 'API');
  if (!Array.isArray(b.order_book_details)) throw new LighterPublicError('orderBookDetails: order_book_details missing', 'PARSE');
  const spot = Array.isArray(b.spot_order_book_details) ? b.spot_order_book_details : [];
  return [...b.order_book_details.map((m) => parseMarket(m, 'perp')), ...spot.map((m) => parseMarket(m, 'spot'))];
}

export class LighterPublicClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(o: LighterPublicClientOptions = {}) {
    this.baseUrl = (o.baseUrl ?? LIGHTER_MAINNET_BASE_URL).replace(/\/+$/, '');
    this.timeoutMs = o.timeoutMs ?? 8_000;
    this.fetchImpl = o.fetch ?? fetch;
  }

  async get(path: string, query: Record<string, string> = {}): Promise<unknown> {
    if (!PUBLIC_PATHS.some((re) => re.test(path))) throw new LighterPublicError(`Refusing non-public path ${path}`, 'NOT_PUBLIC');
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

  /** `GET /` and `GET /info`: which network and contract this API serves. */
  async environment(): Promise<LighterEnvironmentIdentity> {
    const root = (await this.get('/')) as { network_id?: unknown };
    const info = (await this.get('/info')) as { contract_address?: unknown };
    if (typeof root?.network_id !== 'number' || typeof info?.contract_address !== 'string') throw new LighterPublicError('environment identity missing', 'PARSE');
    return { networkId: root.network_id, contractAddress: info.contract_address };
  }

  /** The full public catalog (perps and spot). */
  async markets(): Promise<LighterMarket[]> {
    return parseLighterOrderBookDetails(await this.get('/api/v1/orderBookDetails'));
  }
}

/** Refuses an API that is not the Ethereum-based Lighter mainnet (testnet, Robinhood Chain, anything else). */
export function assertLighterMainnet(id: LighterEnvironmentIdentity): void {
  if (id.networkId !== LIGHTER_MAINNET.networkId || id.contractAddress.toLowerCase() !== LIGHTER_MAINNET.contractAddress.toLowerCase()) {
    throw new LighterPublicError(
      `This Lighter API is not the Ethereum-based mainnet (network ${id.networkId}, contract ${id.contractAddress}); TrendPilot registers mainnet markets only.`,
      'WRONG_ENVIRONMENT'
    );
  }
}

export type LighterIneligibility = 'NOT_PERP' | 'INACTIVE' | 'FROZEN' | 'HIDDEN' | 'NOT_USDC' | 'DATED_OR_BINARY' | 'EXTERNAL_DEPLOYER' | 'FEE_UNIT_UNVERIFIED' | 'MARGIN_UNKNOWN' | 'BAD_RULES';

/**
 * Whether TrendPilot supports a catalog market: an active, listed, Lighter-deployed, perpetual
 * (no expiry, no binary outcome) USDC-settled market with margin rules. Returns every reason it fails.
 */
export function lighterIneligibility(m: LighterMarket): { reason: LighterIneligibility; message: string }[] {
  const out: { reason: LighterIneligibility; message: string }[] = [];
  const add = (reason: LighterIneligibility, message: string) => out.push({ reason, message });
  if (m.marketType !== 'perp') add('NOT_PERP', `${m.symbol} (market ${m.marketId}) is a ${m.marketType} market; only perpetuals are supported.`);
  if (m.status !== 'active') add('INACTIVE', `${m.symbol} (market ${m.marketId}) is ${m.status || 'not active'} on Lighter.`);
  if (m.isFrozen) add('FROZEN', `${m.symbol} (market ${m.marketId}) is frozen on Lighter.`);
  if (m.hidden) add('HIDDEN', `${m.symbol} (market ${m.marketId}) is hidden on Lighter.`);
  if (m.marketType === 'perp' && m.quoteAssetId !== LIGHTER_MAINNET.perpQuoteAssetId) add('NOT_USDC', `${m.symbol} (market ${m.marketId}) does not settle in the USDC perp collateral (quote asset ${m.quoteAssetId}).`);
  if (m.marketType === 'spot') add('NOT_USDC', `${m.symbol} is a spot pair, not a USDC-settled perpetual.`);
  if (m.endTimestamp !== 0 || m.settlementType !== 0 || m.outcome !== 0) add('DATED_OR_BINARY', `${m.symbol} (market ${m.marketId}) has an expiry or outcome; only perpetuals are supported.`);
  if (m.deployer !== 'lighter') add('EXTERNAL_DEPLOYER', `${m.symbol} (market ${m.marketId}) is deployed by "${m.deployer || 'unknown'}", not by Lighter.`);
  // The catalog lists 0.0000 for every market today; the unit of a non-zero value is not documented.
  if (!new Decimal(m.takerFee).isZero() || !new Decimal(m.makerFee).isZero()) add('FEE_UNIT_UNVERIFIED', `${m.symbol} reports fees ${m.takerFee}/${m.makerFee}; their unit is not documented, so the market is not registered.`);
  if (m.marketType === 'perp' && (m.minInitialMarginFraction === null || m.minInitialMarginFraction <= 0 || m.minInitialMarginFraction > 10_000)) add('MARGIN_UNKNOWN', `${m.symbol} reports no usable initial margin fraction.`);
  if (m.sizeDecimals < 0 || m.sizeDecimals > 12 || m.priceDecimals < 0 || m.priceDecimals > 12 || new Decimal(m.minBaseAmount).lte(0)) add('BAD_RULES', `${m.symbol} reports unusable size or price rules.`);
  return out;
}

/** Highest leverage from the minimum initial margin fraction (docs: leverage = 10000 / fraction), floored. */
export const lighterMaxLeverage = (m: Pick<LighterMarket, 'minInitialMarginFraction'>): number => Math.max(1, Math.floor(10_000 / (m.minInitialMarginFraction ?? 10_000)));

export type LighterLookup =
  | { ok: true; market: LighterMarket; settlementCurrency: 'USDC'; maxLeverage: number }
  | { ok: false; reason: 'INVALID_INPUT' | 'UNKNOWN_MARKET' | 'AMBIGUOUS' | 'NOT_ELIGIBLE'; message: string; details?: { reason: LighterIneligibility; message: string }[] };

/**
 * Finds the market an administrator asked for, by its exact native symbol ("XAU") or its numeric
 * market ID ("92"). Nothing is derived: "XAUUSDT", "XAU/USDC" or "XAU_USDC" are not rewritten to XAU,
 * and a market ID is never inferred from a ticker.
 */
export function findLighterMarket(markets: LighterMarket[], input: string): LighterLookup {
  const q = (input ?? '').trim();
  if (!q || q.length > 32 || !/^[A-Za-z0-9/_.-]+$/.test(q)) return { ok: false, reason: 'INVALID_INPUT', message: 'Enter the Lighter market symbol exactly as Lighter lists it (e.g. XAU) or its market ID (e.g. 92).' };
  const byId = /^\d+$/.test(q) ? markets.filter((m) => m.marketId === Number(q)) : [];
  const bySymbol = byId.length ? [] : markets.filter((m) => m.symbol === q.toUpperCase() || m.symbol === q);
  const hits = byId.length ? byId : bySymbol;
  if (!hits.length) return { ok: false, reason: 'UNKNOWN_MARKET', message: `Lighter lists no market "${q}". Use the native symbol (e.g. XAU, not XAUUSDT) or the market ID.` };
  // A symbol listed as both a perp and something else: prefer nothing, ask for the market ID.
  if (hits.length > 1) return { ok: false, reason: 'AMBIGUOUS', message: `"${q}" matches ${hits.length} Lighter markets (${hits.map((m) => `${m.marketType} ${m.marketId}`).join(', ')}). Enter the market ID.` };
  const market = hits[0]!;
  const problems = lighterIneligibility(market);
  if (problems.length) return { ok: false, reason: 'NOT_ELIGIBLE', message: problems.map((p) => p.message).join(' '), details: problems };
  return { ok: true, market, settlementCurrency: LIGHTER_MAINNET.settlementCurrency, maxLeverage: lighterMaxLeverage(market) };
}
