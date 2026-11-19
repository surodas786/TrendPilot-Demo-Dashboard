import { createHash, randomBytes } from 'node:crypto';
import { Decimal } from '@trendpilot/domain';

/**
 * Bitunix Futures PRIVATE API client (Step 1: read-only connectivity). Server-side only.
 *
 * Documented contract (https://www.bitunix.com/api-docs/futures/common/sign.html, read 2026-11-16):
 *  - Base URL https://fapi.bitunix.com, paths under /api/v1/futures/.
 *  - Headers: api-key, nonce (random string, < 64 chars), timestamp (Unix ms, within 60 000 ms of
 *    the server), sign; plus Content-Type: application/json and language: en-US.
 *  - queryParams = every query parameter sorted by key in ascending ASCII order, each written as
 *    key + value with NO separators ("id1uid200"); "" when there are none.
 *  - body = the exact request-body string ("remove all spaces"; the bytes sent must equal the bytes
 *    signed); "" for GET.
 *  - digest = hex(SHA256(nonce + timestamp + api-key + queryParams + body))
 *    sign   = hex(SHA256(digest + secretKey))
 *  - Envelope: { code, msg, data }; code 0 = success. Bitunix answers API errors with HTTP 200 and a
 *    non-zero code, so an HTTP failure and an API error code are reported as different kinds.
 *
 * This step ships ONLY a read-only transport: GET on an allowlist of account queries. There is no
 * order path, no position-mode change and no leverage change in this file; any other request is
 * refused before anything is signed or sent. Credentials never reach a log or an error: errors
 * carry the method, path and Bitunix code only.
 */

export const BITUNIX_PRIVATE_DEFAULT_BASE_URL = 'https://fapi.bitunix.com';

export interface BitunixCredentials {
  apiKey: string;
  secretKey: string;
}

/** INCOMPLETE: a list could not be read in full (page cap), so it must not be treated as the whole account. */
export type BitunixErrorKind = 'NETWORK' | 'TIMEOUT' | 'HTTP' | 'API' | 'PARSE' | 'REFUSED' | 'INCOMPLETE';

export class BitunixPrivateError extends Error {
  constructor(
    message: string,
    readonly kind: BitunixErrorKind,
    /** HTTP status for kind HTTP; the Bitunix `code` for kind API. */
    readonly code?: number
  ) {
    super(message);
    this.name = 'BitunixPrivateError';
  }
  /** Rate limited: Bitunix 10005 / 10006, or HTTP 429. */
  get rateLimited(): boolean {
    return (this.kind === 'API' && (this.code === 10005 || this.code === 10006)) || (this.kind === 'HTTP' && this.code === 429);
  }
  /** Worth retrying a READ: rate limit, network, timeout, HTTP 5xx, Bitunix 10001 (network error). */
  get transient(): boolean {
    return this.rateLimited || this.kind === 'NETWORK' || this.kind === 'TIMEOUT' || (this.kind === 'HTTP' && (this.code ?? 0) >= 500) || (this.kind === 'API' && this.code === 10001);
  }
}

/** Official error codes that matter for the read-only check (error_code.html). */
export const BITUNIX_ERROR_TEXT: Record<number, string> = {
  403: 'This API key does not support this operation (permission).',
  10001: 'Bitunix network error.',
  10002: 'Parameter error.',
  10003: 'The API key is empty.',
  10004: 'This server’s IP address is not on the API key’s IP whitelist.',
  10005: 'Too many requests (rate limited).',
  10006: 'Requests too frequent (rate limited).',
  10007: 'Signature rejected: check the API key and secret.',
  10010: 'Nonce too long.',
  10011: 'Request timestamp is more than 60 s from Bitunix server time (check the server clock).',
  20011: 'Account not allowed to trade.',
  30040: 'Futures trading is prohibited for this account.'
};

/* ───────────────────────── Signing (pure) ───────────────────────── */

export type QueryValue = string | number | boolean | null | undefined;

/** queryParams for the signature: keys sorted by ASCII, `key + value`, no separators, nulls omitted. */
export function bitunixQueryParamString(params: Record<string, QueryValue>): string {
  return Object.keys(params)
    .filter((k) => params[k] !== null && params[k] !== undefined)
    .sort()
    .map((k) => `${k}${String(params[k])}`)
    .join('');
}

