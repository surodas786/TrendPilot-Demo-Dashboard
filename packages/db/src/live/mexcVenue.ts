import { Decimal } from '@trendpilot/domain';
import type { CloseResult, OpeningRequest, SimResult, VenueDiagnostics } from '../paper/simulator';
import type { CloseRequest, ExecutionVenue, ProtectionState } from '../venue/types';
import { MEXC_EXTERNAL_OID_MAX } from '../paper/clientOrderId';
import { codeRevision } from '../revision';
import { livePilotVerified, type CapabilityId, type CapabilityState } from './capabilities';
import { MexcPrivateError, normalizeDeals, normalizeOrder, normalizePositions, normalizeStops, TREND, trendToBasis, type MexcRequester, type NormalizedOrder, type NormalizedPosition, type NormalizedStop } from './mexcPrivate';

/**
 * MEXC Futures private adapter as an ExecutionVenue (Step 11). Reached only through
 * `venueForMode('LIVE')`, which is closed in this build, or by tests with a mocked exchange.
 *
 * Safety rules:
 *  - An order is never sent unless its capability is verified on a live pilot (capabilities.ts).
 *  - An opening order always carries its stop (stopLossPrice + lossTrend) in the same request.
 *  - The order builder follows the verified position mode (One-way or Hedge), read again from
 *    MEXC right before every order. If MEXC reports another mode, nothing is sent
 *    (POSITION_MODE_MISMATCH:<mode>): the mismatch is surfaced, never guessed around.
 *  - Hedge: positionMode 1, sides 1 open long / 3 open short / 4 close long / 2 close short, no
 *    reduceOnly (documented for One-way only); every close is bound to its MEXC positionId, so
 *    closing one leg never touches the other leg or its stop.
 *  - Closes are built by `buildMexcCloseOrder` only: matched to the exchange position (by its
 *    MEXC positionId when TrendPilot knows it), capped at what that position holds, with the
 *    documented close sides (4 close long / 2 close short), the position's own margin mode
 *    (openType) and positionId, the account's position mode read from MEXC right before sending,
 *    and reduceOnly in one-way mode. They cannot open exposure in the opposite direction. Closes
 *    are never refused for the position mode, so an existing Hedge position can still be closed.
 *  - After an uncertain submission (timeout, network error, 5xx) the adapter only looks the order
 *    up by client order ID; it never resends. Absence must be confirmed after a grace period
 *    before the execution flow may resubmit (reconcileGraceMs).
 */

export interface MexcVenueOptions {
  requester: MexcRequester;
  /** MEXC symbol (e.g. BTC_USDT) for a platform instrument. */
  symbolFor: (instrumentId: string) => Promise<string>;
  /** Verified with GET position_mode before the venue is built. */
  positionMode: 'HEDGE' | 'ONE_WAY';
  /** Live-pilot evidence; defaults to the registry (nothing verified → every order blocked). */
  capabilities?: CapabilityState;
  /** Polls after an accepted order until it is final. */
  confirm?: { attempts: number; delayMs: number };
  sleep?: (ms: number) => Promise<void>;
}

const MISSING_STOP = 'mexc-sl:missing';
/** Rejection prefix when MEXC reports another position mode than the verified one (`…:<MEXC mode>`). */
export const POSITION_MODE_MISMATCH = 'POSITION_MODE_MISMATCH';
/** @deprecated One-way is no longer required; kept for older callers. */
export const POSITION_MODE_REQUIRED = POSITION_MODE_MISMATCH;
/** MEXC position_mode → mode (1 Hedge, 2 One-way; anything else is unknown). */
export const positionModeOf = (raw: unknown): 'ONE_WAY' | 'HEDGE' | null => (Number(raw) === 2 ? 'ONE_WAY' : Number(raw) === 1 ? 'HEDGE' : null);
const stopRef = (id: string) => `mexc-sl:${id}`;
const stopIdOf = (ref: string) => ref.replace(/^mexc-sl:/, '');
const D = (v: Decimal.Value) => new Decimal(v);
/** Decimals sent to MEXC in canonical form (no trailing zeros from numeric columns). */
const num = (v: Decimal.Value) => new Decimal(v).toFixed();
const basisToTrend = (b: string | undefined | null) => (b === 'MARK' ? TREND.MARK : b === 'INDEX' ? TREND.INDEX : TREND.LAST);

