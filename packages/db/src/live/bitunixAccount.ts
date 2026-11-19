import { Decimal } from '@trendpilot/domain';
import { BitunixPrivateError, parseBitunixAccount, parseBitunixPositionMode, type BitunixAccount, type BitunixPositionMode, type BitunixRequester, type QueryValue } from './bitunixPrivate';

/**
 * Bitunix Futures private READ models (Step 2): positions, orders, TP/SL, fills and history, read
 * through the read-only transport and normalized so that exchange IDs stay strings, quantities and
 * prices stay exact decimal strings, and every exchange timestamp is Unix ms.
 *
 * Docs read 2026-11-16 (pages under https://www.bitunix.com/api-docs/futures/): position/
 * get_pending_positions, get_history_positions; trade/get_pending_orders, get_history_orders,
 * get_history_trades, get_order_detail; tp_sl/get_pending_tp_sl_order (path tpsl/get_pending_orders),
 * get_history_tp_sl_order (path tpsl/get_history_orders).
 *
 * Pagination: `skip` (row offset) + `limit` (≤ 100), with `total` on most list endpoints. A read is
 * COMPLETE only when the last page is short, or skip reaches `total`; hitting the page cap raises
 * an INCOMPLETE error so a partial list is never mistaken for the whole account.
 *
 * Sub-accounts: pending positions without `subAccountId` "returns positions for the main account
 * and all sub-accounts the current API Key can access". TrendPilot reads the investor's MAIN
 * account only: it sends `includeSubAccounts=false` and drops any row that carries a non-empty
 * `subAccountId` (counted, so the exclusion is visible). History endpoints already return the main
 * account only when `subAccountId` is omitted.
 */

export const BITUNIX_PAGE_SIZE = 100;
/** Hard cap per list read (10 000 rows): beyond it the read is reported INCOMPLETE. */
export const BITUNIX_MAX_PAGES = 100;

export type Side = 'LONG' | 'SHORT';
export type Origin = 'TRENDPILOT' | 'EXCHANGE';

/** TrendPilot's client order IDs (`tp-<uuid>`, `tpx-<uuid>`); anything else was placed outside TrendPilot. */
/**
 * TrendPilot's client IDs: `tp-…` / `tpx-…` (intents created before 13 Nov 2026) and, since then,
 * 32 lowercase hex characters (newClientOrderId). The order intent table remains the authority:
 * an order is TrendPilot's own only when an intent of the connection's owner carries that ID.
 */
export const isTrendPilotClientId = (clientId: string | null | undefined): boolean => !!clientId && (/^tpx?-/.test(clientId) || /^[0-9a-f]{32}$/.test(clientId));
export const originOf = (clientId: string | null | undefined): Origin => (isTrendPilotClientId(clientId) ? 'TRENDPILOT' : 'EXCHANGE');

const str = (v: unknown): string | null => (v === null || v === undefined || v === '' ? null : String(v));
const decOrNull = (v: unknown, field: string, what: string): string | null => {
  if (v === null || v === undefined || v === '') return null;
  try {
    const d = new Decimal(v as Decimal.Value);
    if (!d.isFinite()) throw new Error('not finite');
    return d.toFixed();
  } catch {
    throw new BitunixPrivateError(`${what}: ${field} is not a number`, 'PARSE');
  }
};
const dec = (v: unknown, field: string, what: string): string => {
  const d = decOrNull(v, field, what);
  if (d === null) throw new BitunixPrivateError(`${what}: ${field} is missing`, 'PARSE');
  return d;
};
const ms = (v: unknown): number | null => {
  const n = typeof v === 'string' && v.trim() ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.trunc(n) : null;
};
const id = (v: unknown, field: string, what: string): string => {
  if ((typeof v !== 'string' && typeof v !== 'number') || String(v) === '') throw new BitunixPrivateError(`${what}: ${field} is missing`, 'PARSE');
  // Exchange IDs stay strings; a numeric ID beyond 2^53 would already be corrupted by JSON.parse.
  if (typeof v === 'number' && !Number.isSafeInteger(v)) throw new BitunixPrivateError(`${what}: ${field} lost precision (unsafe number)`, 'PARSE');
  return String(v);
};
const modeOf = (v: unknown): BitunixPositionMode | null => {
  const s = String(v ?? '').toUpperCase();
  return s === 'ONE_WAY' || s === 'HEDGE' ? s : null;
};
/**
 * POSITION direction (the leg's exposure), per endpoint. Never used for ORDER sides: an order's
 * BUY/SELL is its trade direction, and in Hedge mode a SELL may close a Long leg (reduce-only), so
 * order rows keep their raw side and opening/closing intent is decided from tradeSide/reduceOnly.
 *
 *  - get_pending_positions: documented as LONG/SHORT, but production (19 Nov 2026, HEDGE mode,
 *    position 403163326623575343) sends the leg's opening direction: "SELL" for the Short leg (the
 *    private WebSocket `position` channel sent "SHORT" for the same leg). A position row's BUY/SELL is
 *    accepted only with a recognized positionMode on the row (HEDGE: one leg per direction;
 *    ONE_WAY: the net position's direction), so an unidentified row still fails the read.
 *  - get_history_positions: production sends BUY/SELL (19 Nov 2026: "BUY"); rows carry no mode.
 */
