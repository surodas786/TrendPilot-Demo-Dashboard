// Stateful mock of the MEXC Futures private API (Step 11), modelled on the documented endpoints.
// It implements MexcRequester, so the real adapter, signing-free, runs against it. Faults are
// injected per test: missing/invalid attached stops, partial fills, timeouts before or after
// acceptance, duplicate deal records, delayed visibility of a new order, API rejections.
import { Decimal } from '@trendpilot/domain';
import { MexcPrivateError, type MexcRequester } from '@trendpilot/db';

const D = (v: Decimal.Value) => new Decimal(v);

interface MockOrder {
  orderId: number;
  externalOid: string;
  symbol: string;
  side: number;
  vol: string;
  dealVol: string;
  dealAvgPrice: string;
  state: number;
  takerFee: string;
  createTime: number;
}
interface MockStop {
  id: number;
  orderId: number;
  positionId: number;
  symbol: string;
  positionType: 1 | 2;
  stopLossPrice: string;
  lossTrend: number;
  vol: string;
  state: number;
}
interface MockPosition {
  positionId: number;
  symbol: string;
  positionType: 1 | 2;
  holdVol: string;
  holdAvgPrice: string;
  leverage: number;
  openType: number;
}

export interface MockFaults {
  /** Attached stop on the next opening order: created, missing, or created then failed. */
  attachStop: 'yes' | 'missing' | 'failed';
  /** Fraction of the next order that fills (the rest is cancelled, IOC-like). */
  fillRatio: number;
  /** Next create: accepted and executed, but the response times out. */
  timeoutAfterAccept: number;
  /** Next create: times out before MEXC receives it. */
  timeoutBeforeAccept: number;
  /** Next create: rejected with this API code. */
  rejectCode: number | null;
  /** Lookups by externalOid that still return "order not exist" after acceptance. */
  invisibleLookups: number;
  /** Every deal is listed twice (re-delivered record). */
  duplicateDeals: boolean;
  /** A position stop shrinks with the position automatically after a partial close. */
  stopAutoShrink: boolean;
  /** Lookups fail with a network error. */
  lookupNetworkError: boolean;
  /** Lookups start failing right after the next order is accepted. */
  lookupFailsAfterAccept: boolean;
  /** Read paths (prefix match) that fail with a network error, e.g. the deal history. */
  failingReads: string[];
}

export class MockMexc implements MexcRequester {
  price: Record<string, string> = { BTC_USDT: '65000' };
  positionMode: 1 | 2 = 1;
  /**
   * How an unknown externalOid is answered. 'EMPTY_DATA' is what production MEXC returned on
   * 13 Nov 2026 (success, code 0, no data); 'ERROR_2040' is the documented "order not exist".
   */
  missingOrder: 'ERROR_2040' | 'EMPTY_DATA' = 'ERROR_2040';
  orders = new Map<string, MockOrder>();
  deals = new Map<number, { id: number; orderId: number; symbol: string; side: number; vol: string; price: string; fee: string; timestamp: number; profit?: string }[]>();
  stops = new Map<number, MockStop>();
  positions = new Map<string, MockPosition>();
  calls: { method: string; path: string; body?: unknown }[] = [];
  /** USDT account figures returned by account/assets. */
  assets = { equity: '1000', availableOpen: '1000', unrealized: '0' };
  /** Cumulative funding per position (holdFee) and liquidation price returned by open_positions. */
  holdFee = '0';
  liquidatePrice = '0';
  faults: MockFaults = this.defaults();
  /** Exchange clock (ms). Tests on a fixed signal clock drive it from that clock. */
  now: () => number = () => Date.now();
  /** Orders whose deals MEXC has not listed yet (delayed in deal history and order details). */
  delayedDeals = new Set<number>();
  private seq = 1000;
  private invisible = new Map<string, number>();

  defaults(): MockFaults {
    return { attachStop: 'yes', fillRatio: 1, timeoutAfterAccept: 0, timeoutBeforeAccept: 0, rejectCode: null, invisibleLookups: 0, duplicateDeals: false, stopAutoShrink: false, lookupNetworkError: false, lookupFailsAfterAccept: false, failingReads: [] };
  }
  reset() {
    this.faults = this.defaults();
    this.calls = [];
  }
  creates = () => this.calls.filter((c) => c.path === '/api/v1/private/order/create');

