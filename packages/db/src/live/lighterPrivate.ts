import { Decimal, LIGHTER_ENVIRONMENTS, type LighterEnvironment, type LighterOrderReq } from '@trendpilot/domain';
import { lighterMainnetOrdersEnabled } from './lighterLiveScope';
import { LiveOrderTransportRefused, openLiveOrderTransport } from './mexcPrivate';

/**
 * Lighter PRIVATE access (Lighter plan Step 4): the signer port, account reads and the order
 * transport. Documented contract (docs.lighter.xyz, read 2026-11-17):
 *  - Public, unauthenticated: GET /api/v1/account?by=index&value= (collateral, positions with
 *    `sign` 1 long / −1 short — one net position per market), /api/v1/apikeys (registered public
 *    key per API key index), /api/v1/nextNonce, /api/v1/tx?by=hash (status 0 failed, 1 pending,
 *    2 executed, 3 pending-final), /api/v1/orderBookOrders.
 *  - Auth token required (signed by the API key; max 8 h): /api/v1/accountOrders (by
 *    client_order_indexes), /api/v1/accountActiveOrders, /api/v1/trades (taker_fee, maker_fee,
 *    realized P&L per side), /api/v1/positionFunding, /api/v1/accountLimits.
 *  - POST /api/v1/sendTx (form: tx_type, tx_info): code 200 = ACCEPTED, not executed.
 *
 * Signing (orders, cancels, modifies, auth tokens) is Lighter's own scheme (Schnorr over ECgFp5 /
 * Poseidon2), implemented only by the official Go signer. `LighterSigner` is the port; production
 * uses the pinned lighter-go v1.0.12 WASM build (lighterWasmSigner.ts, Step 4A). Credentials, auth
 * tokens and signed payloads are never logged or returned to a browser.
 */

export class LighterPrivateError extends Error {
  constructor(
    message: string,
    readonly kind: 'REFUSED' | 'NETWORK' | 'TIMEOUT' | 'HTTP' | 'PARSE' | 'API',
    readonly code?: number
  ) {
    super(message);
    this.name = 'LighterPrivateError';
  }
}

/** No approved signer runtime: nothing can be signed (orders, cancels, auth tokens). */
export class LighterSignerUnavailable extends Error {
  constructor(reason = 'no Lighter signer is available') {
    super(`LIGHTER_SIGNER_UNAVAILABLE: ${reason}; signed orders and authenticated reads are unavailable.`);
    this.name = 'LighterSignerUnavailable';
  }
}

/* ───────────────────────── Signer port ───────────────────────── */

export interface LighterSignedTx {
  txType: number;
  /** Signed JSON. Sent once, never stored or logged. */
  txInfo: string;
  /** Computed by the signer before sending; lets an uncertain send be looked up. */
  txHash: string;
}

/** Signs for ONE account index + API key index (bound at construction). Never sends anything. */
export interface LighterSigner {
  /** The API key's public key (hex, no 0x), to compare with /api/v1/apikeys. */
  publicKey(): Promise<string>;
  createAuthToken(deadlineUnixSeconds: number): Promise<string>;
  signCreateGroupedOrders(g: { groupingType: number; orders: LighterOrderReq[] }, nonce: number): Promise<LighterSignedTx>;
  signCreateOrder(o: LighterOrderReq, nonce: number): Promise<LighterSignedTx>;
  /** Modify by client order index: size and trigger; the price bound is kept by the caller. */
  signModifyOrder(m: { marketIndex: number; index: number; baseAmount: string; price: string; triggerPrice: string }, nonce: number): Promise<LighterSignedTx>;
  signCancelOrder(m: { marketIndex: number; index: number }, nonce: number): Promise<LighterSignedTx>;
}

/** The production signer: refuses every call (no runtime approved). */
export const unavailableLighterSigner = (): LighterSigner => {
  const no = async (): Promise<never> => {
    throw new LighterSignerUnavailable();
  };
  return { publicKey: no, createAuthToken: no, signCreateGroupedOrders: no, signCreateOrder: no, signModifyOrder: no, signCancelOrder: no };
};

/* ───────────────────────── Normalized records ───────────────────────── */

export interface LighterAccountPosition {
  marketId: number;
  symbol: string;
  side: 'LONG' | 'SHORT' | null;
  /** Unsigned base size. */
  size: string;
  avgEntryPrice: string | null;
  liquidationPrice: string | null;
  unrealizedPnl: string | null;
  totalFundingPaidOut: string | null;
  marginMode: 'CROSS' | 'ISOLATED' | null;
  /** Leverage from initial_margin_fraction (percent; leverage = 100 / imf). Null when not reported. */
  leverage: number | null;
  allocatedMargin: string | null;
  openOrderCount: number;
  pendingOrderCount: number;
  positionTiedOrderCount: number;
}