/** The only order-create endpoint the adapter calls (opening and closing orders). */
export const MEXC_ORDER_CREATE_PATH = '/api/v1/private/order/create';

/* ───────────────────────── Close order builder (pure) ───────────────────────── */

export interface MexcCloseInput {
  symbol: string;
  clientOrderId: string;
  /** Side of the TrendPilot position being reduced. */
  positionSide: 'LONG' | 'SHORT';
  /** Account position mode as MEXC reports it right before sending. */
  accountMode: 'ONE_WAY' | 'HEDGE';
  /** The matched MEXC position (`frozen` = frozenVol: volume other orders already reserve). */
  exchangePosition: Pick<NormalizedPosition, 'positionId' | 'side' | 'contracts' | 'marginMode'> & { frozen?: string };
  /** Contracts the intent wants to close (capped here at the closable quantity, holdVol − frozenVol). */
  contracts: Decimal.Value;
  qtyStep: Decimal.Value;
  quote: { bid: string; ask: string };
}

export type MexcCloseBuild = { ok: true; vol: string; body: Record<string, unknown> } | { ok: false; reason: string; detail: string };

/**
 * The single place a MEXC close request is serialized (manual close, fixed / split / trailing
 * take profit, signal close, reversal, emergency close; Long and Short; one-way and hedge).
 * Documented mapping (place-order, read 2026-11-14): side 4 = close long, 2 = close short;
 * openType 1 isolated / 2 cross; positionMode 1 hedge / 2 one-way; reduceOnly applies only in
 * one-way mode. Open positions (read 2026-11-14): positionType 1 long / 2 short (the held
 * position, not an order side); openType 1 isolated / 2 cross; holdVol position size; frozenVol
 * frozen volume. `type` 5 is a market order; `price` is still a required field, so the executable
 * quote is sent (bid to close a long, ask to close a short). The side mapping is not changed without
 * MEXC confirmation (see docs/incidents/2026-11-14-mexc-2001-close.md).
 */
export function buildMexcCloseOrder(i: MexcCloseInput): MexcCloseBuild {
  const p = i.exchangePosition;
  if (p.side !== i.positionSide) return { ok: false, reason: 'CLOSE_POSITION_MISMATCH:SIDE', detail: `TrendPilot ${i.positionSide}, MEXC ${p.side}` };
  const positionId = Number(p.positionId);
  if (!Number.isSafeInteger(positionId) || positionId <= 0) return { ok: false, reason: 'CLOSE_POSITION_MISMATCH:POSITION_ID', detail: `MEXC positionId ${p.positionId}` };
  const step = new Decimal(i.qtyStep);
  const held = new Decimal(p.contracts);
  if (held.lte(0)) return { ok: false, reason: 'REDUCE_ONLY_NO_POSITION', detail: `MEXC holds ${p.contracts}` };
  // Closable = position size minus what other orders already reserve (frozenVol). A full close uses
  // exactly that; a partial close stays within it. Never more: a close can never open the other side.
  const closable = Decimal.max(0, held.minus(p.frozen ?? 0));
  if (closable.lte(0)) return { ok: false, reason: 'CLOSE_QTY_RESERVED', detail: `MEXC holds ${p.contracts}, all frozen by other orders (frozenVol ${p.frozen})` };
  const vol = Decimal.min(i.contracts, closable).div(step).floor().times(step);
  if (vol.lte(0)) return { ok: false, reason: 'REDUCE_ONLY_NO_POSITION', detail: `closable ${closable.toFixed()} below one quantity step` };
  const oneWay = i.accountMode === 'ONE_WAY';
  return {
    ok: true,
    vol: vol.toFixed(),
    body: {
      symbol: i.symbol,
      price: num(i.positionSide === 'LONG' ? i.quote.bid : i.quote.ask),
      vol: vol.toFixed(),
      side: i.positionSide === 'LONG' ? 4 : 2,
      type: 5,
      openType: p.marginMode === 'CROSS' ? 2 : 1,
      externalOid: i.clientOrderId,
      positionId,
      ...(oneWay ? { reduceOnly: true } : {}),
      positionMode: oneWay ? 2 : 1
    }
  };
}

