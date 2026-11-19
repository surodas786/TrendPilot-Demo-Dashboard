import { Decimal } from '@trendpilot/domain';
import type { CloseResult, OpeningRequest, SimResult, VenueDiagnostics } from '../paper/simulator';
import type { CloseRequest, ExecutionVenue, ProtectionState } from '../venue/types';
import { normalizeBitunixOrder, readHistoryTrades, readPendingPositions, readPendingTpsl, type BitunixOrder, type BitunixPosition, type BitunixTpsl } from './bitunixAccount';
import {
  BITUNIX_PRIVATE_DEFAULT_BASE_URL,
  BitunixPrivateError,
  BitunixReadOnlyTransport,
  bitunixNonce,
  buildBitunixSignedRequest,
  parseBitunixAccount,
  parseBitunixPositionMode,
  unwrapBitunixEnvelope,
  type BitunixCredentials,
  type BitunixRequester,
  type QueryValue
} from './bitunixPrivate';
import { livePilotVerified, type CapabilityState } from './capabilities';
import { openLiveOrderTransport } from './mexcPrivate';
import { UncertainSubmissionError } from './mexcVenue';

/**
 * Bitunix Futures ORDER path (Step 3): Hedge-mode market orders with the stop loss in the entry
 * request, closes bound to the leg's Bitunix positionId, and outcome reconciliation by client ID.
 *
 * Documented contract (trade/place_order, trade/get_order_detail, account/position_mode,
 * account/trading_settings; read 2026-11-16):
 *   POST /api/v1/futures/trade/place_order {symbol, qty (base coin), side BUY|SELL, tradeSide
 *   OPEN|CLOSE (hedge mode), positionId (CLOSE), orderType MARKET, clientId, slPrice, slStopType
 *   MARK_PRICE|LAST_PRICE, slOrderType MARKET} → {orderId, clientId}. Error 30042 = client ID
 *   duplicate. The page's own mapping, followed exactly:
 *     open long  = BUY  + OPEN          open short  = SELL + OPEN
 *     close long = BUY  + CLOSE + id    close short = SELL + CLOSE + id
 *   (The same page calls `side` the "order direction"; the CLOSE rows contradict that reading. The
 *   mapping above is the documented one; it is a live-pilot capability, never assumed verified.)
 *
 * Safety rules (mirroring the MEXC adapter):
 *  - Orders need the BITUNIX_* capabilities recorded as verified; otherwise nothing is sent.
 *  - The account must be in HEDGE mode, read from Bitunix right before every order; anything else
 *    is refused (POSITION_MODE_MISMATCH:<mode>) and never "fixed" by TrendPilot.
 *  - Margin mode and the leg's leverage are read (trading_settings) and must equal the order's;
 *    TrendPilot never changes account-wide settings.
 *  - Quantity is rounded DOWN to the contract step and checked against the minimum opening
 *    quantity, maximum market quantity and the available margin before sending.
 *  - A close re-reads the leg: it must be the same positionId and side, and is capped at what the
 *    leg holds. One close per scope is enforced upstream (one unresolved intent per account and
 *    contract), so a manual close and a stop exit cannot both submit against the same quantity.
 *  - After a timeout, network error, 5xx or duplicate client ID, the order is only LOOKED UP by its
 *    client ID; it is never resent blind. An order still unknown stays pending (UncertainSubmission).
 *  - Fills come from Bitunix's trade history for the order; protection from the pending TP/SL list
 *    for the leg. Neither an acknowledgement nor a TP/SL trigger marks a position closed.
 */

export const BITUNIX_PLACE_ORDER_PATH = '/api/v1/futures/trade/place_order';
/** The only order-changing path the order transport may call. */
export const BITUNIX_ORDER_PATHS: RegExp[] = [/^\/api\/v1\/futures\/trade\/place_order$/, /^\/api\/v1\/futures\/tpsl\/modify_order$/];
/** Fixed-quantity TP/SL resize after a partial close (documented: modify by TP/SL orderId). */
export const BITUNIX_TPSL_MODIFY_PATH = '/api/v1/futures/tpsl/modify_order';

export type BitunixCapabilityId = 'BITUNIX_OPEN_WITH_ATTACHED_STOP' | 'BITUNIX_HEDGE_CLOSE_BY_POSITION' | 'BITUNIX_TPSL_RESIZE';

const D = (v: Decimal.Value) => new Decimal(v);
const num = (v: Decimal.Value) => new Decimal(v).toFixed();
const MISSING_STOP = 'bitunix-tpsl:missing';
const stopRef = (id: string) => `bitunix-tpsl:${id}`;
const stopIdOf = (ref: string) => ref.replace(/^bitunix-tpsl:/, '');