export interface LighterAccountSnapshot {
  accountIndex: number;
  l1Address: string;
  accountType: number | null;
  /** Classic = 0, Unified = 1. */
  tradingMode: number | null;
  status: number | null;
  collateral: string;
  availableBalance: string;
  totalAssetValue: string | null;
  positions: LighterAccountPosition[];
  /** Transaction execution time (unix µs) of the snapshot, when reported. */
  transactionTimeUs: number | null;
}

export interface LighterOrder {
  orderIndex: string;
  clientOrderIndex: number;
  marketIndex: number;
  isAsk: boolean;
  type: string;
  reduceOnly: boolean;
  status: string;
  triggerStatus: string;
  initialBaseAmount: string;
  remainingBaseAmount: string;
  filledBaseAmount: string;
  filledQuoteAmount: string;
  price: string;
  triggerPrice: string;
  /** Unix ms (`order_expiry`); 0 for IOC. */
  orderExpiryMs: number;
  parentOrderIndex: string | null;
}

export interface LighterTrade {
  tradeId: string;
  /** Base size of this trade. */
  size: string;
  price: string;
  /** USDC fee paid by this account on this trade; null when the record does not establish it. */
  fee: string | null;
  timestampMs: number;
  /** Realized P&L for this account on this trade, as Lighter reports it (null if absent). */
  realizedPnl: string | null;
}

export interface LighterBook {
  bestBid: string | null;
  bestAsk: string | null;
}

/* ───────────────────────── API port (mocks implement it) ───────────────────────── */

export interface LighterApi {
  /** `GET /` and `GET /info`: which network and ZkLighter contract this API serves. */
  identity(): Promise<{ networkId: number; contractAddress: string }>;
  account(accountIndex: number): Promise<LighterAccountSnapshot | null>;
  /** Registered public key (hex, no 0x) of one API key index, or null when none is registered. */
  apiKeyPublicKey(accountIndex: number, apiKeyIndex: number): Promise<string | null>;
  nextNonce(accountIndex: number, apiKeyIndex: number): Promise<number>;
  /** Transaction status by hash; null when Lighter does not know the hash (yet). */
  txStatus(hash: string): Promise<number | null>;
  orderBook(marketId: number): Promise<LighterBook>;
  ordersByClientIndex(accountIndex: number, clientOrderIndexes: number[], authToken: string): Promise<LighterOrder[]>;
  tradesForOrder(accountIndex: number, orderIndex: string, authToken: string): Promise<LighterTrade[]>;
  /** Order-changing. Throws LighterPrivateError (API with its code, or TIMEOUT/NETWORK/HTTP). */
  sendTx(txType: number, txInfo: string): Promise<{ txHash: string | null }>;
}

/* ───────────────────────── Parsers ───────────────────────── */

const str = (v: unknown): string | null => (v === undefined || v === null || v === '' ? null : String(v));
const decOr0 = (v: unknown): string => {
  const s = str(v);
  return s && /^-?\d+(\.\d+)?$/.test(s) ? new Decimal(s).toFixed() : '0';
};
const optDec = (v: unknown): string | null => {
  const s = str(v);
  return s && /^-?\d+(\.\d+)?$/.test(s) ? new Decimal(s).toFixed() : null;
};
const optInt = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) ? v : typeof v === 'string' && /^-?\d+$/.test(v) ? Number(v) : null);