  async request<T>(method: 'GET' | 'POST', path: string, params: Record<string, unknown> | unknown[] | null = null): Promise<T> {
    this.calls.push({ method, path, body: params ?? undefined });
    if (method === 'GET' && this.faults.failingReads.some((f) => path.startsWith(f))) throw new MexcPrivateError(`GET ${path}: network error`, 'NETWORK');
    if (method === 'GET' && path.startsWith('/api/v1/private/order/get/')) {
      const o = [...this.orders.values()].find((x) => x.orderId === Number(path.split('/').pop()));
      if (!o) throw new MexcPrivateError(`${path}: order not exist (code 2040)`, 'API', 2040);
      return { ...o, leverage: 10, openType: 1, makerFee: '0', errorCode: 0, updateTime: o.createTime } as T;
    }
    if (method === 'POST' && path === '/api/v1/private/order/create') return this.create(params as Record<string, unknown>) as T;
    if (method === 'GET' && path.startsWith('/api/v1/private/order/external/')) return this.lookup(path) as T;
    if (method === 'GET' && path.startsWith('/api/v1/private/order/deal_details/')) {
      const id = Number(path.split('/').pop());
      const list = this.delayedDeals.has(id) ? [] : (this.deals.get(id) ?? []);
      return (this.faults.duplicateDeals ? [...list, ...list] : list) as T;
    }
    if (method === 'GET' && path === '/api/v1/private/stoporder/open_orders') return [...this.stops.values()].filter((s) => s.state === 1 || s.state === 5) as T;
    if (method === 'GET' && path === '/api/v1/private/position/open_positions')
      return [...this.positions.values()].filter((p) => D(p.holdVol).gt(0)).map((p) => ({ ...p, state: 1, openAvgPrice: p.holdAvgPrice, holdFee: this.holdFee, liquidatePrice: this.liquidatePrice })) as T;
    if (method === 'GET' && path === '/api/v1/private/account/assets')
      return [{ currency: 'USDT', equity: this.assets.equity, availableBalance: this.assets.availableOpen, availableOpen: this.assets.availableOpen, positionMargin: '0', frozenBalance: '0', unrealized: this.assets.unrealized, bonus: '0' }] as T;
    if (method === 'GET' && path === '/api/v1/private/order/list/order_deals/v3') {
      const sym = (params as Record<string, unknown> | null)?.symbol;
      return [...this.deals.values()].flat().filter((d) => (!sym || d.symbol === sym) && !this.delayedDeals.has(d.orderId)) as T;
    }
    if (method === 'GET' && path === '/api/v1/private/position/position_mode') return this.positionMode as T;
    if (method === 'POST' && path === '/api/v1/private/stoporder/cancel') {
      for (const o of (params as { orders: { stopPlanOrderId: number }[] }).orders) {
        const s = this.stops.get(o.stopPlanOrderId);
        // Like an exchange: a stop that already fired or was cancelled cannot be cancelled again.
        if (!s || s.state !== 1) throw new MexcPrivateError('stoporder/cancel: order state cannot be cancelled', 'API', 2041);
        s.state = 2;
      }
      return undefined as T;
    }
    if (method === 'POST' && path === '/api/v1/private/stoporder/place') return this.placeStop(params as Record<string, unknown>) as T;
    throw new MexcPrivateError(`mock: unsupported ${method} ${path}`, 'API', 404);
  }

  private lookup(path: string) {
    if (this.faults.lookupNetworkError) throw new MexcPrivateError(`GET ${path}: network error`, 'NETWORK');
    const ext = decodeURIComponent(path.split('/').pop()!);
    const left = this.invisible.get(ext) ?? 0;
    const o = this.orders.get(ext);
    if (!o || left > 0) {
      if (left > 0) this.invisible.set(ext, left - 1);
      if (this.missingOrder === 'EMPTY_DATA') return undefined;
      throw new MexcPrivateError(`${path}: order not exist (code 2040)`, 'API', 2040);
    }
    return { ...o, leverage: 10, openType: 1, makerFee: '0', profit: '0', feeCurrency: 'USDT', category: 1, orderType: 5, errorCode: 0, updateTime: o.createTime };
  }