type SideSource = { endpoint: 'pending'; positionMode: BitunixPositionMode | null } | { endpoint: 'history' };
const sideOf = (v: unknown, what: string, src: SideSource): Side => {
  const s = String(v ?? '').toUpperCase();
  if (s === 'LONG' || s === 'SHORT') return s;
  const directional = src.endpoint === 'history' || src.positionMode !== null;
  if (directional && s === 'BUY') return 'LONG';
  if (directional && s === 'SELL') return 'SHORT';
  throw new BitunixPrivateError(`${what}: unknown position side ${JSON.stringify(v ?? null)}${src.endpoint === 'pending' && src.positionMode === null && (s === 'BUY' || s === 'SELL') ? ' (no positionMode on the row)' : ''}`, 'PARSE');
};
/** A row from another account (sub-account) — never part of the investor's main-account state. */
export const isSubAccountRow = (r: Record<string, unknown>) => r.subAccountId !== undefined && r.subAccountId !== null && r.subAccountId !== '' && String(r.subAccountId) !== '0';

/* ───────────────────────── Normalized shapes ───────────────────────── */

export interface BitunixPosition {
  positionId: string;
  symbol: string;
  side: Side;
  qty: string;
  avgOpenPrice: string | null;
  positionMode: BitunixPositionMode | null;
  marginMode: string | null;
  leverage: number | null;
  margin: string | null;
  unrealizedPNL: string | null;
  realizedPNL: string | null;
  /** Cumulative fee / funding as Bitunix reports them on the open position (not a settlement). */
  fee: string | null;
  funding: string | null;
  /** null when Bitunix reports ≤ 0 ("no liquidation price currently"). */
  liqPrice: string | null;
  ctimeMs: number | null;
  mtimeMs: number | null;
}

export function normalizeBitunixPosition(r: Record<string, unknown>): BitunixPosition {
  const what = `position ${String(r?.positionId ?? '?')}`;
  const liq = decOrNull(r.liqPrice, 'liqPrice', what);
  const positionMode = modeOf(r.positionMode);
  return {
    positionId: id(r.positionId, 'positionId', what),
    symbol: id(r.symbol, 'symbol', what),
    side: sideOf(r.side, what, { endpoint: 'pending', positionMode }),
    qty: dec(r.qty, 'qty', what),
    avgOpenPrice: decOrNull(r.avgOpenPrice, 'avgOpenPrice', what),
    positionMode,
    marginMode: str(r.marginMode),
    leverage: ms(r.leverage),
    margin: decOrNull(r.margin, 'margin', what),
    unrealizedPNL: decOrNull(r.unrealizedPNL, 'unrealizedPNL', what),
    realizedPNL: decOrNull(r.realizedPNL, 'realizedPNL', what),
    fee: decOrNull(r.fee, 'fee', what),
    funding: decOrNull(r.funding, 'funding', what),
    liqPrice: liq !== null && new Decimal(liq).gt(0) ? liq : null,
    ctimeMs: ms(r.ctime),
    mtimeMs: ms(r.mtime)
  };
}

export interface BitunixHistoryPosition {
  positionId: string;
  symbol: string;
  side: Side;
  maxQty: string | null;
  entryPrice: string | null;
  closePrice: string | null;
  liqQty: string | null;
  fee: string | null;
  funding: string | null;
  realizedPNL: string | null;
  ctimeMs: number | null;
  mtimeMs: number | null;
}