export function parseLighterAccount(body: unknown, accountIndex: number): LighterAccountSnapshot | null {
  const b = body as { code?: unknown; accounts?: unknown };
  if (!b || typeof b !== 'object') throw new LighterPrivateError('account: unexpected response', 'PARSE');
  if (b.code !== 200) throw new LighterPrivateError(`account: code ${String(b.code)}`, 'API', typeof b.code === 'number' ? b.code : undefined);
  const list = Array.isArray(b.accounts) ? (b.accounts as Record<string, unknown>[]) : [];
  const a = list.find((x) => optInt(x.index ?? x.account_index) === accountIndex);
  if (!a) return null;
  const positions: LighterAccountPosition[] = (Array.isArray(a.positions) ? (a.positions as Record<string, unknown>[]) : []).map((p) => {
    const size = new Decimal(decOr0(p.position)).abs();
    const sign = optInt(p.sign);
    const imf = optDec(p.initial_margin_fraction);
    const mm = optInt(p.margin_mode);
    return {
      marketId: optInt(p.market_id) ?? -1,
      symbol: String(p.symbol ?? ''),
      side: size.isZero() ? null : sign === 1 ? 'LONG' : sign === -1 ? 'SHORT' : null,
      size: size.toFixed(),
      avgEntryPrice: optDec(p.avg_entry_price),
      liquidationPrice: optDec(p.liquidation_price),
      unrealizedPnl: optDec(p.unrealized_pnl),
      totalFundingPaidOut: optDec(p.total_funding_paid_out),
      marginMode: mm === 0 ? 'CROSS' : mm === 1 ? 'ISOLATED' : null,
      // ASSUMPTION (unverified, capability LIGHTER_ACCOUNT_SETTINGS): the account record's
      // initial_margin_fraction is read as percent ("4.00" → 25x). The catalog's fractions are in
      // 1/10000; the account record's unit is not documented. Null unless an exact leverage results.
      leverage: imf && new Decimal(imf).gt(0) && new Decimal(100).div(imf).isInteger() ? new Decimal(100).div(imf).toNumber() : null,
      allocatedMargin: optDec(p.allocated_margin),
      openOrderCount: optInt(p.open_order_count) ?? 0,
      pendingOrderCount: optInt(p.pending_order_count) ?? 0,
      positionTiedOrderCount: optInt(p.position_tied_order_count) ?? 0
    };
  });
  return {
    accountIndex,
    l1Address: String(a.l1_address ?? ''),
    accountType: optInt(a.account_type),
    tradingMode: optInt(a.account_trading_mode),
    status: optInt(a.status),
    collateral: decOr0(a.collateral),
    availableBalance: decOr0(a.available_balance),
    totalAssetValue: optDec(a.total_asset_value),
    positions,
    transactionTimeUs: optInt(a.transaction_time)
  };
}

export function parseLighterOrders(body: unknown): LighterOrder[] {
  const b = body as { code?: unknown; orders?: unknown };
  if (!b || typeof b !== 'object' || b.code !== 200) throw new LighterPrivateError(`accountOrders: code ${String(b?.code)}`, 'API', typeof b?.code === 'number' ? b.code : undefined);
  return (Array.isArray(b.orders) ? (b.orders as Record<string, unknown>[]) : []).map((o) => ({
    orderIndex: String(o.order_index ?? o.order_id ?? ''),
    clientOrderIndex: optInt(o.client_order_index) ?? optInt(o.client_order_id) ?? 0,
    marketIndex: optInt(o.market_index) ?? -1,
    isAsk: o.is_ask === true || o.is_ask === 1,
    type: String(o.type ?? ''),
    reduceOnly: o.reduce_only === true || o.reduce_only === 1,
    status: String(o.status ?? ''),
    triggerStatus: String(o.trigger_status ?? 'na'),
    initialBaseAmount: decOr0(o.initial_base_amount),
    remainingBaseAmount: decOr0(o.remaining_base_amount),
    filledBaseAmount: decOr0(o.filled_base_amount),
    filledQuoteAmount: decOr0(o.filled_quote_amount),
    price: decOr0(o.price),
    triggerPrice: decOr0(o.trigger_price),
    orderExpiryMs: optInt(o.order_expiry) ?? 0,
    parentOrderIndex: str(o.parent_order_index ?? o.parent_order_id)
  }));
}

/* ───────────────────────── HTTP implementation ───────────────────────── */

const READ_PATHS = [/^\/$/, /^\/info$/, /^\/api\/v1\/account$/, /^\/api\/v1\/apikeys$/, /^\/api\/v1\/nextNonce$/, /^\/api\/v1\/tx$/, /^\/api\/v1\/orderBookOrders$/, /^\/api\/v1\/accountOrders$/, /^\/api\/v1\/trades$/];

/*
 * Lighter's mainnet ORDER submission is a deployment switch, off by default: LIGHTER_MAINNET_ORDERS
 * must be "enabled" (lighterMainnetOrdersEnabled, lighterLiveScope.ts). Reads stay available either
 * way. It is a kill switch for ALL Lighter orders (closes included); to stop only new entries, halt
 * entries instead.
 */

/** Configuration error for the Lighter testnet switch. */
export class LighterTestnetConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LighterTestnetConfigError';
  }
}

/**
 * LIGHTER_TESTNET: "" / "off" (default) or "enabled". "enabled" is accepted ONLY in an isolated
 * local test setup: never with NODE_ENV=production, and only when DATABASE_URL names a database
 * ending in `_test` or `_testnet`. Testnet never touches mainnet gates: it neither opens nor
 * requires LIVE_ORDER_TRANSPORT, and mainnet stays governed by LIGHTER_MAINNET_ORDERS.
 */