/* ───────────────────────── Order transport ───────────────────────── */

export interface BitunixOrderRequester extends BitunixRequester {
  post<T = unknown>(path: string, body: Record<string, unknown>): Promise<T>;
}

/**
 * Signed transport for ONE order path (place_order) plus the read allowlist. Construction and
 * every POST require the live order transport (LIVE_ORDER_TRANSPORT=enabled in production), the
 * same gate as MEXC. A POST is never retried: an uncertain outcome is reconciled by client ID.
 */
export class BitunixOrderTransport implements BitunixOrderRequester {
  private readonly read: BitunixReadOnlyTransport;
  private readonly env: Record<string, string | undefined>;
  constructor(
    private readonly o: { credentials: BitunixCredentials; baseUrl?: string; timeoutMs?: number; fetch?: typeof fetch; now?: () => number; nonce?: () => string; env?: Record<string, string | undefined> }
  ) {
    this.env = o.env ?? process.env;
    openLiveOrderTransport(this.env);
    // Only the options actually given: an explicit `undefined` must never replace a transport default.
    this.read = new BitunixReadOnlyTransport({
      credentials: o.credentials,
      ...(o.baseUrl ? { baseUrl: o.baseUrl } : {}),
      ...(o.timeoutMs ? { timeoutMs: o.timeoutMs } : {}),
      ...(o.fetch ? { fetch: o.fetch } : {}),
      ...(o.now ? { now: o.now } : {}),
      ...(o.nonce ? { nonce: o.nonce } : {})
    });
  }

  get<T>(path: string, params?: Record<string, QueryValue>): Promise<T> {
    return this.read.get<T>(path, params);
  }

  async post<T>(path: string, body: Record<string, unknown>): Promise<T> {
    if (!BITUNIX_ORDER_PATHS.some((r) => r.test(path))) throw new BitunixPrivateError(`Refusing POST ${path}: not the order path`, 'REFUSED');
    openLiveOrderTransport(this.env); // re-checked on every order-changing request
    const req = buildBitunixSignedRequest(this.o.credentials, 'POST', path, null, { timestampMs: (this.o.now ?? Date.now)(), nonce: (this.o.nonce ?? bitunixNonce)(), body });
    let res: Response;
    try {
      res = await (this.o.fetch ?? fetch)(`${(this.o.baseUrl ?? BITUNIX_PRIVATE_DEFAULT_BASE_URL).replace(/\/+$/, '')}${req.url}`, { method: 'POST', headers: req.headers, body: req.body, signal: AbortSignal.timeout(this.o.timeoutMs ?? 8_000) });
    } catch (e) {
      const name = (e as Error).name;
      const timeout = name === 'TimeoutError' || name === 'AbortError';
      throw new BitunixPrivateError(`POST ${path}: ${timeout ? 'timed out' : 'network error'}`, timeout ? 'TIMEOUT' : 'NETWORK');
    }
    if (!res.ok) throw new BitunixPrivateError(`POST ${path}: HTTP ${res.status}`, 'HTTP', res.status);
    let parsed: unknown;
    try {
      parsed = await res.json();
    } catch {
      throw new BitunixPrivateError(`POST ${path}: invalid JSON`, 'PARSE');
    }
    return unwrapBitunixEnvelope<T>(parsed, `POST ${path}`);
  }
}

/* ───────────────────────── Pure builders and checks ───────────────────────── */

export interface BitunixContractSpec {
  symbol: string;
  qtyStep: string;
  /** Minimum opening quantity (minTradeVolume). */
  minQty: string;
  /** Maximum market order quantity (maxMarketOrderVolume). */
  maxQty: string;
  priceTick: string;
  takerFeeRate: string;
}

/** Rounds a base-coin quantity DOWN to the contract step. */
export const roundQtyDown = (qty: Decimal.Value, step: Decimal.Value): string => D(qty).div(step).floor().times(step).toFixed();

export function checkOpenQty(qty: string, c: BitunixContractSpec): string | null {
  if (D(qty).lte(0)) return `QTY_BELOW_MIN: ${qty} after rounding to ${c.qtyStep}`;
  if (D(qty).lt(c.minQty)) return `QTY_BELOW_MIN: ${qty} < minimum opening quantity ${c.minQty}`;
  if (D(qty).gt(c.maxQty)) return `QTY_ABOVE_MAX: ${qty} > maximum market quantity ${c.maxQty}`;
  return null;
}