export function normalizeBitunixHistoryPosition(r: Record<string, unknown>): BitunixHistoryPosition {
  const what = `history position ${String(r?.positionId ?? '?')}`;
  return {
    positionId: id(r.positionId, 'positionId', what),
    symbol: id(r.symbol, 'symbol', what),
    side: sideOf(r.side, what, { endpoint: 'history' }),
    maxQty: decOrNull(r.maxQty, 'maxQty', what),
    entryPrice: decOrNull(r.entryPrice, 'entryPrice', what),
    closePrice: decOrNull(r.closePrice, 'closePrice', what),
    liqQty: decOrNull(r.liqQty, 'liqQty', what),
    fee: decOrNull(r.fee, 'fee', what),
    funding: decOrNull(r.funding, 'funding', what),
    realizedPNL: decOrNull(r.realizedPNL, 'realizedPNL', what),
    ctimeMs: ms(r.ctime),
    mtimeMs: ms(r.mtime)
  };
}

export interface BitunixOrder {
  orderId: string;
  clientId: string | null;
  origin: Origin;
  symbol: string;
  side: string | null;
  orderType: string | null;
  qty: string | null;
  tradeQty: string | null;
  /**
   * The order's REQUESTED price: a limit price, or (get_order_detail of a market order) the price
   * Bitunix recorded at placement. Null for a market order listed with `price: "MARKET"` or no price.
   * Never an execution price: fills come from trade history, else `avgPrice`.
   */
  requestedPrice: string | null;
  /** Executed average price as Bitunix reports it (`avgPrice`); null when not reported. */
  avgPrice: string | null;
  status: string;
  reduceOnly: boolean | null;
  positionMode: BitunixPositionMode | null;
  fee: string | null;
  realizedPNL: string | null;
  ctimeMs: number | null;
  mtimeMs: number | null;
  /** Optional fields Bitunix sent in a form TrendPilot does not use (kept for evidence, never fatal). */
  issues?: string[];
}

/** `price` of a Bitunix order: a decimal, or one of the documented market-order forms (no price). */
function requestedPriceOf(v: unknown, issues: string[]): string | null {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'string' && v.trim().toUpperCase() === 'MARKET') return null;
  try {
    const d = new Decimal(v as Decimal.Value);
    if (d.isFinite()) return d.toFixed();
  } catch {
    /* recorded below */
  }
  issues.push(`price ${JSON.stringify(v).slice(0, 40)} is not a price`);
  return null;
}

export function normalizeBitunixOrder(r: Record<string, unknown>): BitunixOrder {
  const what = `order ${String(r?.orderId ?? '?')}`;
  const clientId = str(r.clientId);
  const issues: string[] = [];
  const requestedPrice = requestedPriceOf(r.price, issues);
  return {
    orderId: id(r.orderId, 'orderId', what),
    clientId,
    origin: originOf(clientId),
    symbol: id(r.symbol, 'symbol', what),
    side: str(r.side),
    // The docs' table says orderType; their examples send `type`.
    orderType: str(r.orderType ?? r.type),
    qty: decOrNull(r.qty, 'qty', what),
    tradeQty: decOrNull(r.tradeQty, 'tradeQty', what),
    requestedPrice,
    // Fill-establishing fields stay strict: a malformed executed price is a parse failure.
    avgPrice: decOrNull(r.avgPrice ?? r.averagePrice, 'avgPrice', what),
    status: String(r.status ?? r.orderStatus ?? 'UNKNOWN'),
    reduceOnly: typeof r.reduceOnly === 'boolean' ? r.reduceOnly : null,
    positionMode: modeOf(r.positionMode),
    fee: decOrNull(r.fee, 'fee', what),
    realizedPNL: decOrNull(r.realizedPNL, 'realizedPNL', what),
    ctimeMs: ms(r.ctime),
    mtimeMs: ms(r.mtime),
    ...(issues.length ? { issues } : {})
  };
}

export interface BitunixTpsl {
  id: string;
  positionId: string | null;
  symbol: string;
  tpPrice: string | null;
  tpStopType: string | null;
  tpOrderType: string | null;
  tpQty: string | null;
  slPrice: string | null;
  slStopType: string | null;
  slOrderType: string | null;
  slQty: string | null;
}

