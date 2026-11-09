import { createHmac } from 'node:crypto';
import { Decimal } from '@trendpilot/domain';

/**
 * MEXC Futures PRIVATE API client (Step 11, M4). Server-side only.
 *
 * Documented contract (https://www.mexc.com/api-docs/futures/integration-guide, read 2026-11-09):
 *  - Base URL https://api.mexc.com (domain change 2026-01-19).
 *  - Headers: ApiKey, Request-Time (ms, string), Signature, optional Recv-Window (≤ 60 s);
 *    POST adds Content-Type: application/json.
 *  - Signature = hex(HMAC-SHA256(secretKey, accessKey + Request-Time + parameterString)).
 *    GET/DELETE: business parameters sorted by name, joined `k=v&…`, nulls omitted.
 *    POST: the exact JSON body string (no sorting). No parameters: "".
 *  - Envelope: { success, code, data } / { success: false, code, message }.
 *
 * Two transports exist and neither is reachable from Paper, Demo, replay or CI:
 *  - READ_ONLY: GET on an allowlist of account/position/order *query* paths. Needs explicitly
 *    configured read-only credentials (ops:mexc-readonly-check).
 *  - ORDERS: POST order/cancel/stop paths. Construction calls `openLiveOrderTransport`, which
 *    refuses in this build (live activation is disabled until the Step 12 gate).
 * Credentials are never logged: errors carry the path and MEXC code only.
 */

export const MEXC_PRIVATE_DEFAULT_BASE_URL = 'https://api.mexc.com';

export interface MexcCredentials {
  apiKey: string;
  secretKey: string;
}

export class MexcPrivateError extends Error {
  constructor(
    message: string,
    readonly kind: 'NETWORK' | 'TIMEOUT' | 'HTTP' | 'API' | 'PARSE' | 'REFUSED',
    readonly code?: number
  ) {
    super(message);
    this.name = 'MexcPrivateError';
  }
  /** The request may have reached MEXC and been executed (outcome unknown). */
  get uncertain(): boolean {
    return this.kind === 'TIMEOUT' || this.kind === 'NETWORK' || (this.kind === 'HTTP' && (this.code ?? 0) >= 500) || (this.kind === 'API' && (this.code === 500 || this.code === 501));
  }
}

/* ───────────────────────── Signing (pure) ───────────────────────── */

/** GET/DELETE parameter string: names sorted, null/undefined omitted, values URL-encoded. */
export function getParamString(params: Record<string, string | number | boolean | null | undefined>): string {
  return Object.keys(params)
    .filter((k) => params[k] !== null && params[k] !== undefined)
    .sort()
    .map((k) => `${k}=${encodeURIComponent(String(params[k]))}`)
    .join('&');
}

export function signMexc(secretKey: string, apiKey: string, requestTime: string, paramString: string): string {
  return createHmac('sha256', secretKey).update(`${apiKey}${requestTime}${paramString}`).digest('hex');
}

export interface SignedRequest {
  method: 'GET' | 'POST';
  /** Path including the query string for GET. */
  url: string;
  headers: Record<string, string>;
  body?: string;
}

/** Builds a signed request. The secret never leaves this function. */
export function buildSignedRequest(
  creds: MexcCredentials,
  method: 'GET' | 'POST',
  path: string,
  params: Record<string, unknown> | unknown[] | null,
  requestTime: string,
  recvWindowSeconds?: number
): SignedRequest {
  let paramString = '';
  let url = path;
  let body: string | undefined;
  if (method === 'GET') {
    paramString = params && !Array.isArray(params) ? getParamString(params as Record<string, string | number | boolean | null | undefined>) : '';
    if (paramString) url = `${path}?${paramString}`;
  } else {
    body = params === null ? '' : JSON.stringify(params);
    paramString = body;
  }
  const headers: Record<string, string> = {
    ApiKey: creds.apiKey,
    'Request-Time': requestTime,
    Signature: signMexc(creds.secretKey, creds.apiKey, requestTime, paramString)
  };
  if (recvWindowSeconds) headers['Recv-Window'] = String(recvWindowSeconds);
  if (method === 'POST') headers['Content-Type'] = 'application/json';
  return { method, url, headers, body };
}