  private create(b: Record<string, unknown>) {
    if (this.faults.timeoutBeforeAccept > 0) {
      this.faults.timeoutBeforeAccept -= 1;
      throw new MexcPrivateError('POST /api/v1/private/order/create: timed out', 'TIMEOUT');
    }
    if (this.faults.rejectCode) {
      const code = this.faults.rejectCode;
      this.faults.rejectCode = null;
      throw new MexcPrivateError(`/api/v1/private/order/create: rejected (code ${code})`, 'API', code);
    }
    const ext = String(b.externalOid);
    // Production MEXC rejects an externalOid over 32 characters with code 2030 (13 Nov 2026).
    if (ext.length > 32) throw new MexcPrivateError('/api/v1/private/order/create: rejected (code 2030)', 'API', 2030);
    if (this.orders.has(ext)) throw new MexcPrivateError('mock: DUPLICATE externalOid submitted', 'API', 9999);
    const symbol = String(b.symbol);
    const side = Number(b.side);
    const opening = side === 1 || side === 3;
    const posType: 1 | 2 = side === 1 || side === 4 ? 1 : 2;
    const key = `${symbol}:${posType}`;
    const pos = this.positions.get(key);
    const px = this.price[symbol]!;
    const id = this.seq++;
    const vol = D(String(b.vol));
    if (!opening) {
      const closable = pos ? D(pos.holdVol) : D(0);
      if (vol.gt(closable)) throw new MexcPrivateError('/api/v1/private/order/create: insufficient closable position (code 2008)', 'API', 2008);
    }
    if (opening && !b.stopLossPrice) throw new MexcPrivateError('mock: opening order without stopLossPrice', 'API', 5001);
    const filled = vol.times(this.faults.fillRatio).floor();
    this.faults.fillRatio = 1;
    const fee = filled.times('0.0001').times(px).times('0.0004').toDecimalPlaces(8);
    const order: MockOrder = { orderId: id, externalOid: ext, symbol, side, vol: vol.toFixed(), dealVol: filled.toFixed(), dealAvgPrice: filled.gt(0) ? px : '0', state: filled.eq(vol) ? 3 : 4, takerFee: fee.toFixed(), createTime: this.now() };
    this.orders.set(ext, order);
    if (filled.gt(0)) this.deals.set(id, [{ id: id * 10 + 1, orderId: id, symbol, side, vol: filled.toFixed(), price: px, fee: fee.toFixed(), timestamp: this.now() }]);
    if (this.faults.invisibleLookups) {
      this.invisible.set(ext, this.faults.invisibleLookups);
      this.faults.invisibleLookups = 0;
    }
    if (filled.gt(0)) {
      if (opening) {
        const p: MockPosition = pos ?? { positionId: this.seq++, symbol, positionType: posType, holdVol: '0', holdAvgPrice: px, leverage: Number(b.leverage ?? 1), openType: Number(b.openType) };
        p.holdVol = D(p.holdVol).plus(filled).toFixed();
        this.positions.set(key, p);
        if (this.faults.attachStop !== 'missing') {
          const sid = this.seq++;
          this.stops.set(sid, { id: sid, orderId: id, positionId: p.positionId, symbol, positionType: posType, stopLossPrice: String(b.stopLossPrice), lossTrend: Number(b.lossTrend ?? 1), vol: filled.toFixed(), state: this.faults.attachStop === 'failed' ? 5 : 1 });
        }
        this.faults.attachStop = 'yes';
      } else {
        pos!.holdVol = D(pos!.holdVol).minus(filled).toFixed();
        for (const s of this.stops.values()) {
          if (s.positionId !== pos!.positionId || s.state !== 1) continue;
          if (D(pos!.holdVol).isZero()) s.state = 2;
          else if (this.faults.stopAutoShrink) s.vol = Decimal.min(s.vol, pos!.holdVol).toFixed();
        }
      }
    }
    if (this.faults.lookupFailsAfterAccept) {
      this.faults.lookupFailsAfterAccept = false;
      this.faults.lookupNetworkError = true;
    }
    if (this.faults.timeoutAfterAccept > 0) {
      this.faults.timeoutAfterAccept -= 1;
      throw new MexcPrivateError('POST /api/v1/private/order/create: timed out', 'TIMEOUT');
    }
    return { orderId: String(id), ts: this.now() };
  }