export function normalizeBitunixTpsl(r: Record<string, unknown>): BitunixTpsl {
  const what = `tpsl ${String(r?.id ?? '?')}`;
  return {
    id: id(r.id, 'id', what),
    positionId: str(r.positionId),
    symbol: id(r.symbol, 'symbol', what),
    tpPrice: decOrNull(r.tpPrice, 'tpPrice', what),
    tpStopType: str(r.tpStopType),
    tpOrderType: str(r.tpOrderType),
    tpQty: decOrNull(r.tpQty, 'tpQty', what),
    slPrice: decOrNull(r.slPrice, 'slPrice', what),
    slStopType: str(r.slStopType),
    slOrderType: str(r.slOrderType),
    slQty: decOrNull(r.slQty, 'slQty', what)
  };
}

export interface BitunixTrade {
  tradeId: string;
  orderId: string;
  clientId: string | null;
  origin: Origin;
  symbol: string | null;
  side: string | null;
  qty: string;
  price: string;
  /** Exchange-reported fee for this fill. */
  fee: string | null;
  realizedPNL: string | null;
  reduceOnly: boolean | null;
  roleType: string | null;
  ctimeMs: number | null;
}

export function normalizeBitunixTrade(r: Record<string, unknown>): BitunixTrade {
  const what = `trade ${String(r?.tradeId ?? '?')}`;
  const clientId = str(r.clientId);
  return {
    tradeId: id(r.tradeId, 'tradeId', what),
    orderId: id(r.orderId, 'orderId', what),
    clientId,
    origin: originOf(clientId),
    symbol: str(r.symbol),
    side: str(r.side),
    qty: dec(r.qty, 'qty', what),
    price: dec(r.price, 'price', what),
    fee: decOrNull(r.fee, 'fee', what),
    realizedPNL: decOrNull(r.realizedPNL, 'realizedPNL', what),
    reduceOnly: typeof r.reduceOnly === 'boolean' ? r.reduceOnly : null,
    roleType: str(r.roleType),
    ctimeMs: ms(r.ctime)
  };
}

/* ───────────────────────── Reads ───────────────────────── */

export interface ListRead<T> {
  items: T[];
  /** Rows dropped because they belong to a sub-account. */
  excludedSubAccountRows: number;
  pages: number;
  /** collectRowErrors only: rows that could not be parsed, with the identifiers they carried. */
  skipped?: SkippedRow[];
}

export interface SkippedRow {
  orderId: string | null;
  clientId: string | null;
  symbol: string | null;
  error: string;
}

/**
 * Bitunix tags rows of the API key's OWN account with that account's ID in `subAccountId` on some
 * endpoints (production, 19 Nov 2026: every history order/position row carried "891435181", while
 * get_order_detail for the same order said null). A requester may carry that verified tag
 * (`accountTag`, see resolveBitunixAccountTag); rows with it are the main account's, rows with any
 * other non-empty ID are a sub-account's.
 */
export type TaggedRequester = BitunixRequester & { accountTag?: string | null };
const tagOf = (r: BitunixRequester): string | null => (r as TaggedRequester).accountTag ?? null;
const otherAccountRow = (row: Record<string, unknown>, own: string | null) => isSubAccountRow(row) && !(own !== null && String(row.subAccountId) === own);

export interface ReadOptions {
  pageSize?: number;
  maxPages?: number;
  /** Keep rows tagged with any sub-account ID (clientId evidence searches). */
  includeSubAccountRows?: boolean;
  /** Collect unparseable rows (with their identifiers) instead of failing the whole read. */
  collectRowErrors?: boolean;
}

/** Pulls rows out of `data` (a bare list, or an object holding `listKey`). Anything else is PARSE. */
function rowsOf(data: unknown, listKey: string | null, what: string): { rows: Record<string, unknown>[]; total: number | null } {
  if (Array.isArray(data)) return { rows: data as Record<string, unknown>[], total: null };
  if (data && typeof data === 'object' && listKey) {
    const o = data as Record<string, unknown>;
    const list = o[listKey];
    if (Array.isArray(list)) return { rows: list as Record<string, unknown>[], total: ms(o.total) ?? (o.total === 0 || o.total === '0' ? 0 : null) };
    if (list === null || list === undefined) {
      // `{ total: 0 }` without a list is an empty page; anything else is an incomplete response.
      if (o.total === 0 || o.total === '0') return { rows: [], total: 0 };
    }
  }
  if (data === null || data === undefined) return { rows: [], total: 0 };
  throw new BitunixPrivateError(`${what}: response has no ${listKey ?? 'list'}`, 'PARSE');
}