/** For logs and errors: never the key, secret or signature. */
export const redactHeaders = (h: Record<string, string>) => Object.fromEntries(Object.entries(h).map(([k, v]) => [k, /apikey|signature|authorization/i.test(k) ? '[redacted]' : v]));

/* ───────────────────────── Paths ───────────────────────── */

/** Read-only paths (GET). Account/position/order queries only. */
export const READ_ONLY_PATHS: RegExp[] = [
  /^\/api\/v1\/private\/account\/assets$/,
  /^\/api\/v1\/private\/position\/open_positions$/,
  /^\/api\/v1\/private\/position\/position_mode$/,
  /^\/api\/v1\/private\/position\/leverage$/,
  /^\/api\/v1\/private\/order\/external\/[A-Z0-9_]+\/[A-Za-z0-9_:.-]+$/,
  /^\/api\/v1\/private\/order\/get\/\d+$/,
  /^\/api\/v1\/private\/order\/deal_details\/\d+$/,
  /^\/api\/v1\/private\/stoporder\/open_orders$/,
  /^\/api\/v1\/private\/account\/risk_limit$/
];

/** Order-changing paths (POST). Reachable only through the ORDERS transport. */
export const ORDER_PATHS: RegExp[] = [/^\/api\/v1\/private\/order\/create$/, /^\/api\/v1\/private\/order\/cancel_with_external$/, /^\/api\/v1\/private\/stoporder\/place$/, /^\/api\/v1\/private\/stoporder\/cancel$/];

/* ───────────────────────── Live gate ───────────────────────── */

/**
 * Build-level switch. Live order activation is NOT part of this release: Step 12 must change this
 * deliberately (with its review), not an environment variable alone.
 */
export const LIVE_ACTIVATION_ALLOWED_IN_THIS_BUILD = false as boolean;

export class LiveOrderTransportRefused extends Error {
  constructor(reason: string) {
    super(`Private MEXC order transport refused: ${reason}`);
    this.name = 'LiveOrderTransportRefused';
  }
}

/**
 * The only way to obtain permission to send order-changing requests. Refuses in Paper, Demo,
 * replay, test and CI environments, and refuses everywhere in this build.
 */
export function openLiveOrderTransport(env: Record<string, string | undefined> = process.env): { readonly granted: true } {
  if (env.LIVE_ORDER_TRANSPORT !== 'enabled') throw new LiveOrderTransportRefused(`LIVE_ORDER_TRANSPORT is "${env.LIVE_ORDER_TRANSPORT ?? 'unset'}"`);
  if (env.SIGNAL_TEST_CLOCK || env.ALLOW_SIGNAL_TEST_CLOCK) throw new LiveOrderTransportRefused('a replay clock is configured');
  if (env.CI || env.VITEST || env.NODE_ENV === 'test') throw new LiveOrderTransportRefused('test or CI environment');
  if (env.TRENDPILOT_MODE !== 'LIVE') throw new LiveOrderTransportRefused('process mode is not LIVE (Paper and Demo never send orders)');
  if (!LIVE_ACTIVATION_ALLOWED_IN_THIS_BUILD) throw new LiveOrderTransportRefused('live activation is disabled in this build (Step 12 gate)');
  return { granted: true };
}

/* ───────────────────────── Transport ───────────────────────── */

/** What the adapter needs: one signed call returning the envelope's `data`. Mocks implement it. */
export interface MexcRequester {
  request<T = unknown>(method: 'GET' | 'POST', path: string, params?: Record<string, unknown> | unknown[] | null): Promise<T>;
}

export function unwrapEnvelope<T>(body: unknown, path: string): T {
  const e = body as { success?: boolean; code?: number; message?: string; data?: unknown };
  if (!e || typeof e !== 'object') throw new MexcPrivateError(`${path}: unexpected response`, 'PARSE');
  if (e.success !== true || e.code !== 0) throw new MexcPrivateError(`${path}: ${e.message ?? 'request failed'} (code ${e.code})`, 'API', e.code);
  return e.data as T;
}

export interface MexcHttpOptions {
  mode: 'READ_ONLY' | 'ORDERS';
  credentials: MexcCredentials;
  baseUrl?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
  now?: () => number;
  env?: Record<string, string | undefined>;
}