export const slStopTypeOf = (basis: string): 'MARK_PRICE' | 'LAST_PRICE' | null => (basis === 'MARK' ? 'MARK_PRICE' : basis === 'LAST' ? 'LAST_PRICE' : null);
const basisOf = (t: string | null | undefined) => (t === 'MARK_PRICE' || t === 'MARK' ? 'MARK' : 'LAST');

/**
 * The stop rounded to the price tick WITHOUT widening the risk (Long: up, Short: down) and checked
 * against the executable price: a Long stop must sit below the ask, a Short stop above the bid.
 */
export function roundStop(side: 'LONG' | 'SHORT', price: Decimal.Value, tick: Decimal.Value, quote: { bid: string; ask: string }): { ok: true; price: string } | { ok: false; reason: string } {
  const t = D(tick);
  const p = D(price);
  const rounded = (side === 'LONG' ? p.div(t).ceil() : p.div(t).floor()).times(t);
  if (rounded.lte(0)) return { ok: false, reason: `STOP_PRICE_INVALID: ${rounded.toFixed()} is not positive` };
  if (side === 'LONG' && !rounded.lt(quote.ask)) return { ok: false, reason: `STOP_PRICE_INVALID: Long stop ${rounded.toFixed()} is not below the ask ${quote.ask}` };
  if (side === 'SHORT' && !rounded.gt(quote.bid)) return { ok: false, reason: `STOP_PRICE_INVALID: Short stop ${rounded.toFixed()} is not above the bid ${quote.bid}` };
  return { ok: true, price: rounded.toFixed() };
}

/** Open long = BUY + OPEN; open short = SELL + OPEN. Market order with its stop loss attached. */
export function buildBitunixOpenOrder(i: { symbol: string; side: 'LONG' | 'SHORT'; qty: string; clientId: string; stopPrice: string; stopType: 'MARK_PRICE' | 'LAST_PRICE' }): Record<string, unknown> {
  return {
    symbol: i.symbol,
    qty: num(i.qty),
    side: i.side === 'LONG' ? 'BUY' : 'SELL',
    tradeSide: 'OPEN',
    orderType: 'MARKET',
    clientId: i.clientId,
    slPrice: num(i.stopPrice),
    slStopType: i.stopType,
    slOrderType: 'MARKET'
  };
}

/** Close long = BUY + CLOSE + long positionId; close short = SELL + CLOSE + short positionId (documented mapping). */
export function buildBitunixCloseOrder(i: { symbol: string; positionSide: 'LONG' | 'SHORT'; positionId: string; qty: string; clientId: string }): Record<string, unknown> {
  return {
    symbol: i.symbol,
    qty: num(i.qty),
    side: i.positionSide === 'LONG' ? 'BUY' : 'SELL',
    tradeSide: 'CLOSE',
    positionId: i.positionId,
    orderType: 'MARKET',
    clientId: i.clientId
  };
}

export interface TradingSetting {
  symbol: string;
  marginMode: string | null;
  leverage: number | null;
  longLeverage: number | null;
  shortLeverage: number | null;
}

export function parseTradingSettings(data: unknown, symbol: string): TradingSetting | null {
  const rows = Array.isArray(data) ? (data as Record<string, unknown>[]) : [];
  const r = rows.find((x) => String(x?.symbol ?? '').toUpperCase() === symbol.toUpperCase());
  if (!r) return null;
  const int = (v: unknown) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
  return { symbol, marginMode: r.marginMode === undefined || r.marginMode === null ? null : String(r.marginMode).toUpperCase(), leverage: int(r.leverage), longLeverage: int(r.longLeverage), shortLeverage: int(r.shortLeverage) };
}

/** The account's margin mode and the leg's leverage must equal the order's. Never changed by TrendPilot. */
export function checkTradingSettings(s: TradingSetting | null, side: 'LONG' | 'SHORT', leverage: number, marginMode: 'ISOLATED' | 'CROSS'): string | null {
  if (!s) return 'BITUNIX_SETTINGS_UNKNOWN: Bitunix returned no trading settings for this symbol';
  const want = marginMode === 'CROSS' ? 'CROSS' : 'ISOLATION';
  if (s.marginMode !== want) return `BITUNIX_SETTINGS_MISMATCH:MARGIN_MODE: Bitunix ${s.marginMode ?? 'unknown'}, order ${want}`;
  const leg = side === 'LONG' ? (s.longLeverage ?? s.leverage) : (s.shortLeverage ?? s.leverage);
  if (leg !== leverage) return `BITUNIX_SETTINGS_MISMATCH:LEVERAGE: Bitunix ${side} leverage ${leg ?? 'unknown'}, order ${leverage}`;
  return null;
}