/**
 * Reads every page of a skip/limit list. Complete when a page is short or `skip` reaches `total`;
 * otherwise it throws INCOMPLETE after `maxPages`. Sub-account rows are dropped and counted.
 */
export async function readAllPages<T>(
  r: BitunixRequester,
  path: string,
  params: Record<string, QueryValue>,
  listKey: string | null,
  normalize: (row: Record<string, unknown>) => T,
  o: ReadOptions = {}
): Promise<ListRead<T>> {
  const limit = o.pageSize ?? BITUNIX_PAGE_SIZE;
  const maxPages = o.maxPages ?? BITUNIX_MAX_PAGES;
  const own = tagOf(r);
  const items: T[] = [];
  const skipped: SkippedRow[] = [];
  let excluded = 0;
  for (let page = 0; page < maxPages; page++) {
    const skip = page * limit;
    const { rows, total } = rowsOf(await r.get(path, { ...params, skip, limit }), listKey, path);
    for (const row of rows) {
      if (!row || typeof row !== 'object') throw new BitunixPrivateError(`${path}: a row is not an object`, 'PARSE');
      if (otherAccountRow(row, own) && !o.includeSubAccountRows) {
        excluded += 1;
        continue;
      }
      try {
        items.push(normalize(row));
      } catch (e) {
        if (!o.collectRowErrors) throw e;
        const idOf = (v: unknown) => (v === null || v === undefined || v === '' ? null : String(v));
        skipped.push({ orderId: idOf(row.orderId), clientId: idOf(row.clientId), symbol: idOf(row.symbol), error: (e as Error).message.slice(0, 200) });
      }
    }
    if (rows.length < limit || (total !== null && skip + rows.length >= total)) return { items, excludedSubAccountRows: excluded, pages: page + 1, ...(o.collectRowErrors ? { skipped } : {}) };
  }
  throw new BitunixPrivateError(`${path}: more than ${maxPages * limit} rows; the read is incomplete`, 'INCOMPLETE');
}

/** Open positions of the MAIN account (no pagination on this endpoint). */
export async function readPendingPositions(r: BitunixRequester, params: { symbol?: string; positionId?: string } = {}): Promise<ListRead<BitunixPosition>> {
  const { rows } = rowsOf(await r.get('/api/v1/futures/position/get_pending_positions', { ...params, includeSubAccounts: false }), null, 'get_pending_positions');
  let excluded = 0;
  const items: BitunixPosition[] = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') throw new BitunixPrivateError('get_pending_positions: a row is not an object', 'PARSE');
    if (otherAccountRow(row, tagOf(r))) excluded += 1;
    else items.push(normalizeBitunixPosition(row));
  }
  return { items, excludedSubAccountRows: excluded, pages: 1 };
}

export const readHistoryPositions = (r: BitunixRequester, params: { positionId?: string; symbol?: string; startTime?: number; endTime?: number }, o?: ReadOptions) =>
  readAllPages(r, '/api/v1/futures/position/get_history_positions', params, 'positionList', normalizeBitunixHistoryPosition, o);
export const readPendingOrders = (r: BitunixRequester, o?: ReadOptions) => readAllPages(r, '/api/v1/futures/trade/get_pending_orders', {}, 'orderList', normalizeBitunixOrder, o);
export const readHistoryOrders = (r: BitunixRequester, params: { startTime?: number; endTime?: number; symbol?: string }, o?: ReadOptions) =>
  readAllPages(r, '/api/v1/futures/trade/get_history_orders', params, 'orderList', normalizeBitunixOrder, o);
/**
 * Trade history, each trade once: pages are offset-based, so a trade arriving during the read shifts
 * a row onto the next page and it is returned twice. Fees and quantities are summed downstream, so a
 * repeated tradeId is dropped here.
 */