/** The URL query string: same keys and order as the signature, URL-encoded with `=` and `&`. */
export function bitunixQueryString(params: Record<string, QueryValue>): string {
  return Object.keys(params)
    .filter((k) => params[k] !== null && params[k] !== undefined)
    .sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(String(params[k]))}`)
    .join('&');
}

const sha256Hex = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

/** sign = SHA256(SHA256(nonce + timestamp + apiKey + queryParams + body) + secretKey), lowercase hex. */
export function signBitunix(i: { nonce: string; timestamp: string; apiKey: string; secretKey: string; queryParams: string; body: string }): string {
  const digest = sha256Hex(i.nonce + i.timestamp + i.apiKey + i.queryParams + i.body);
  return sha256Hex(digest + i.secretKey);
}

/** 32 random hex characters (Bitunix: a random string shorter than 64 characters). */
export const bitunixNonce = (): string => randomBytes(16).toString('hex');

export interface BitunixSignedRequest {
  method: 'GET' | 'POST';
  /** Path plus the URL query string. */
  url: string;
  headers: Record<string, string>;
  /** The exact body bytes that were signed (POST only). */
  body?: string;
}

/**
 * Builds a signed request. The secret never leaves this function. For POST the body is serialised
 * once with JSON.stringify (no whitespace) and that same string is both signed and sent.
 */
export function buildBitunixSignedRequest(
  creds: BitunixCredentials,
  method: 'GET' | 'POST',
  path: string,
  params: Record<string, QueryValue> | null,
  o: { timestampMs: number; nonce: string; body?: unknown }
): BitunixSignedRequest {
  const query = params ?? {};
  const qs = bitunixQueryString(query);
  const body = method === 'POST' ? (o.body === undefined ? '' : JSON.stringify(o.body)) : '';
  const timestamp = String(o.timestampMs);
  const headers: Record<string, string> = {
    'api-key': creds.apiKey,
    nonce: o.nonce,
    timestamp,
    sign: signBitunix({ nonce: o.nonce, timestamp, apiKey: creds.apiKey, secretKey: creds.secretKey, queryParams: bitunixQueryParamString(query), body }),
    language: 'en-US',
    'Content-Type': 'application/json'
  };
  return { method, url: qs ? `${path}?${qs}` : path, headers, ...(method === 'POST' ? { body } : {}) };
}

/** For logs and errors: never the key, nonce or signature. */
export const redactBitunixHeaders = (h: Record<string, string>) => Object.fromEntries(Object.entries(h).map(([k, v]) => [k, /api-?key|sign|nonce|secret|authorization/i.test(k) ? '[redacted]' : v]));

/* ───────────────────────── Paths ───────────────────────── */

/**
 * The only private paths reachable (GET): account, position, order, fill and TP/SL QUERIES. No
 * order, cancel, TP/SL placement, position-mode or leverage path is here, so none can be sent.
 */
export const BITUNIX_READ_ONLY_PATHS: RegExp[] = [
  /^\/api\/v1\/futures\/account$/,
  /^\/api\/v1\/futures\/account\/position_mode$/,
  // Leverage and margin mode per symbol, read before every Live entry (checkTradingSettings). Missing
  // here until 19 Nov 2026: with the transport's clock bug fixed, every Bitunix entry would have been
  // refused at this read, before transmission. Verified on production: HTTP 200, code 0.
  /^\/api\/v1\/futures\/account\/trading_settings$/,
  /^\/api\/v1\/futures\/position\/get_pending_positions$/,
  /^\/api\/v1\/futures\/position\/get_history_positions$/,
  /^\/api\/v1\/futures\/trade\/get_pending_orders$/,
  /^\/api\/v1\/futures\/trade\/get_history_orders$/,
  /^\/api\/v1\/futures\/trade\/get_history_trades$/,
  /^\/api\/v1\/futures\/trade\/get_order_detail$/,
  /^\/api\/v1\/futures\/tpsl\/get_pending_orders$/,
  /^\/api\/v1\/futures\/tpsl\/get_history_orders$/
];

/** Bitunix private REST: 10 requests per second per UID; requests are spaced a little wider. */
export const BITUNIX_MIN_REQUEST_INTERVAL_MS = 110;

/* ───────────────────────── Transport ───────────────────────── */

/** What the connection check needs: one signed GET returning the envelope's `data`. Mocks implement it. */
export interface BitunixRequester {
  get<T = unknown>(path: string, params?: Record<string, QueryValue>): Promise<T>;
}

/** { code: 0, data } → data. Any other code → BitunixPrivateError(API, code). */
export function unwrapBitunixEnvelope<T>(body: unknown, what: string): T {
  const e = body as { code?: unknown; msg?: unknown; data?: unknown };
  if (!e || typeof e !== 'object' || Array.isArray(e) || typeof e.code !== 'number') throw new BitunixPrivateError(`${what}: unexpected response`, 'PARSE');
  if (e.code !== 0) {
    const known = BITUNIX_ERROR_TEXT[e.code];
    const msg = typeof e.msg === 'string' && e.msg ? e.msg.slice(0, 160) : 'request failed';
    throw new BitunixPrivateError(`${what}: ${msg} (code ${e.code})${known ? ` — ${known}` : ''}`, 'API', e.code);
  }
  return e.data as T;
}

export interface BitunixHttpOptions {
  credentials: BitunixCredentials;
  baseUrl?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
  now?: () => number;
  nonce?: () => string;
  /** Spacing between requests (rate limit 10/s per UID). */
  minIntervalMs?: number;
  /** Retries of a READ after a transient failure (rate limit, network, timeout, 5xx). */
  retries?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Receives method, URL and REDACTED headers of every request (diagnostics). */
  onRequest?: (r: { method: string; url: string; headers: Record<string, string> }) => void;
}

/**
 * Real HTTP transport, read-only: allowlisted GETs only. Requests are spaced under the rate limit,
 * and a READ that fails transiently is retried with exponential backoff (safe: a query changes
 * nothing). A Bitunix refusal (signature, permission, IP whitelist, parameter) is never retried.
 */
export class BitunixReadOnlyTransport implements BitunixRequester {
  /** The key's own account tag in `subAccountId` (resolveBitunixAccountTag), when established. */
  accountTag: string | null = null;
  private readonly o: Required<Omit<BitunixHttpOptions, 'onRequest'>> & Pick<BitunixHttpOptions, 'onRequest'>;
  private nextAt = 0;
  constructor(o: BitunixHttpOptions) {
    if (!o.credentials?.apiKey || !o.credentials?.secretKey) throw new BitunixPrivateError('Bitunix credentials are not configured', 'REFUSED');
    this.o = {
      baseUrl: BITUNIX_PRIVATE_DEFAULT_BASE_URL,
      timeoutMs: 8_000,
      fetch,
      now: Date.now,
      nonce: bitunixNonce,
      minIntervalMs: BITUNIX_MIN_REQUEST_INTERVAL_MS,
      retries: 2,
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      // An option passed as `undefined` keeps its default (19 Nov 2026: the order transport passed
      // `now: undefined` through, every signed read threw "this.o.now is not a function" and the
      // XAUUSDT entry e6d08d8e… never left TrendPilot).
      ...(Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as BitunixHttpOptions)
    };
  }

  /** The only method: there is no write path on this transport. */
  async get<T>(path: string, params: Record<string, QueryValue> = {}): Promise<T> {
    if (!BITUNIX_READ_ONLY_PATHS.some((r) => r.test(path))) throw new BitunixPrivateError(`Refusing GET ${path}: not an allowlisted read-only endpoint`, 'REFUSED');
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.once<T>(path, params);
      } catch (e) {
        if (!(e instanceof BitunixPrivateError) || !e.transient || attempt >= this.o.retries) throw e;
        await this.o.sleep((e.rateLimited ? 1_000 : 500) * 2 ** attempt);
      }
    }
  }

  private async once<T>(path: string, params: Record<string, QueryValue>): Promise<T> {
    const wait = this.nextAt - this.o.now();
    if (wait > 0) await this.o.sleep(wait);
    this.nextAt = this.o.now() + this.o.minIntervalMs;
    const req = buildBitunixSignedRequest(this.o.credentials, 'GET', path, params, { timestampMs: this.o.now(), nonce: this.o.nonce() });
    this.o.onRequest?.({ method: 'GET', url: req.url, headers: redactBitunixHeaders(req.headers) });
    let res: Response;
    try {
      res = await this.o.fetch(`${this.o.baseUrl.replace(/\/+$/, '')}${req.url}`, { method: 'GET', headers: req.headers, signal: AbortSignal.timeout(this.o.timeoutMs) });
    } catch (e) {
      const name = (e as Error).name;
      const timeout = name === 'TimeoutError' || name === 'AbortError';
      throw new BitunixPrivateError(`GET ${path}: ${timeout ? 'timed out' : 'network error'}`, timeout ? 'TIMEOUT' : 'NETWORK');
    }
    if (!res.ok) throw new BitunixPrivateError(`GET ${path}: HTTP ${res.status}`, 'HTTP', res.status);
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      throw new BitunixPrivateError(`GET ${path}: invalid JSON`, 'PARSE');
    }
    return unwrapBitunixEnvelope<T>(body, `GET ${path}`);
  }
}

/* ───────────────────────── Normalization ───────────────────────── */

export type BitunixPositionMode = 'ONE_WAY' | 'HEDGE';

/**
 * `GET /api/v1/futures/account/position_mode` data → mode. Accepts the documented
 * `{ positionMode: "ONE_WAY" | "HEDGE" }` (case-insensitive). Anything else → PARSE error that
 * names what Bitunix sent, so the check reports it instead of guessing.
 */
export function parseBitunixPositionMode(data: unknown): { mode: BitunixPositionMode; raw: string } {
  const raw = data && typeof data === 'object' && !Array.isArray(data) ? (data as Record<string, unknown>).positionMode : undefined;
  const s = typeof raw === 'string' ? raw.trim().toUpperCase() : '';
  if (s === 'ONE_WAY' || s === 'HEDGE') return { mode: s, raw: String(raw) };
  throw new BitunixPrivateError(`position_mode: unknown position mode ${JSON.stringify(raw ?? null)}`, 'PARSE');
}

export interface BitunixAccount {
  marginCoin: string;
  /** Available balance (Bitunix: + crossUnrealizedPNL = maximum open amount). */
  available: string;
  /** Locked by open orders. */
  frozen: string;
  /** Locked by positions. */
  margin: string;
  transfer: string;
  positionMode: BitunixPositionMode | null;
  crossUnrealizedPNL: string;
  isolationUnrealizedPNL: string;
  bonus: string;
}

const dec = (v: unknown, field: string): string => {
  if (v === null || v === undefined || v === '') return '0';
  try {
    const d = new Decimal(v as Decimal.Value);
    if (!d.isFinite()) throw new Error('not finite');
    return d.toFixed();
  } catch {
    throw new BitunixPrivateError(`account: ${field} is not a number`, 'PARSE');
  }
};

/**
 * `GET /api/v1/futures/account?marginCoin=USDT` data → the account for that coin. The documented
 * example returns an ARRAY; an object is accepted too. Null when the coin is absent.
 */
export function parseBitunixAccount(data: unknown, marginCoin = 'USDT'): BitunixAccount | null {
  const rows = Array.isArray(data) ? data : data && typeof data === 'object' ? [data] : [];
  const a = (rows as Record<string, unknown>[]).find((r) => r && typeof r === 'object' && String(r.marginCoin ?? '').toUpperCase() === marginCoin);
  if (!a) return null;
  const mode = typeof a.positionMode === 'string' ? a.positionMode.toUpperCase() : null;
  return {
    marginCoin,
    available: dec(a.available, 'available'),
    frozen: dec(a.frozen, 'frozen'),
    margin: dec(a.margin, 'margin'),
    transfer: dec(a.transfer, 'transfer'),
    positionMode: mode === 'ONE_WAY' || mode === 'HEDGE' ? mode : null,
    crossUnrealizedPNL: dec(a.crossUnrealizedPNL, 'crossUnrealizedPNL'),
    isolationUnrealizedPNL: dec(a.isolationUnrealizedPNL, 'isolationUnrealizedPNL'),
    bonus: dec(a.bonus, 'bonus')
  };
}

/** Equity as TrendPilot shows it: available + frozen + margin + unrealized (cross and isolated). */
export const bitunixEquity = (a: BitunixAccount): string =>
  new Decimal(a.available).plus(a.frozen).plus(a.margin).plus(a.crossUnrealizedPNL).plus(a.isolationUnrealizedPNL).toFixed();

export interface BitunixReadOnlyCheck {
  checkedAt: string;
  signedRequests: 'OK';
  /** What Bitunix reports, verbatim mode. */
  positionMode: BitunixPositionMode;
  positionModeRaw: string;
  positionModeNote: string;
  usdt: { available: string; frozen: string; margin: string; unrealized: string; equity: string; bonus: string } | null;
  /** The account endpoint's own positionMode, when it disagrees with position_mode. */
  accountPositionMode: BitunixPositionMode | null;
}

/**
 * The read-only connection check: position mode, then the USDT futures account. Two signed GETs,
 * nothing else; it never changes the position mode (that is an explicit account action).
 */
export async function bitunixReadOnlyCheck(r: BitunixRequester, now: () => Date = () => new Date()): Promise<BitunixReadOnlyCheck> {
  const pm = parseBitunixPositionMode(await r.get('/api/v1/futures/account/position_mode'));
  const acct = parseBitunixAccount(await r.get('/api/v1/futures/account', { marginCoin: 'USDT' }), 'USDT');
  return {
    checkedAt: now().toISOString(),
    signedRequests: 'OK',
    positionMode: pm.mode,
    positionModeRaw: pm.raw,
    positionModeNote:
      pm.mode === 'ONE_WAY'
        ? 'Bitunix reports One-way mode (one net position per contract).'
        : 'Bitunix reports Hedge mode (separate Long and Short positions per contract).',
    usdt: acct
      ? {
          available: acct.available,
          frozen: acct.frozen,
          margin: acct.margin,
          unrealized: new Decimal(acct.crossUnrealizedPNL).plus(acct.isolationUnrealizedPNL).toFixed(),
          equity: bitunixEquity(acct),
          bonus: acct.bonus
        }
      : null,
    accountPositionMode: acct?.positionMode && acct.positionMode !== pm.mode ? acct.positionMode : null
  };
}