const FINAL = new Set(['FILLED', 'CANCELED', 'CANCELLED', 'PART_FILLED_CANCELED', 'EXPIRED']);

/* ───────────────────────── Venue ───────────────────────── */

export interface BitunixVenueOptions {
  requester: BitunixOrderRequester;
  contractFor: (instrumentId: string) => Promise<BitunixContractSpec>;
  capabilities?: CapabilityState;
  confirm?: { attempts: number; delayMs: number };
  sleep?: (ms: number) => Promise<void>;
}

const bitunixMessage = (e: BitunixPrivateError) => e.message.replace(/^[^:]*:\s*/, '').slice(0, 200);

export function bitunixVenue(o: BitunixVenueOptions): ExecutionVenue & { reconcileGraceMs: number } {
  const sleep = o.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const confirm = o.confirm ?? { attempts: 5, delayMs: 400 };
  const verified = (c: BitunixCapabilityId) => livePilotVerified(c, o.capabilities);
  const r = o.requester;

  const getOrder = async (clientId: string): Promise<BitunixOrder | null> => {
    try {
      const d = await r.get<unknown>('/api/v1/futures/trade/get_order_detail', { clientId });
      if (d === null || d === undefined || (typeof d === 'object' && !Array.isArray(d) && Object.keys(d as object).length === 0)) return null;
      return normalizeBitunixOrder(d as Record<string, unknown>);
    } catch (e) {
      if (e instanceof BitunixPrivateError && e.kind === 'API' && e.code === 20007) return null; // order not found
      throw e;
    }
  };

  /** Polls until the order is final. Null = still not final (the caller keeps it pending). */
  const untilFinal = async (clientId: string): Promise<BitunixOrder | null> => {
    for (let i = 0; i < confirm.attempts; i++) {
      const ord = await getOrder(clientId);
      if (ord && FINAL.has(ord.status)) return ord;
      if (i < confirm.attempts - 1) await sleep(confirm.delayMs);
    }
    return null;
  };

  /** Fills from Bitunix's trade history for the order (authoritative); the order summary only if none are listed yet. */
  const fillOf = async (ord: BitunixOrder) => {
    let trades = (await readHistoryTrades(r, { orderId: ord.orderId }, { maxPages: 5 })).items.filter((t) => t.orderId === ord.orderId);
    for (let i = 1; !trades.length && i < confirm.attempts; i++) {
      await sleep(confirm.delayMs);
      trades = (await readHistoryTrades(r, { orderId: ord.orderId }, { maxPages: 5 })).items.filter((t) => t.orderId === ord.orderId);
    }
    if (trades.length) {
      const qty = trades.reduce((t, x) => t.plus(x.qty), D(0));
      return {
        fillId: `bitunix:${ord.orderId}`,
        contracts: qty.toFixed(),
        price: trades.reduce((t, x) => t.plus(D(x.price).times(x.qty)), D(0)).div(qty).toDecimalPlaces(12).toFixed(),
        // Exchange-reported fees, summed as Bitunix states them.
        fee: trades.reduce((t, x) => t.plus(x.fee ?? 0), D(0)).toDecimalPlaces(8).toFixed(),
        filledAt: new Date(Math.max(...trades.map((x) => x.ctimeMs ?? 0)) || Date.now())
      };
    }
    if (!ord.tradeQty || D(ord.tradeQty).lte(0) || !ord.price || D(ord.price).lte(0)) throw new UncertainSubmissionError(ord.clientId ?? ord.orderId, 'fills not listed yet');
    return { fillId: `bitunix:${ord.orderId}`, contracts: ord.tradeQty, price: ord.price, fee: ord.fee ?? '0', filledAt: new Date(ord.mtimeMs ?? Date.now()) };
  };

  const legs = async (symbol: string): Promise<BitunixPosition[]> => (await readPendingPositions(r, { symbol })).items.filter((p) => p.symbol === symbol && D(p.qty).gt(0));

  /** Hedge mode, read from Bitunix now. */
  const hedgeOrRefusal = async (): Promise<string | null> => {
    const m = parseBitunixPositionMode(await r.get('/api/v1/futures/account/position_mode')).mode;
    return m === 'HEDGE' ? null : `POSITION_MODE_MISMATCH:${m}`;
  };

  type StopInfo = Extract<SimResult, { status: 'FILLED' }>['stop'];
  /** The stop Bitunix holds for this leg: polled, because the attached TP/SL may appear late. */
  const attachedStop = async (symbol: string, positionId: string | null, side: 'LONG' | 'SHORT', expected: { price: string; basis: string }, legQty: string | null): Promise<StopInfo> => {
    for (let i = 0; i < confirm.attempts; i++) {
      const all = (await readPendingTpsl(r)).items.filter((t) => t.symbol === symbol && t.slPrice !== null && (positionId ? t.positionId === positionId : true));
      const s = all.find((t) => D(t.slPrice!).eq(expected.price)) ?? (all.length === 1 ? all[0] : undefined);
      if (s) return { orderId: stopRef(s.id), clientOrderId: stopRef(s.id), triggerPrice: s.slPrice!, basis: basisOf(s.slStopType), contracts: s.slQty ?? legQty ?? '0', reduceOnly: true };
      if (i < confirm.attempts - 1) await sleep(confirm.delayMs);
    }
    void side;
    return { orderId: MISSING_STOP, clientOrderId: MISSING_STOP, triggerPrice: expected.price, basis: expected.basis, contracts: '0', reduceOnly: true };
  };

  type Sent = ({ accepted: true } | { rejected: string }) & { diagnostics: VenueDiagnostics };
  /** Sends once. Timeout / network / 5xx / duplicate client ID → look it up by client ID; never resend. */
  const submit = async (clientId: string, body: Record<string, unknown>, context?: Record<string, unknown>): Promise<Sent> => {
    const request = { method: 'POST', path: BITUNIX_PLACE_ORDER_PATH, body, ...(context ? { context } : {}) };
    try {
      const data = await r.post<unknown>(BITUNIX_PLACE_ORDER_PATH, body);
      return { accepted: true, diagnostics: { request, response: { code: 0, message: `accepted ${JSON.stringify(data ?? null).slice(0, 120)}` } } };
    } catch (e) {
      const be = e instanceof BitunixPrivateError ? e : null;
      const duplicate = be?.kind === 'API' && be.code === 30042;
      const uncertain = !be || duplicate || be.kind === 'TIMEOUT' || be.kind === 'NETWORK' || be.kind === 'PARSE' || (be.kind === 'HTTP' && (be.code ?? 0) >= 500) || (be.kind === 'API' && be.code === 10001);
      if (!uncertain) return { rejected: be!.kind === 'API' ? `BITUNIX_${be!.code}` : `BITUNIX_${be!.kind}`, diagnostics: { request, response: { code: be!.code ?? be!.kind, message: bitunixMessage(be!) } } };
      // Bitunix may hold the order (or already holds one with this client ID): reconcile, don't resend.
      const found = await getOrder(clientId).catch(() => null);
      if (found) return { accepted: true, diagnostics: { request, response: { code: duplicate ? 'DUPLICATE_FOUND' : 'UNCERTAIN_FOUND', message: (e as Error).message.slice(0, 200) } } };
      const u = new UncertainSubmissionError(clientId, (e as Error).message);
      u.diagnostics = { request, response: { code: be ? (be.kind === 'API' || be.kind === 'HTTP' ? (be.code ?? be.kind) : be.kind) : 'ERROR', message: (e as Error).message.slice(0, 200) } };
      throw u;
    }
  };

  const openResult = async (symbol: string, ord: BitunixOrder, clientId: string, side: 'LONG' | 'SHORT', stop: { price: string; basis: string }): Promise<SimResult> => {
    if (!ord.tradeQty || D(ord.tradeQty).isZero()) return { status: 'REJECTED', orderId: ord.orderId, clientOrderId: clientId, reason: `BITUNIX_ORDER_${ord.status}` };
    const fill = await fillOf(ord);
    const leg = (await legs(symbol)).filter((p) => p.side === side);
    const pos = leg.length === 1 ? leg[0] : undefined;
    return { status: 'FILLED', orderId: ord.orderId, clientOrderId: clientId, fill, positionRef: pos?.positionId ?? null, stop: await attachedStop(symbol, pos?.positionId ?? null, side, stop, pos?.qty ?? null) };
  };

  const closeResult = (ord: BitunixOrder, clientId: string, requested: string, fill: Awaited<ReturnType<typeof fillOf>> | null): CloseResult => {
    if (!fill || D(fill.contracts).isZero()) return { status: 'REJECTED', orderId: ord.orderId, clientOrderId: clientId, reason: `BITUNIX_ORDER_${ord.status}` };
    return { status: D(fill.contracts).gte(requested) ? 'FILLED' : 'PARTIAL', orderId: ord.orderId, clientOrderId: clientId, requested, fill };
  };

  return {
    kind: 'BITUNIX_PRIVATE',
    reconcileGraceMs: 30_000,

    async placeOpeningOrderWithStop(req: OpeningRequest): Promise<SimResult> {
      const reject = (reason: string): SimResult => ({ status: 'REJECTED', orderId: '', clientOrderId: req.clientOrderId, reason });
      if (!req.stop) return reject('STOP_REQUIRED');
      if (!verified('BITUNIX_OPEN_WITH_ATTACHED_STOP')) return reject('CAPABILITY_UNVERIFIED:BITUNIX_OPEN_WITH_ATTACHED_STOP');
      if (!req.leverage) return reject('LEVERAGE_REQUIRED');
      const stopType = slStopTypeOf(req.stop.basis);
      if (!stopType) return reject(`STOP_BASIS_UNSUPPORTED:${req.stop.basis}`);
      const c = await o.contractFor(req.instrumentId);
      let stopPrice = req.stop.price;
      let diagnostics: VenueDiagnostics | undefined;
      // Reads before the order request: a failure here means nothing was transmitted.
      const notSent = <T>(p: Promise<T>): Promise<T> =>
        p.catch((e) => {
          throw Object.assign(e instanceof Error ? e : new Error(String(e)), { diagnostics: { request: null, response: { code: 'NOT_SENT', message: `before transmission: ${(e as Error)?.message ?? String(e)}`.slice(0, 200) } } });
        });
      if (!(await notSent(getOrder(req.clientOrderId)))) {
        const mode = await notSent(hedgeOrRefusal());
        if (mode) return reject(mode);
        const settings = parseTradingSettings(await notSent(r.get('/api/v1/futures/account/trading_settings', { symbols: c.symbol })), c.symbol);
        const bad = checkTradingSettings(settings, req.side, req.leverage, req.marginMode ?? 'ISOLATED');
        if (bad) return reject(bad);
        const qty = roundQtyDown(req.contracts, c.qtyStep);
        const qtyIssue = checkOpenQty(qty, c);
        if (qtyIssue) return reject(qtyIssue);
        const sl = roundStop(req.side, req.stop.price, c.priceTick, req.quote);
        if (!sl.ok) return reject(sl.reason);
        stopPrice = sl.price;
        // Margin for this leg: notional / leverage + taker fee, against what Bitunix says is available.
        const price = req.side === 'LONG' ? req.quote.ask : req.quote.bid;
        const notional = D(qty).times(price);
        const required = notional.div(req.leverage).plus(notional.times(c.takerFeeRate));
        const acct = parseBitunixAccount(await notSent(r.get('/api/v1/futures/account', { marginCoin: 'USDT' })), 'USDT');
        const available = acct ? D(acct.available).plus(Decimal.min(0, acct.crossUnrealizedPNL)) : D(0);
        if (required.gt(available)) return reject(`INSUFFICIENT_MARGIN: needs ${required.toDecimalPlaces(8).toFixed()} USDT, Bitunix shows ${available.toFixed()} available`);
        const sent = await submit(req.clientOrderId, buildBitunixOpenOrder({ symbol: c.symbol, side: req.side, qty, clientId: req.clientOrderId, stopPrice, stopType }), { settings, available: available.toFixed(), requiredMargin: required.toDecimalPlaces(8).toFixed() });
        diagnostics = sent.diagnostics;
        if ('rejected' in sent) return { ...reject(sent.rejected), diagnostics };
      }
      const ord = await untilFinal(req.clientOrderId);
      if (!ord) {
        const u = new UncertainSubmissionError(req.clientOrderId, 'order not final after confirmation polling');
        if (diagnostics) u.diagnostics = diagnostics;
        throw u;
      }
      const res = await openResult(c.symbol, ord, req.clientOrderId, req.side, { price: stopPrice, basis: req.stop.basis });
      return diagnostics ? { ...res, diagnostics } : res;
    },

    async lookupOrder(clientOrderId, instrumentId) {
      const c = await o.contractFor(instrumentId);
      const ord = await getOrder(clientOrderId);
      if (!ord) return null;
      if (!FINAL.has(ord.status)) throw new UncertainSubmissionError(clientOrderId, `order still ${ord.status}`);
      // An opening order: BUY opened the Long leg, SELL the Short leg.
      const side = ord.side === 'SELL' ? 'SHORT' : 'LONG';
      const detail = await r.get<Record<string, unknown>>('/api/v1/futures/trade/get_order_detail', { clientId: clientOrderId });
      const sl = detail && typeof detail === 'object' ? { price: String(detail.slPrice ?? '0'), basis: basisOf(detail.slStopType as string) } : { price: '0', basis: 'LAST' };
      return openResult(c.symbol, ord, clientOrderId, side, sl);
    },

    async inspectProtection(stopOrderId, instrumentId): Promise<ProtectionState | null> {
      if (stopOrderId === MISSING_STOP || !stopOrderId.startsWith('bitunix-tpsl:')) return null;
      const c = await o.contractFor(instrumentId);
      const s: BitunixTpsl | undefined = (await readPendingTpsl(r)).items.find((t) => t.id === stopIdOf(stopOrderId));
      if (!s || s.slPrice === null) return null; // gone, or a take-profit only: not protection
      const leg = s.positionId ? (await legs(c.symbol)).find((p) => p.positionId === s.positionId) : undefined;
      if (!leg) return null;
      // A position TP/SL without a quantity covers the whole leg; Bitunix closes it with a market order.
      return { status: 'ACTIVE', side: leg.side === 'LONG' ? 'SHORT' : 'LONG', contracts: s.slQty ?? leg.qty, triggerPrice: s.slPrice, basis: basisOf(s.slStopType), reduceOnly: true };
    },

    async placeReduceOnlyClose(req: CloseRequest): Promise<CloseResult> {
      const reject = (reason: string, diagnostics?: VenueDiagnostics): CloseResult => ({ status: 'REJECTED', orderId: '', clientOrderId: req.clientOrderId, reason, ...(diagnostics ? { diagnostics } : {}) });
      const notSent = (reason: string, message: string) => reject(reason, { request: null, response: { code: 'NOT_SENT', message: message.slice(0, 200) } });
      if (!verified('BITUNIX_HEDGE_CLOSE_BY_POSITION')) return reject('CAPABILITY_UNVERIFIED:BITUNIX_HEDGE_CLOSE_BY_POSITION');
      const c = await o.contractFor(req.instrumentId);
      const existing = await getOrder(req.clientOrderId);
      let requested = req.contracts;
      let diagnostics: VenueDiagnostics | undefined;
      if (!existing) {
        const mode = await hedgeOrRefusal();
        if (mode) return notSent(mode, 'Bitunix closes are built for Hedge mode only; the account reports another mode');
        const open = await legs(c.symbol);
        // The leg by its Bitunix positionId when TrendPilot knows it; a newer position is never closed in its place.
        let pos: BitunixPosition | undefined;
        if (req.positionRef) {
          pos = open.find((p) => p.positionId === req.positionRef);
          if (!pos) return notSent('REDUCE_ONLY_NO_POSITION', `Bitunix holds no position ${req.positionRef} on ${c.symbol} (stale or closed)`);
          if (pos.side !== req.positionSide) return notSent('CLOSE_POSITION_MISMATCH:SIDE', `position ${pos.positionId} is ${pos.side}, TrendPilot closes ${req.positionSide}`);
        } else {
          const same = open.filter((p) => p.side === req.positionSide);
          if (same.length > 1) return notSent('CLOSE_POSITION_MISMATCH:AMBIGUOUS', `${same.length} ${req.positionSide} positions on ${c.symbol}`);
          pos = same[0];
          if (!pos) return notSent('REDUCE_ONLY_NO_POSITION', `Bitunix holds no ${req.positionSide} on ${c.symbol}`);
        }
        // Never more than the leg holds right now: a close can never open the other side.
        const qty = roundQtyDown(Decimal.min(req.contracts, pos.qty), c.qtyStep);
        if (D(qty).lte(0)) return notSent('REDUCE_ONLY_NO_POSITION', `leg ${pos.positionId} holds ${pos.qty}, below one step ${c.qtyStep}`);
        requested = qty;
        const body = buildBitunixCloseOrder({ symbol: c.symbol, positionSide: req.positionSide, positionId: pos.positionId, qty, clientId: req.clientOrderId });
        const sent = await submit(req.clientOrderId, body, { position: { positionId: pos.positionId, side: pos.side, qty: pos.qty }, requestedContracts: D(req.contracts).toFixed() });
        diagnostics = sent.diagnostics;
        if ('rejected' in sent) return reject(sent.rejected, sent.diagnostics);
      } else {
        requested = existing.qty ?? req.contracts;
      }
      const ord = await untilFinal(req.clientOrderId);
      if (!ord) throw new UncertainSubmissionError(req.clientOrderId, 'close not final after confirmation polling');
      const res = closeResult(ord, req.clientOrderId, requested, ord.tradeQty && D(ord.tradeQty).gt(0) ? await fillOf(ord) : null);
      if (!diagnostics) return res;
      const after = await legs(c.symbol)
        .then((open) => (req.positionRef ? open.find((p) => p.positionId === req.positionRef) : open.find((p) => p.side === req.positionSide))?.qty ?? '0')
        .catch(() => null);
      return { ...res, diagnostics: { ...diagnostics, response: { code: diagnostics.response?.code ?? null, message: diagnostics.response?.message ?? null, positionAfter: after } } };
    },

    async lookupCloseOrder(clientOrderId) {
      const ord = await getOrder(clientOrderId);
      if (!ord) return null;
      if (!FINAL.has(ord.status)) throw new UncertainSubmissionError(clientOrderId, `close still ${ord.status}`);
      return closeResult(ord, clientOrderId, ord.qty ?? '0', ord.tradeQty && D(ord.tradeQty).gt(0) ? await fillOf(ord) : null);
    },

    async resizeProtection(stopOrderId, contracts, instrumentId) {
      const c = await o.contractFor(instrumentId);
      const s = (await readPendingTpsl(r)).items.find((t) => t.id === stopIdOf(stopOrderId));
      if (!s) throw new BitunixPrivateError(`TP/SL ${stopOrderId} not found at Bitunix`, 'API', 20007);
      // A whole-position TP/SL (no quantity) follows the leg's size: nothing to resize.
      if (s.slQty === null || D(s.slQty).eq(contracts)) return stopOrderId;
      void c;
      // Fixed quantity: modify THIS TP/SL (by its orderId) to the remaining size at the SAME trigger.
      // Refused (existing recovery: UNPROTECTED) when unverified, or when it also carries a take
      // profit (modifying would change that too), or when the result cannot be confirmed.
      if (!verified('BITUNIX_TPSL_RESIZE')) throw new BitunixPrivateError('CAPABILITY_UNVERIFIED:BITUNIX_TPSL_RESIZE', 'REFUSED');
      if (s.tpPrice !== null) throw new BitunixPrivateError('the TP/SL also carries a take profit: not modified', 'REFUSED');
      if (s.slPrice === null) throw new BitunixPrivateError('the TP/SL has no stop price', 'REFUSED');
      const qty = roundQtyDown(contracts, c.qtyStep);
      if (D(qty).lte(0)) throw new BitunixPrivateError(`remaining ${contracts} is below one step`, 'REFUSED');
      let newId = s.id;
      try {
        const res = await r.post<{ orderId?: string }>(BITUNIX_TPSL_MODIFY_PATH, { orderId: s.id, slPrice: num(s.slPrice), slStopType: s.slStopType ?? 'MARK_PRICE', slOrderType: 'MARKET', slQty: qty });
        if (res?.orderId) newId = String(res.orderId);
      } catch (e) {
        const be = e instanceof BitunixPrivateError ? e : null;
        if (be && !(be.kind === 'TIMEOUT' || be.kind === 'NETWORK' || (be.kind === 'HTTP' && (be.code ?? 0) >= 500))) throw e;
        // Uncertain: confirmed (or not) by the re-read below.
      }
      for (let i = 0; i < confirm.attempts; i++) {
        const now = (await readPendingTpsl(r)).items.find((t) => (t.id === newId || t.id === s.id) && t.slPrice !== null && D(t.slPrice).eq(s.slPrice!));
        if (now && now.slQty !== null && D(now.slQty).eq(qty)) return stopRef(now.id);
        if (i < confirm.attempts - 1) await sleep(confirm.delayMs);
      }
      throw new BitunixPrivateError(`TP/SL ${s.id} resize to ${qty} not confirmed by Bitunix`, 'API');
    },

    async cancelOrder() {
      // Bitunix removes a position TP/SL with the position; cancelling one is an order-changing call
      // this release does not make. The flow re-inspects protection afterwards.
    },

    async position(_account, instrumentId, _tx, side) {
      const c = await o.contractFor(instrumentId);
      const open = await legs(c.symbol);
      if (side) {
        const q = open.filter((p) => p.side === side).reduce((t, p) => t.plus(p.qty), D(0));
        return { side: q.gt(0) ? side : null, contracts: q.toFixed() };
      }
      if (open.length > 1) throw new BitunixPrivateError(`${c.symbol}: both Hedge legs are open at Bitunix; name the side to read one leg`, 'REFUSED');
      return open[0] ? { side: open[0].side, contracts: open[0].qty } : { side: null, contracts: '0' };
    },

    async stopOrderIdFor(ref) {
      return ref.startsWith('bitunix-tpsl:') && ref !== MISSING_STOP ? ref : null;
    }
  };
}