export function lighterTestnetEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const v = (env.LIGHTER_TESTNET ?? '').trim().toLowerCase();
  if (v === '' || v === 'off') return false;
  if (v !== 'enabled') throw new LighterTestnetConfigError(`LIGHTER_TESTNET must be "enabled" or "off" (got "${v}").`);
  if (env.NODE_ENV === 'production') throw new LighterTestnetConfigError('LIGHTER_TESTNET=enabled is refused in production.');
  let db = '';
  try {
    db = new URL(env.DATABASE_URL ?? '').pathname.replace(/^\//, '');
  } catch {
    db = '';
  }
  if (!/_(test|testnet)$/.test(db)) throw new LighterTestnetConfigError('LIGHTER_TESTNET=enabled needs an isolated local database (DATABASE_URL name ending in _test or _testnet).');
  return true;
}

/**
 * The Lighter order gate. MAINNET: the deployment transport (LIVE_ORDER_TRANSPORT) AND the Lighter
 * mainnet switch (LIGHTER_MAINNET_ORDERS, off by default). TESTNET: only the explicit isolated testnet setting; it can never grant mainnet.
 */
export function openLighterOrderTransport(environment: LighterEnvironment, env: Record<string, string | undefined> = process.env): { readonly granted: true } {
  if (environment === 'TESTNET') {
    if (!lighterTestnetEnabled(env)) throw new LiveOrderTransportRefused('Lighter testnet orders need LIGHTER_TESTNET=enabled in an isolated local test setup');
    return { granted: true };
  }
  const g = openLiveOrderTransport(env); // refuses unless LIVE_ORDER_TRANSPORT=enabled in production
  if (!lighterMainnetOrdersEnabled(env)) throw new LiveOrderTransportRefused('Lighter mainnet order submission is disabled on this deployment (LIGHTER_MAINNET_ORDERS is not enabled)');
  return g;
}

export class LighterHttpApi implements LighterApi {
  private readonly baseUrl: string;
  constructor(
    private readonly o: { environment: LighterEnvironment; baseUrl?: string; timeoutMs?: number; fetch?: typeof fetch; env?: Record<string, string | undefined> }
  ) {
    this.baseUrl = (o.baseUrl || LIGHTER_ENVIRONMENTS[o.environment].baseUrl).replace(/\/+$/, '');
  }

  private async get(path: string, query: Record<string, string>, authToken?: string): Promise<Record<string, unknown>> {
    if (!READ_PATHS.some((r) => r.test(path))) throw new LighterPrivateError(`Refusing GET ${path}: not an allowlisted read`, 'REFUSED');
    const url = new URL(this.baseUrl + path);
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
    let res: Response;
    try {
      res = await (this.o.fetch ?? fetch)(url, { method: 'GET', headers: { accept: 'application/json', ...(authToken ? { authorization: authToken } : {}) }, signal: AbortSignal.timeout(this.o.timeoutMs ?? 8_000) });
    } catch (e) {
      const n = (e as Error).name;
      throw new LighterPrivateError(`GET ${path}: ${n === 'TimeoutError' || n === 'AbortError' ? 'timed out' : 'network error'}`, n === 'TimeoutError' || n === 'AbortError' ? 'TIMEOUT' : 'NETWORK');
    }
    let body: Record<string, unknown>;
    try {
      body = (await res.json()) as Record<string, unknown>;
    } catch {
      throw new LighterPrivateError(`GET ${path}: HTTP ${res.status}, invalid JSON`, res.ok ? 'PARSE' : 'HTTP', res.status);
    }
    if (!res.ok && typeof body?.code !== 'number') throw new LighterPrivateError(`GET ${path}: HTTP ${res.status}`, 'HTTP', res.status);
    return body;
  }

  async identity() {
    const root = await this.get('/', {});
    const info = await this.get('/info', {});
    if (typeof root.network_id !== 'number' || typeof info.contract_address !== 'string') throw new LighterPrivateError('environment identity missing', 'PARSE');
    return { networkId: root.network_id, contractAddress: info.contract_address };
  }

  async account(accountIndex: number) {
    const b = await this.get('/api/v1/account', { by: 'index', value: String(accountIndex) });
    if (b.code !== 200 && /not found/i.test(String(b.message ?? ''))) return null;
    return parseLighterAccount(b, accountIndex);
  }