export async function readHistoryTrades(r: BitunixRequester, params: { startTime?: number; endTime?: number; positionId?: string; orderId?: string }, o?: { maxPages?: number }): Promise<ListRead<BitunixTrade>> {
  const read = await readAllPages(r, '/api/v1/futures/trade/get_history_trades', params, 'tradeList', normalizeBitunixTrade, o);
  const seen = new Set<string>();
  return { ...read, items: read.items.filter((t) => (seen.has(t.tradeId) ? false : (seen.add(t.tradeId), true))) };
}
export const readPendingTpsl = (r: BitunixRequester, o?: ReadOptions) => readAllPages(r, '/api/v1/futures/tpsl/get_pending_orders', {}, 'orderList', normalizeBitunixTpsl, o);

export async function readOrderDetail(r: BitunixRequester, orderId: string): Promise<BitunixOrder | null> {
  const d = await r.get('/api/v1/futures/trade/get_order_detail', { orderId });
  return d && typeof d === 'object' && !Array.isArray(d) ? normalizeBitunixOrder(d as Record<string, unknown>) : null;
}

/**
 * The ID Bitunix puts in `subAccountId` for the key's OWN account, established from evidence: a
 * history order carrying a tag that get_order_detail (the key's own account; it reports no
 * subAccountId) returns as the same order. Null when no tagged order exists or the detail does not
 * confirm it — then every tagged row stays excluded, as before.
 */
export async function resolveBitunixAccountTag(r: BitunixRequester): Promise<{ tag: string | null; evidence: string }> {
  const d = await r.get<unknown>('/api/v1/futures/trade/get_history_orders', { skip: 0, limit: 20 });
  const rows = (d && typeof d === 'object' && Array.isArray((d as { orderList?: unknown }).orderList) ? (d as { orderList: Record<string, unknown>[] }).orderList : []).filter(isSubAccountRow);
  for (const row of rows.slice(0, 3)) {
    const tag = String(row.subAccountId);
    const orderId = row.orderId === undefined || row.orderId === null ? '' : String(row.orderId);
    if (!orderId) continue;
    let detail: Record<string, unknown> | null = null;
    try {
      const x = await r.get<unknown>('/api/v1/futures/trade/get_order_detail', { orderId });
      detail = x && typeof x === 'object' && !Array.isArray(x) ? (x as Record<string, unknown>) : null;
    } catch {
      detail = null;
    }
    if (detail && String(detail.orderId) === orderId && (!isSubAccountRow(detail) || String(detail.subAccountId) === tag)) {
      return { tag, evidence: `history order ${orderId} tagged subAccountId ${tag}; get_order_detail returns it for this key's own account (subAccountId ${detail.subAccountId ?? 'null'})` };
    }
  }
  return { tag: null, evidence: rows.length ? 'tagged history orders not confirmed by get_order_detail' : 'no tagged history order' };
}

export interface BitunixSnapshot {
  takenAt: number;
  positionMode: BitunixPositionMode;
  usdt: BitunixAccount | null;
  positions: BitunixPosition[];
  pendingOrders: BitunixOrder[];
  tpsl: BitunixTpsl[];
  excludedSubAccountRows: number;
}

/**
 * A complete account snapshot, or an exception. Every list must be read in full; there is no
 * "best effort" snapshot, because a missing position would look like a close.
 */
export async function takeBitunixSnapshot(r: BitunixRequester, now: () => number = Date.now): Promise<BitunixSnapshot> {
  const takenAt = now();
  const mode = parseBitunixPositionMode(await r.get('/api/v1/futures/account/position_mode')).mode;
  const usdt = parseBitunixAccount(await r.get('/api/v1/futures/account', { marginCoin: 'USDT' }), 'USDT');
  const positions = await readPendingPositions(r);
  const orders = await readPendingOrders(r);
  const tpsl = await readPendingTpsl(r);
  const seen = new Set<string>();
  for (const p of positions.items) {
    if (seen.has(p.positionId)) throw new BitunixPrivateError(`get_pending_positions: position ${p.positionId} listed twice`, 'PARSE');
    seen.add(p.positionId);
  }
  return {
    takenAt,
    positionMode: mode,
    usdt,
    positions: positions.items,
    pendingOrders: orders.items,
    tpsl: tpsl.items,
    excludedSubAccountRows: positions.excludedSubAccountRows + orders.excludedSubAccountRows + tpsl.excludedSubAccountRows
  };
}