/** The MEXC message without the path prefix and code suffix our transport adds. */
const mexcMessage = (e: MexcPrivateError) => e.message.replace(/^[^:]*:\s*/, '').replace(/\s*\(code -?\d+\)$/, '').slice(0, 200);

export class UncertainSubmissionError extends Error {
  constructor(readonly clientOrderId: string, cause: string) {
    super(`Submission ${clientOrderId} is uncertain (${cause}); it must be reconciled by client order ID before any retry.`);
    this.name = 'UncertainSubmissionError';
  }
}

export function mexcVenue(o: MexcVenueOptions): ExecutionVenue & { reconcileGraceMs: number; positionMode: 'HEDGE' | 'ONE_WAY' } {
  const sleep = o.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const confirm = o.confirm ?? { attempts: 5, delayMs: 400 };
  const verified = (c: CapabilityId) => livePilotVerified(c, o.capabilities);

  const getOrder = async (symbol: string, clientOrderId: string): Promise<NormalizedOrder | null> => {
    try {
      const data = await o.requester.request<Record<string, unknown> | null | undefined>('GET', `/api/v1/private/order/external/${symbol}/${clientOrderId}`);
      // MEXC also answers an unknown externalOid with success and no data (seen in production on
      // 13 Nov 2026), not only with code 2040. Both mean "no such order"; a retry still waits out
      // reconcileGraceMs before any resubmission, exactly as for 2040.
      if (data === null || data === undefined) return null;
      return normalizeOrder(data);
    } catch (e) {
      if (e instanceof MexcPrivateError && e.kind === 'API' && e.code === 2040) return null; // order does not exist
      throw e;
    }
  };

  /** Waits until the order is final (filled, canceled or invalid). Null = still not final. */
  const untilFinal = async (symbol: string, clientOrderId: string): Promise<NormalizedOrder | null> => {
    for (let i = 0; i < confirm.attempts; i++) {
      const ord = await getOrder(symbol, clientOrderId);
      if (ord && (ord.state === 'FILLED' || ord.state === 'CANCELLED' || ord.state === 'INVALID')) return ord;
      if (i < confirm.attempts - 1) await sleep(confirm.delayMs);
    }
    return null;
  };

  const fillOf = async (ord: NormalizedOrder) => {
    const deals = normalizeDeals(await o.requester.request('GET', `/api/v1/private/order/deal_details/${ord.orderId}`));
    const vol = deals.reduce((t, d) => t.plus(d.vol), D(0));
    // Deals are authoritative; the order summary is the fallback when deals are not yet listed.
    const contracts = vol.gt(0) ? vol : D(ord.dealVol);
    const price = vol.gt(0) ? deals.reduce((t, d) => t.plus(D(d.price).times(d.vol)), D(0)).div(vol) : D(ord.dealAvgPrice);
    const fee = deals.length ? deals.reduce((t, d) => t.plus(d.fee), D(0)) : D(ord.takerFee).plus(ord.makerFee);
    const at = deals.length ? Math.max(...deals.map((d) => d.timestamp)) : ord.updateTime;
    return { fillId: `mexc:${ord.orderId}`, contracts: contracts.toFixed(), price: price.toDecimalPlaces(12).toFixed(), fee: fee.toDecimalPlaces(8).toFixed(), filledAt: new Date(at || Date.now()) };
  };

  const stopsFor = async (symbol: string): Promise<NormalizedStop[]> => normalizeStops(await o.requester.request('GET', '/api/v1/private/stoporder/open_orders', { symbol }));

  type StopInfo = Extract<SimResult, { status: 'FILLED' }>['stop'];
  /** The stop MEXC attached to this order, or a "missing" marker that never verifies. */
  const attachedStop = async (symbol: string, ord: NormalizedOrder, side: 'LONG' | 'SHORT', expected: { price: string; basis: string }): Promise<StopInfo> => {
    const s = (await stopsFor(symbol)).find((x) => x.state === 'ACTIVE' && !x.reverse && x.stopLossPrice !== null && x.positionSide === side && (x.orderId === ord.orderId || D(x.stopLossPrice).eq(expected.price)));
    if (!s) return { orderId: MISSING_STOP, clientOrderId: MISSING_STOP, triggerPrice: expected.price, basis: expected.basis, contracts: '0', reduceOnly: true };
    return { orderId: stopRef(s.stopId), clientOrderId: stopRef(s.stopId), triggerPrice: s.stopLossPrice!, basis: s.basis, contracts: s.vol, reduceOnly: true };
  };

  const openResult = async (symbol: string, ord: NormalizedOrder, clientOrderId: string, side: 'LONG' | 'SHORT', stop: { price: string; basis: string }): Promise<SimResult> => {
    if (D(ord.dealVol).isZero() && ord.state !== 'FILLED') return { status: 'REJECTED', orderId: ord.orderId, clientOrderId, reason: `MEXC_ORDER_${ord.state}${ord.errorCode ? `_${ord.errorCode}` : ''}` };
    const fill = await fillOf(ord);
    return { status: 'FILLED', orderId: ord.orderId, clientOrderId, fill, stop: await attachedStop(symbol, ord, side, stop) };
  };

  const closeResult = (ord: NormalizedOrder, clientOrderId: string, requested: string, fill: Awaited<ReturnType<typeof fillOf>> | null): CloseResult => {
    if (!fill || D(fill.contracts).isZero()) return { status: 'REJECTED', orderId: ord.orderId, clientOrderId, reason: `MEXC_ORDER_${ord.state}${ord.errorCode ? `_${ord.errorCode}` : ''}` };
    return { status: D(fill.contracts).gte(requested) ? 'FILLED' : 'PARTIAL', orderId: ord.orderId, clientOrderId, requested, fill };
  };

  const positions = async (symbol: string) => normalizePositions(await o.requester.request('GET', '/api/v1/private/position/open_positions', { symbol })).filter((p) => p.open && D(p.contracts).gt(0));

  const CREATE = MEXC_ORDER_CREATE_PATH;
  type Sent = ({ accepted: true } | { rejected: string }) & { diagnostics: VenueDiagnostics };
  /** Sends an order; on an uncertain outcome only looks it up. Never resends. */
  const submit = async (symbol: string, clientOrderId: string, body: Record<string, unknown>, context?: Record<string, unknown>): Promise<Sent> => {
    const request = { method: 'POST', path: CREATE, body, ...(context ? { context } : {}) };
    // MEXC answers a longer externalOid with error 2030. Refuse locally so nothing is sent; an
    // older intent with a longer stored ID stays as it is and can still be looked up.
    if (clientOrderId.length > MEXC_EXTERNAL_OID_MAX) return { rejected: 'CLIENT_ORDER_ID_TOO_LONG', diagnostics: { request: null, response: { code: 'NOT_SENT', message: 'externalOid longer than 32 characters' } } };
    try {
      const data = await o.requester.request<unknown>('POST', CREATE, body);
      return { accepted: true, diagnostics: { request, response: { code: 0, message: data === undefined || data === null ? 'accepted' : `accepted ${JSON.stringify(data).slice(0, 120)}` } } };
    } catch (e) {
      if (e instanceof MexcPrivateError && !e.uncertain) return { rejected: `MEXC_${e.code ?? e.kind}`, diagnostics: { request, response: { code: e.code ?? e.kind, message: mexcMessage(e) } } };
      // Timeout / network / 5xx: MEXC may have accepted it. Reconcile instead of retrying.
      const found = await getOrder(symbol, clientOrderId).catch(() => null);
      if (found) return { accepted: true, diagnostics: { request, response: { code: 'UNCERTAIN_FOUND', message: (e as Error).message.slice(0, 200) } } };
      throw new UncertainSubmissionError(clientOrderId, (e as Error).message);
    }
  };

  return {
    kind: 'MEXC_PRIVATE',
    positionMode: o.positionMode,
    /** Absence of an uncertain order must be confirmed this long after submission before a resubmit. */
    reconcileGraceMs: 30_000,

    async placeOpeningOrderWithStop(r: OpeningRequest & { leverage?: number; marginMode?: 'ISOLATED' | 'CROSS' }): Promise<SimResult> {
      if (!r.stop) return { status: 'REJECTED', orderId: '', clientOrderId: r.clientOrderId, reason: 'STOP_REQUIRED' };
      if (!verified('OPEN_WITH_ATTACHED_STOP')) return { status: 'REJECTED', orderId: '', clientOrderId: r.clientOrderId, reason: 'CAPABILITY_UNVERIFIED:OPEN_WITH_ATTACHED_STOP' };
      if (!r.leverage) return { status: 'REJECTED', orderId: '', clientOrderId: r.clientOrderId, reason: 'LEVERAGE_REQUIRED' };
      const symbol = await o.symbolFor(r.instrumentId);
      const existing = await getOrder(symbol, r.clientOrderId);
      if (!existing) {
        // The account's mode can change at MEXC after it was verified: read it again before sending.
        const mode = positionModeOf(await o.requester.request<number>('GET', '/api/v1/private/position/position_mode'));
        if (mode !== o.positionMode) return { status: 'REJECTED', orderId: '', clientOrderId: r.clientOrderId, reason: `${POSITION_MODE_MISMATCH}:${mode ?? 'UNKNOWN'}` };
        const sent = await submit(symbol, r.clientOrderId, {
          symbol,
          price: num(r.side === 'LONG' ? r.quote.ask : r.quote.bid),
          vol: num(r.contracts),
          leverage: r.leverage,
          side: r.side === 'LONG' ? 1 : 3,
          type: 5,
          openType: r.marginMode === 'CROSS' ? 2 : 1,
          externalOid: r.clientOrderId,
          stopLossPrice: num(r.stop.price),
          lossTrend: basisToTrend(r.stop.basis),
          positionMode: o.positionMode === 'HEDGE' ? 1 : 2 // the verified mode, re-read above
        });
        if ('rejected' in sent) return { status: 'REJECTED', orderId: '', clientOrderId: r.clientOrderId, reason: sent.rejected };
      }
      const ord = await untilFinal(symbol, r.clientOrderId);
      if (!ord) throw new UncertainSubmissionError(r.clientOrderId, 'order not final after confirmation polling');
      return openResult(symbol, ord, r.clientOrderId, r.side, { price: r.stop.price, basis: r.stop.basis });
    },

    async lookupOrder(clientOrderId, instrumentId) {
      const symbol = await o.symbolFor(instrumentId);
      const ord = await getOrder(symbol, clientOrderId);
      if (!ord) return null;
      if (ord.state === 'PENDING' || ord.state === 'OPEN') throw new UncertainSubmissionError(clientOrderId, `order still ${ord.state}`);
      const side = ord.side === 3 ? 'SHORT' : 'LONG';
      const stops = await stopsFor(symbol);
      const s = stops.find((x) => x.state === 'ACTIVE' && x.stopLossPrice !== null && x.positionSide === side && x.orderId === ord.orderId);
      return openResult(symbol, ord, clientOrderId, side, { price: s?.stopLossPrice ?? '0', basis: s?.basis ?? 'LAST' });
    },

    async inspectProtection(stopOrderId, instrumentId): Promise<ProtectionState | null> {
      if (stopOrderId === MISSING_STOP) return null;
      const symbol = await o.symbolFor(instrumentId);
      const s = (await stopsFor(symbol)).find((x) => x.stopId === stopIdOf(stopOrderId));
      if (!s) return null;
      // A reversing stop would open the opposite side when it fires: not a close-only protection.
      return { status: s.state, side: s.positionSide === 'LONG' ? 'SHORT' : 'LONG', contracts: s.vol, triggerPrice: s.stopLossPrice, basis: s.basis, reduceOnly: !s.reverse };
    },

    async placeReduceOnlyClose(r: CloseRequest): Promise<CloseResult> {
      const reject = (reason: string, diagnostics?: VenueDiagnostics): CloseResult => ({ status: 'REJECTED', orderId: '', clientOrderId: r.clientOrderId, reason, ...(diagnostics ? { diagnostics } : {}) });
      const notSent = (reason: string, message: string) => reject(reason, { request: null, response: { code: 'NOT_SENT', message: message.slice(0, 200) } });
      if (!verified('REDUCE_ONLY_CLOSE')) return reject('CAPABILITY_UNVERIFIED:REDUCE_ONLY_CLOSE');
      const symbol = await o.symbolFor(r.instrumentId);
      // Same intent, same externalOid: an order MEXC already knows is reconciled, never resent.
      const existing = await getOrder(symbol, r.clientOrderId);
      let requested = r.contracts;
      let diagnostics: VenueDiagnostics | undefined;
      if (!existing) {
        const open = await positions(symbol);
        // Match the exchange position: by MEXC positionId when TrendPilot recorded it (a newer
        // position on the same symbol is never closed in its place), else the one on this side.
        let pos: NormalizedPosition | undefined;
        if (r.positionRef) {
          pos = open.find((p) => p.positionId === r.positionRef);
          if (!pos) return notSent('REDUCE_ONLY_NO_POSITION', `MEXC holds no position ${r.positionRef} on ${symbol}`);
        } else {
          const sameSide = open.filter((p) => p.side === r.positionSide);
          if (sameSide.length > 1) return notSent('CLOSE_POSITION_MISMATCH:AMBIGUOUS', `${sameSide.length} ${r.positionSide} positions on ${symbol}`);
          pos = sameSide[0];
          if (!pos) return notSent('REDUCE_ONLY_NO_POSITION', `MEXC holds no ${r.positionSide} on ${symbol}${open[0] ? ` (it holds ${open[0].side} ${open[0].contracts})` : ''}`);
        }
        // The account's mode can change at MEXC after it was verified: read it again before sending.
        const modeRaw = Number(await o.requester.request<number>('GET', '/api/v1/private/position/position_mode'));
        const fresh = positionModeOf(modeRaw);
        // The builder follows the verified mode; a different mode at MEXC is surfaced, nothing is sent.
        if (fresh !== o.positionMode) return notSent(`${POSITION_MODE_MISMATCH}:${fresh ?? 'UNKNOWN'}`, `MEXC reports position mode ${modeRaw}, TrendPilot verified ${o.positionMode}`);
        const accountMode = o.positionMode;
        // Exchange evidence kept with the request. positionType (held position), positionMode
        // (account) and side (order) are separate fields even where their numbers coincide.
        const context = { revision: codeRevision(), positionModeRaw: modeRaw, accountMode, position: { positionId: pos.positionId, positionType: pos.side === 'SHORT' ? 2 : 1, openType: pos.marginMode === 'CROSS' ? 2 : 1, holdVol: pos.contracts, frozenVol: pos.frozen }, requestedContracts: D(r.contracts).toFixed() };
        const built = buildMexcCloseOrder({ symbol, clientOrderId: r.clientOrderId, positionSide: r.positionSide, accountMode, exchangePosition: pos, contracts: r.contracts, qtyStep: r.contract.qtyStep, quote: r.quote });
        if (!built.ok) return reject(built.reason, { request: { method: 'NOT_SENT', path: CREATE, body: {}, context }, response: { code: 'NOT_SENT', message: built.detail.slice(0, 200) } });
        requested = built.vol;
        const sent = await submit(symbol, r.clientOrderId, built.body, context);
        diagnostics = sent.diagnostics;
        if ('rejected' in sent) return reject(sent.rejected, sent.diagnostics);
      } else {
        requested = existing.vol;
      }
      const ord = await untilFinal(symbol, r.clientOrderId);
      if (!ord) throw new UncertainSubmissionError(r.clientOrderId, 'close not final after confirmation polling');
      const res = closeResult(ord, r.clientOrderId, requested, D(ord.dealVol).gt(0) || ord.state === 'FILLED' ? await fillOf(ord) : null);
      if (!diagnostics) return res;
      // Confirm with a fresh position read (order status and fills are above); best effort, evidence only.
      const after = await positions(symbol)
        .then((open) => {
          const m = (r.positionRef ? open.find((p) => p.positionId === r.positionRef) : undefined) ?? open.find((p) => p.side === r.positionSide);
          return m ? m.contracts : '0';
        })
        .catch(() => null);
      return { ...res, diagnostics: { ...diagnostics, response: { code: diagnostics.response?.code ?? null, message: diagnostics.response?.message ?? null, positionAfter: after } } };
    },

    async lookupCloseOrder(clientOrderId, instrumentId) {
      const symbol = await o.symbolFor(instrumentId);
      const ord = await getOrder(symbol, clientOrderId);
      if (!ord) return null;
      if (ord.state === 'PENDING' || ord.state === 'OPEN') throw new UncertainSubmissionError(clientOrderId, `close still ${ord.state}`);
      return closeResult(ord, clientOrderId, ord.vol, D(ord.dealVol).gt(0) || ord.state === 'FILLED' ? await fillOf(ord) : null);
    },

    async resizeProtection(stopOrderId, contracts, instrumentId) {
      const symbol = await o.symbolFor(instrumentId);
      const s = (await stopsFor(symbol)).find((x) => x.stopId === stopIdOf(stopOrderId));
      if (!s) throw new MexcPrivateError(`stop ${stopOrderId} not found at MEXC`, 'API', 2040);
      // Some venues shrink a position stop automatically: nothing to do then.
      if (D(s.vol).eq(contracts)) return stopOrderId;
      if (!verified('STOP_RESIZE_AFTER_PARTIAL_CLOSE')) throw new MexcPrivateError('stop resize is not verified on a live pilot; the position stays flagged until reviewed', 'REFUSED');
      // Cancel, then re-place for exactly the remainder at the SAME trigger (never widened).
      await o.requester.request('POST', '/api/v1/private/stoporder/cancel', { orders: [{ stopPlanOrderId: Number(s.stopId) }] });
      const id = await o.requester.request<string | number>('POST', '/api/v1/private/stoporder/place', {
        positionId: Number(s.positionId),
        vol: num(contracts),
        volType: 1,
        stopLossPrice: s.stopLossPrice,
        lossTrend: basisToTrend(s.basis),
        profitTrend: TREND.LAST,
        // Market stop that only closes: never reverse into the opposite side (docs 2026-11).
        stopLossType: 0,
        stopLossOrderPrice: s.stopLossPrice,
        stopLossReverse: 2,
        takeProfitType: 0,
        takeProfitReverse: 2
      });
      return stopRef(String(id));
    },

    async cancelOrder(orderId) {
      if (!orderId.startsWith('mexc-sl:') || orderId === MISSING_STOP) return;
      await o.requester.request('POST', '/api/v1/private/stoporder/cancel', { orders: [{ stopPlanOrderId: Number(stopIdOf(orderId)) }] });
    },

    async position(_account, instrumentId, _tx, side) {
      const symbol = await o.symbolFor(instrumentId);
      const open = await positions(symbol);
      // Hedge: one leg per side. A caller that names its side gets exactly that leg.
      if (side) {
        const leg = open.filter((p) => p.side === side).reduce((t, p) => t.plus(p.contracts), D(0));
        return { side: leg.gt(0) ? side : null, contracts: leg.toFixed() };
      }
      if (open.length > 1) throw new MexcPrivateError(`${symbol}: both a Long and a Short are open at MEXC (Hedge legs); name the side to read one leg`, 'REFUSED');
      return open[0] ? { side: open[0].side, contracts: open[0].contracts } : { side: null, contracts: '0' };
    },

    async stopOrderIdFor(ref) {
      return ref.startsWith('mexc-sl:') && ref !== MISSING_STOP ? ref : null;
    }
  };
}

/** Exposed for tests and the read-only check. */
export { trendToBasis };