  /** The exchange triggers a resting stop: the position closes at `price` outside TrendPilot. */
  triggerStop(stopId: number, price: string) {
    const st = this.stops.get(stopId);
    if (!st || st.state !== 1) throw new Error('mock: stop not active');
    const pos = [...this.positions.values()].find((p) => p.positionId === st.positionId)!;
    const vol = Decimal.min(st.vol, pos.holdVol);
    const id = this.seq++;
    const side = st.positionType === 1 ? 4 : 2;
    const fee = vol.times('0.0001').times(price).times('0.0004').toDecimalPlaces(8);
    this.orders.set(`stop-${id}`, { orderId: id, externalOid: `stop-${id}`, symbol: st.symbol, side, vol: vol.toFixed(), dealVol: vol.toFixed(), dealAvgPrice: price, state: 3, takerFee: fee.toFixed(), createTime: this.now() });
    this.deals.set(id, [{ id: id * 10 + 1, orderId: id, symbol: st.symbol, side, vol: vol.toFixed(), price, fee: fee.toFixed(), timestamp: this.now() }]);
    pos.holdVol = D(pos.holdVol).minus(vol).toFixed();
    st.state = 3;
    return id;
  }

  /**
   * A manual close on the MEXC web UI (no externalOid from TrendPilot). `fee` and `profit` are
   * MEXC's own figures for the deal (profit omitted when undefined). Returns the MEXC order ID.
   */
  manualClose(symbol: string, positionType: 1 | 2, vol: string, price: string, o: { fee?: string; profit?: string; delayed?: boolean } = {}) {
    const pos = this.positions.get(`${symbol}:${positionType}`)!;
    const id = this.seq++;
    const side = positionType === 1 ? 4 : 2;
    const fee = o.fee ?? '0';
    this.orders.set(`web-${id}`, { orderId: id, externalOid: `web-${id}`, symbol, side, vol, dealVol: vol, dealAvgPrice: price, state: 3, takerFee: fee, createTime: this.now() });
    this.deals.set(id, [{ id: id * 10 + 1, orderId: id, symbol, side, vol, price, fee, timestamp: this.now(), ...(o.profit !== undefined ? { profit: o.profit } : {}) }]);
    if (o.delayed) this.delayedDeals.add(id);
    pos.holdVol = D(pos.holdVol).minus(vol).toFixed();
    for (const s of this.stops.values()) {
      if (s.positionId !== pos.positionId || s.state !== 1) continue;
      if (D(pos.holdVol).isZero()) s.state = 2;
      else if (this.faults.stopAutoShrink) s.vol = Decimal.min(s.vol, pos.holdVol).toFixed();
    }
    return id;
  }

  /** Exposure opened directly on MEXC (unknown to TrendPilot). */
  externalOpen(symbol: string, positionType: 1 | 2, vol: string, price: string) {
    const key = `${symbol}:${positionType}`;
    const p = this.positions.get(key) ?? { positionId: this.seq++, symbol, positionType, holdVol: '0', holdAvgPrice: price, leverage: 5, openType: 1 };
    p.holdVol = D(p.holdVol).plus(vol).toFixed();
    this.positions.set(key, p);
  }

  private placeStop(b: Record<string, unknown>) {
    const pos = [...this.positions.values()].find((p) => p.positionId === Number(b.positionId));
    if (!pos) throw new MexcPrivateError('stoporder/place: position not exist (code 2009)', 'API', 2009);
    const active = [...this.stops.values()].filter((s) => s.positionId === pos.positionId && s.state === 1).reduce((t, s) => t.plus(s.vol), D(0));
    if (active.plus(String(b.vol)).gt(pos.holdVol)) throw new MexcPrivateError('stoporder/place: exceeds closable quantity', 'API', 2008);
    const sid = this.seq++;
    this.stops.set(sid, { id: sid, orderId: 0, positionId: pos.positionId, symbol: pos.symbol, positionType: pos.positionType, stopLossPrice: String(b.stopLossPrice), lossTrend: Number(b.lossTrend), vol: String(b.vol), state: 1 });
    return sid;
  }
}
