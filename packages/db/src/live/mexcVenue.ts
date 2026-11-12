import { Decimal } from '@trendpilot/domain';
import type { CloseResult, OpeningRequest, SimResult } from '../paper/simulator';
import type { CloseRequest, ExecutionVenue, ProtectionState } from '../venue/types';
import { livePilotVerified, type CapabilityId, type CapabilityState } from './capabilities';
import { MexcPrivateError, normalizeDeals, normalizeOrder, normalizePositions, normalizeStops, TREND, trendToBasis, type MexcRequester, type NormalizedOrder, type NormalizedStop } from './mexcPrivate';

/**
 * MEXC Futures private adapter as an ExecutionVenue (Step 11). Reached only through
 * `venueForMode('LIVE')`, which is closed in this build, or by tests with a mocked exchange.
 *
 * Safety rules:
 *  - An order is never sent unless its capability is verified on a live pilot (capabilities.ts).
 *  - An opening order always carries its stop (stopLossPrice + lossTrend) in the same request.
 *  - Closes are capped at the venue position on that side and use the close sides (4 / 2), plus
 *    reduceOnly in one-way mode, so they cannot open exposure in the opposite direction.
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
const stopRef = (id: string) => `mexc-sl:${id}`;
const stopIdOf = (ref: string) => ref.replace(/^mexc-sl:/, '');
const D = (v: Decimal.Value) => new Decimal(v);
/** Decimals sent to MEXC in canonical form (no trailing zeros from numeric columns). */
const num = (v: Decimal.Value) => new Decimal(v).toFixed();
const basisToTrend = (b: string | undefined | null) => (b === 'MARK' ? TREND.MARK : b === 'INDEX' ? TREND.INDEX : TREND.LAST);

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
      return normalizeOrder(await o.requester.request<Record<string, unknown>>('GET', `/api/v1/private/order/external/${symbol}/${clientOrderId}`));
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

  /** Sends an order; on an uncertain outcome only looks it up. Never resends. */
  const submit = async (symbol: string, clientOrderId: string, body: Record<string, unknown>): Promise<{ accepted: true } | { rejected: string }> => {
    try {
      await o.requester.request('POST', '/api/v1/private/order/create', body);
      return { accepted: true };
    } catch (e) {
      if (e instanceof MexcPrivateError && !e.uncertain) return { rejected: `MEXC_${e.code ?? e.kind}` };
      // Timeout / network / 5xx: MEXC may have accepted it. Reconcile instead of retrying.
      const found = await getOrder(symbol, clientOrderId).catch(() => null);
      if (found) return { accepted: true };
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
          positionMode: o.positionMode === 'HEDGE' ? 1 : 2
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
      if (!verified('REDUCE_ONLY_CLOSE')) return { status: 'REJECTED', orderId: '', clientOrderId: r.clientOrderId, reason: 'CAPABILITY_UNVERIFIED:REDUCE_ONLY_CLOSE' };
      const symbol = await o.symbolFor(r.instrumentId);
      const existing = await getOrder(symbol, r.clientOrderId);
      let requested = r.contracts;
      if (!existing) {
        const pos = (await positions(symbol)).find((p) => p.side === r.positionSide);
        const venueQty = pos ? D(pos.contracts) : D(0);
        if (venueQty.isZero()) return { status: 'REJECTED', orderId: '', clientOrderId: r.clientOrderId, reason: 'REDUCE_ONLY_NO_POSITION' };
        // Never more than the venue holds on this side: a close can never open the other side.
        const vol = Decimal.min(r.contracts, venueQty).div(r.contract.qtyStep).floor().times(r.contract.qtyStep);
        if (vol.lte(0)) return { status: 'REJECTED', orderId: '', clientOrderId: r.clientOrderId, reason: 'REDUCE_ONLY_NO_POSITION' };
        requested = vol.toFixed();
        const sent = await submit(symbol, r.clientOrderId, {
          symbol,
          price: num(r.positionSide === 'LONG' ? r.quote.bid : r.quote.ask),
          vol: requested,
          side: r.positionSide === 'LONG' ? 4 : 2,
          type: 5,
          openType: r.marginMode === 'CROSS' ? 2 : 1,
          externalOid: r.clientOrderId,
          positionId: pos ? Number(pos.positionId) : undefined,
          ...(o.positionMode === 'ONE_WAY' ? { reduceOnly: true } : {}),
          positionMode: o.positionMode === 'HEDGE' ? 1 : 2
        });
        if ('rejected' in sent) return { status: 'REJECTED', orderId: '', clientOrderId: r.clientOrderId, reason: sent.rejected };
      } else {
        requested = existing.vol;
      }
      const ord = await untilFinal(symbol, r.clientOrderId);
      if (!ord) throw new UncertainSubmissionError(r.clientOrderId, 'close not final after confirmation polling');
      return closeResult(ord, r.clientOrderId, requested, D(ord.dealVol).gt(0) || ord.state === 'FILLED' ? await fillOf(ord) : null);
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

    async position(_account, instrumentId) {
      const symbol = await o.symbolFor(instrumentId);
      const open = await positions(symbol);
      if (open.length > 1) throw new MexcPrivateError(`${symbol}: both a Long and a Short are open at MEXC (hedge mode); one-way exposure per contract is required`, 'REFUSED');
      return open[0] ? { side: open[0].side, contracts: open[0].contracts } : { side: null, contracts: '0' };
    },

    async stopOrderIdFor(ref) {
      return ref.startsWith('mexc-sl:') && ref !== MISSING_STOP ? ref : null;
    }
  };
}

/** Exposed for tests and the read-only check. */
export { trendToBasis };