  async apiKeyPublicKey(accountIndex: number, apiKeyIndex: number) {
    const b = await this.get('/api/v1/apikeys', { account_index: String(accountIndex), api_key_index: String(apiKeyIndex) });
    if (b.code !== 200) throw new LighterPrivateError(`apikeys: code ${String(b.code)}`, 'API', typeof b.code === 'number' ? b.code : undefined);
    const k = (Array.isArray(b.api_keys) ? (b.api_keys as Record<string, unknown>[]) : []).find((x) => optInt(x.api_key_index) === apiKeyIndex);
    const pk = k ? String(k.public_key ?? '').replace(/^0x/i, '').toLowerCase() : '';
    return pk && !/^0+$/.test(pk) ? pk : null;
  }

  async nextNonce(accountIndex: number, apiKeyIndex: number) {
    const b = await this.get('/api/v1/nextNonce', { account_index: String(accountIndex), api_key_index: String(apiKeyIndex) });
    const n = optInt(b.nonce);
    if (b.code !== 200 || n === null) throw new LighterPrivateError(`nextNonce: code ${String(b.code)}`, 'API', typeof b.code === 'number' ? b.code : undefined);
    return n;
  }

  async txStatus(hash: string) {
    const b = await this.get('/api/v1/tx', { by: 'hash', value: hash });
    if (b.code !== 200) return null;
    return optInt(b.status);
  }

  async orderBook(marketId: number): Promise<LighterBook> {
    const b = await this.get('/api/v1/orderBookOrders', { market_id: String(marketId), limit: '1' });
    if (b.code !== 200) throw new LighterPrivateError(`orderBookOrders: code ${String(b.code)}`, 'API');
    const first = (k: string) => {
      const l = Array.isArray(b[k]) ? (b[k] as Record<string, unknown>[]) : [];
      return l.length ? optDec(l[0]!.price) : null;
    };
    return { bestBid: first('bids'), bestAsk: first('asks') };
  }

  async ordersByClientIndex(accountIndex: number, clientOrderIndexes: number[], authToken: string) {
    return parseLighterOrders(await this.get('/api/v1/accountOrders', { account_index: String(accountIndex), client_order_indexes: clientOrderIndexes.join(',') }, authToken));
  }

  async tradesForOrder(accountIndex: number, orderIndex: string, authToken: string): Promise<LighterTrade[]> {
    const b = await this.get('/api/v1/trades', { account_index: String(accountIndex), order_index: orderIndex, sort_by: 'timestamp', limit: '100' }, authToken);
    if (b.code !== 200) throw new LighterPrivateError(`trades: code ${String(b.code)}`, 'API');
    return (Array.isArray(b.trades) ? (b.trades as Record<string, unknown>[]) : []).map((t) => ({
      tradeId: String(t.trade_id_str ?? t.trade_id ?? ''),
      size: decOr0(t.size),
      price: decOr0(t.price),
      // The unit of taker_fee / maker_fee on a trade is not documented: not interpreted (null).
      // Verified on a pilot account before any fee is booked from this record (LIGHTER_FILL_FEES).
      fee: null,
      timestampMs: optInt(t.timestamp) ?? 0,
      realizedPnl: optDec(String(t.ask_id ?? '') === orderIndex ? t.ask_account_pnl : t.bid_account_pnl)
    }));
  }

  async sendTx(txType: number, txInfo: string) {
    openLighterOrderTransport(this.o.environment, this.o.env ?? process.env); // re-checked on every order-changing request
    let res: Response;
    try {
      res = await (this.o.fetch ?? fetch)(`${this.baseUrl}/api/v1/sendTx`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ tx_type: String(txType), tx_info: txInfo }),
        signal: AbortSignal.timeout(this.o.timeoutMs ?? 8_000)
      });
    } catch (e) {
      const n = (e as Error).name;
      throw new LighterPrivateError(`sendTx: ${n === 'TimeoutError' || n === 'AbortError' ? 'timed out' : 'network error'}`, n === 'TimeoutError' || n === 'AbortError' ? 'TIMEOUT' : 'NETWORK');
    }
    let b: Record<string, unknown>;
    try {
      b = (await res.json()) as Record<string, unknown>;
    } catch {
      throw new LighterPrivateError(`sendTx: HTTP ${res.status}, invalid JSON`, res.status >= 500 ? 'HTTP' : 'PARSE', res.status);
    }
    if (b.code !== 200) {
      if (typeof b.code === 'number' && b.code !== res.status) throw new LighterPrivateError(`sendTx: ${String(b.message ?? '').slice(0, 160)}`, 'API', b.code);
      throw new LighterPrivateError(`sendTx: HTTP ${res.status}`, 'HTTP', res.status);
    }
    return { txHash: str(b.tx_hash) };
  }
}