/** Real HTTP transport. READ_ONLY refuses anything but allowlisted GETs before sending. */
export class MexcHttpTransport implements MexcRequester {
  private readonly o: Required<Omit<MexcHttpOptions, 'env'>>;
  constructor(o: MexcHttpOptions) {
    if (o.mode === 'ORDERS') openLiveOrderTransport(o.env ?? process.env);
    if (!o.credentials.apiKey || !o.credentials.secretKey) throw new MexcPrivateError('MEXC credentials are not configured', 'REFUSED');
    this.o = { baseUrl: MEXC_PRIVATE_DEFAULT_BASE_URL, timeoutMs: 8_000, fetch, now: Date.now, ...o } as Required<Omit<MexcHttpOptions, 'env'>>;
  }

  async request<T>(method: 'GET' | 'POST', path: string, params: Record<string, unknown> | unknown[] | null = null): Promise<T> {
    const readOnly = method === 'GET' && READ_ONLY_PATHS.some((r) => r.test(path));
    const order = method === 'POST' && ORDER_PATHS.some((r) => r.test(path));
    if (this.o.mode === 'READ_ONLY' && !readOnly) throw new MexcPrivateError(`Refusing ${method} ${path} on the read-only transport`, 'REFUSED');
    if (!readOnly && !order) throw new MexcPrivateError(`Refusing ${method} ${path}: not an allowlisted endpoint`, 'REFUSED');
    const req = buildSignedRequest(this.o.credentials, method, path, params, String(this.o.now()), 10);
    let res: Response;
    try {
      res = await this.o.fetch(`${this.o.baseUrl.replace(/\/+$/, '')}${req.url}`, { method, headers: req.headers, body: req.body, signal: AbortSignal.timeout(this.o.timeoutMs) });
    } catch (e) {
      const name = (e as Error).name;
      throw new MexcPrivateError(`${method} ${path}: ${name === 'TimeoutError' || name === 'AbortError' ? 'timed out' : 'network error'}`, name === 'TimeoutError' || name === 'AbortError' ? 'TIMEOUT' : 'NETWORK');
    }
    if (!res.ok) throw new MexcPrivateError(`${method} ${path}: HTTP ${res.status}`, 'HTTP', res.status);
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      throw new MexcPrivateError(`${method} ${path}: invalid JSON`, 'PARSE');
    }
    return unwrapEnvelope<T>(body, path);
  }
}

/* ───────────────────────── Normalization ───────────────────────── */

const dec = (v: unknown): string => {
  if (v === null || v === undefined || v === '') return '0';
  return new Decimal(v as Decimal.Value).toFixed();
};

export type MexcSide = 1 | 2 | 3 | 4; // 1 open long, 2 close short, 3 open short, 4 close long
export const TREND = { LAST: 1, MARK: 2, INDEX: 3 } as const;
export const trendToBasis = (t: number) => (t === 2 ? 'MARK' : t === 3 ? 'INDEX' : 'LAST');

export interface NormalizedBalance {
  currency: string;
  equity: string;
  available: string;
  availableOpen: string;
  positionMargin: string;
  frozen: string;
  unrealized: string;
  bonus: string;
}
export const normalizeAssets = (data: unknown): NormalizedBalance[] =>
  (Array.isArray(data) ? data : []).map((a: Record<string, unknown>) => ({
    currency: String(a.currency),
    equity: dec(a.equity),
    available: dec(a.availableBalance),
    availableOpen: dec(a.availableOpen),
    positionMargin: dec(a.positionMargin),
    frozen: dec(a.frozenBalance),
    unrealized: dec(a.unrealized),
    bonus: dec(a.bonus)
  }));

export interface NormalizedPosition {
  positionId: string;
  symbol: string;
  side: 'LONG' | 'SHORT';
  contracts: string;
  frozen: string;
  avgEntryPrice: string;
  liquidationPrice: string | null;
  leverage: number;
  marginMode: 'ISOLATED' | 'CROSS';
  margin: string;
  realized: string;
  fundingFee: string;
  open: boolean;
}
export const normalizePositions = (data: unknown): NormalizedPosition[] =>
  (Array.isArray(data) ? data : []).map((p: Record<string, unknown>) => ({
    positionId: String(p.positionId),
    symbol: String(p.symbol),
    side: p.positionType === 2 ? 'SHORT' : 'LONG',
    contracts: dec(p.holdVol),
    frozen: dec(p.frozenVol),
    avgEntryPrice: dec(p.holdAvgPriceFullyScale ?? p.holdAvgPrice),
    liquidationPrice: p.liquidatePrice === null || p.liquidatePrice === undefined || Number(p.liquidatePrice) === 0 ? null : dec(p.liquidatePrice),
    leverage: Number(p.leverage),
    marginMode: p.openType === 2 ? 'CROSS' : 'ISOLATED',
    margin: dec(p.im),
    realized: dec(p.realised),
    fundingFee: dec(p.holdFee),
    open: p.state === 1 || p.state === 2
  }));

export type MexcOrderState = 'PENDING' | 'OPEN' | 'FILLED' | 'CANCELLED' | 'INVALID';
const ORDER_STATE: Record<number, MexcOrderState> = { 1: 'PENDING', 2: 'OPEN', 3: 'FILLED', 4: 'CANCELLED', 5: 'INVALID' };

export interface NormalizedOrder {
  orderId: string;
  externalOid: string | null;
  symbol: string;
  side: MexcSide;
  vol: string;
  dealVol: string;
  dealAvgPrice: string;
  state: MexcOrderState;
  takerFee: string;
  makerFee: string;
  errorCode: number;
  updateTime: number;
}
export function normalizeOrder(o: Record<string, unknown>): NormalizedOrder {
  const state = ORDER_STATE[Number(o.state)];
  if (!state) throw new MexcPrivateError(`order ${String(o.orderId)}: unknown state ${String(o.state)}`, 'PARSE');
  return {
    orderId: String(o.orderId),
    externalOid: o.externalOid ? String(o.externalOid) : null,
    symbol: String(o.symbol),
    side: Number(o.side) as MexcSide,
    vol: dec(o.vol),
    dealVol: dec(o.dealVol),
    dealAvgPrice: dec(o.dealAvgPrice),
    state,
    takerFee: dec(o.takerFee),
    makerFee: dec(o.makerFee),
    errorCode: Number(o.errorCode ?? 0),
    updateTime: Number(o.updateTime ?? o.createTime ?? 0)
  };
}

export interface NormalizedDeal {
  dealId: string;
  orderId: string;
  vol: string;
  price: string;
  /** Positive = paid by the user (MEXC convention). */
  fee: string;
  timestamp: number;
}
/** Deals for an order, de-duplicated by deal ID (a re-delivered or repeated deal counts once). */
export function normalizeDeals(data: unknown): NormalizedDeal[] {
  const seen = new Map<string, NormalizedDeal>();
  for (const d of (Array.isArray(data) ? data : []) as Record<string, unknown>[]) {
    const id = String(d.id);
    if (seen.has(id)) continue;
    seen.set(id, { dealId: id, orderId: String(d.orderId), vol: dec(d.vol), price: dec(d.price), fee: dec(d.fee), timestamp: Number(d.timestamp) });
  }
  return [...seen.values()].sort((a, b) => a.timestamp - b.timestamp || a.dealId.localeCompare(b.dealId));
}

export type StopState = 'ACTIVE' | 'CANCELLED' | 'TRIGGERED' | 'INVALID' | 'FAILED';
const STOP_STATE: Record<number, StopState> = { 1: 'ACTIVE', 2: 'CANCELLED', 3: 'TRIGGERED', 4: 'INVALID', 5: 'FAILED' };

export interface NormalizedStop {
  stopId: string;
  orderId: string;
  positionId: string;
  symbol: string;
  positionSide: 'LONG' | 'SHORT';
  stopLossPrice: string | null;
  basis: string;
  vol: string;
  state: StopState;
  errorCode: number;
}
export const normalizeStops = (data: unknown): NormalizedStop[] =>
  (Array.isArray(data) ? data : []).map((s: Record<string, unknown>) => ({
    stopId: String(s.id),
    orderId: String(s.orderId ?? '0'),
    positionId: String(s.positionId),
    symbol: String(s.symbol),
    positionSide: s.positionType === 2 ? 'SHORT' : 'LONG',
    stopLossPrice: s.stopLossPrice === null || s.stopLossPrice === undefined || Number(s.stopLossPrice) === 0 ? null : dec(s.stopLossPrice),
    basis: trendToBasis(Number(s.lossTrend ?? 1)),
    vol: dec(s.vol),
    state: STOP_STATE[Number(s.state)] ?? 'INVALID',
    errorCode: Number(s.errorCode ?? 0)
  }));
