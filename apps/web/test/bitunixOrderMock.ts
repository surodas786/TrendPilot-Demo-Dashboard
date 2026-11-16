// Stateful mock of Bitunix order placement (Step 3) on top of the read mock: Hedge-mode legs (one
// Long and one Short position per symbol), place_order with the documented side/tradeSide/positionId
// mapping, attached position TP/SL, fills in trade history, get_order_detail by clientId, and
// trading_settings. Faults are injected per test: partial fills, missing or late protection,
// timeouts before or after acceptance, duplicate client IDs, rejection codes.
import { Decimal } from '@trendpilot/domain';
import { BitunixPrivateError, type BitunixOrderRequester } from '@trendpilot/db';
import { MockBitunix } from './bitunixMock';

const D = (v: Decimal.Value) => new Decimal(v);

export interface MockOrder {
  orderId: string;
  clientId: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  tradeSide: 'OPEN' | 'CLOSE';
  orderType: string;
  qty: string;
  tradeQty: string;
  price: string;
  status: string;
  positionId?: string;
  slPrice?: string;
  slStopType?: string;
  ctime: number;
  mtime: number;
}

export class MockBitunixExchange extends MockBitunix implements BitunixOrderRequester {
  orders = new Map<string, MockOrder>(); // by clientId
  posts: Record<string, unknown>[] = [];
  settings: Record<string, { marginMode: string; longLeverage: number; shortLeverage: number }> = {};
  fillPrice: Record<string, string> = { BTCUSDT: '64000', XAUUSDT: '3866.2' };
  /** Next placement: fill fraction (1 = full, 0 = none), TP/SL attach (NO / LATE n reads), outcome. */
  next: { fillFraction?: string; attachStop?: 'YES' | 'NO'; stopVisibleAfterReads?: number; timeout?: 'BEFORE_ACCEPT' | 'AFTER_ACCEPT'; rejectCode?: number; duplicate?: boolean } = {};
  /** Exchange clock (tests set it to their own clock). */
  nowMs: () => number = Date.now;
  private seq = 1;
  private tpslReads = 0;
  private hiddenTpsl: Record<string, unknown>[] = [];

  override reset(): void {
    super.reset();
    this.orders.clear();
    this.posts = [];
    this.settings = {};
    this.next = {};
    this.tpslReads = 0;
    this.hiddenTpsl = [];
  }

  setSettings(symbol: string, s: { marginMode?: string; longLeverage?: number; shortLeverage?: number } = {}): void {
    this.settings[symbol] = { marginMode: s.marginMode ?? 'ISOLATION', longLeverage: s.longLeverage ?? 10, shortLeverage: s.shortLeverage ?? 10 };
  }

  legOf(symbol: string, side: 'LONG' | 'SHORT') {
    return [...this.positions.values()].find((p) => p.symbol === symbol && p.side === side);
  }

  override async get<T>(path: string, params: Record<string, unknown> = {}): Promise<T> {
    switch (path) {
      case '/api/v1/futures/account/trading_settings': {
        this.calls.push({ path, params });
        const syms = String(params.symbols ?? '').split(',').filter(Boolean);
        return syms.filter((s) => this.settings[s]).map((s) => ({ symbol: s, marginCoin: 'USDT', leverage: this.settings[s]!.longLeverage, ...this.settings[s] })) as T;
      }
      case '/api/v1/futures/trade/get_order_detail': {
        this.calls.push({ path, params });
        const o = params.clientId ? this.orders.get(String(params.clientId)) : [...this.orders.values()].find((x) => x.orderId === params.orderId);
        if (!o) throw new BitunixPrivateError('GET get_order_detail: Order not found, please try it later (code 20007)', 'API', 20007);
        const { tradeSide: _t, positionId: _p, ...rest } = o;
        return { ...rest, positionMode: this.mode, marginMode: 'ISOLATION', leverage: 10, effect: 'GTC', reduceOnly: false, fee: '0.01' } as T;
      }
      case '/api/v1/futures/trade/get_history_trades':
        if (params.orderId) {
          this.calls.push({ path, params });
          const rows = this.trades.filter((t) => t.orderId === params.orderId);
          return { tradeList: rows, total: rows.length } as T;
        }
        return super.get<T>(path, params);
      case '/api/v1/futures/tpsl/get_pending_orders':
        // Late protection: the attached TP/SL becomes visible only after N reads.
        if (this.hiddenTpsl.length && ++this.tpslReads >= (this.next.stopVisibleAfterReads ?? 0)) {
          this.tpsl.push(...this.hiddenTpsl);
          this.hiddenTpsl = [];
        }
        return super.get<T>(path, params);
      default:
        return super.get<T>(path, params);
    }
  }

  async post<T>(path: string, body: Record<string, unknown>): Promise<T> {
    if (path !== '/api/v1/futures/trade/place_order') throw new BitunixPrivateError(`mock: unexpected POST ${path}`, 'REFUSED');
    this.posts.push(body);
    const n = this.next;
    this.next = {};
    if (n.timeout === 'BEFORE_ACCEPT') throw new BitunixPrivateError('POST place_order: timed out', 'TIMEOUT');
    if (n.rejectCode) throw new BitunixPrivateError(`POST place_order: rejected (code ${n.rejectCode})`, 'API', n.rejectCode);
    const clientId = String(body.clientId);
    if (this.orders.has(clientId)) throw new BitunixPrivateError('POST place_order: Client ID duplicate (code 30042)', 'API', 30042);
    const symbol = String(body.symbol);
    const side = body.side as 'BUY' | 'SELL';
    const tradeSide = body.tradeSide as 'OPEN' | 'CLOSE';
    if (this.mode === 'HEDGE' && tradeSide !== 'OPEN' && tradeSide !== 'CLOSE') throw new BitunixPrivateError('tradeSide required (code 10002)', 'API', 10002);
    const now = this.nowMs();
    const price = this.fillPrice[symbol] ?? '1';
    const order: MockOrder = { orderId: String(900_000_000_000 + this.seq++), clientId, symbol, side, tradeSide, orderType: String(body.orderType), qty: String(body.qty), tradeQty: '0', price, status: 'NEW', ctime: now, mtime: now };
    // Documented hedge mapping: open long BUY+OPEN, open short SELL+OPEN, close long BUY+CLOSE, close short SELL+CLOSE.
    const legSide: 'LONG' | 'SHORT' = side === 'BUY' ? 'LONG' : 'SHORT';
    if (tradeSide === 'CLOSE') {
      const pos = this.positions.get(String(body.positionId));
      if (!pos || pos.side !== legSide) throw new BitunixPrivateError('POST place_order: Position not exist (code 30004)', 'API', 30004);
      order.positionId = pos.positionId;
    }
    const fraction = D(n.fillFraction ?? '1');
    // Fills come in the contract's quantity step (4 decimals here, as BTCUSDT).
    const filled = D(order.qty).times(fraction).toDecimalPlaces(4, Decimal.ROUND_DOWN);
    order.tradeQty = filled.toFixed();
    order.status = fraction.eq(1) ? 'FILLED' : fraction.isZero() ? 'CANCELED' : 'PART_FILLED_CANCELED';
    if (body.slPrice) {
      order.slPrice = String(body.slPrice);
      order.slStopType = String(body.slStopType);
    }
    this.orders.set(clientId, order);
    if (filled.gt(0)) {
      let pos = tradeSide === 'OPEN' ? this.legOf(symbol, legSide) : this.positions.get(order.positionId!);
      if (tradeSide === 'OPEN') {
        if (!pos) {
          pos = { positionId: String(700_000_000_000 + this.seq++), symbol, side: legSide, qty: '0', avgOpenPrice: price, ctime: now, mtime: now };
          this.positions.set(pos.positionId, pos);
        }
        pos.qty = D(pos.qty).plus(filled).toFixed();
        pos.mtime = now;
        order.positionId = pos.positionId;
        if (body.slPrice && n.attachStop !== 'NO') {
          const t = { id: String(500_000_000_000 + this.seq++), positionId: pos.positionId, symbol, base: symbol.replace('USDT', ''), quote: 'USDT', slPrice: String(body.slPrice), slStopType: String(body.slStopType), slOrderType: 'MARKET' };
          if (n.stopVisibleAfterReads) {
            this.tpslReads = 0;
            this.hiddenTpsl.push(t);
          } else this.tpsl.push(t);
        }
      } else {
        pos!.qty = D(pos!.qty).minus(filled).toFixed();
        pos!.mtime = now;
        if (D(pos!.qty).isZero()) {
          this.closeOnExchange(pos!.positionId, { closePrice: price, mtime: now });
          this.tpsl = this.tpsl.filter((t) => t.positionId !== order.positionId);
        }
      }
      const entry = tradeSide === 'CLOSE' ? D(this.positions.get(order.positionId!)?.avgOpenPrice ?? price) : D(price);
      const realizedPNL = tradeSide === 'CLOSE' ? D(price).minus(entry).times(filled).times(legSide === 'LONG' ? 1 : -1).toFixed() : '0';
      this.trades.push({ tradeId: String(800_000_000_000 + this.seq++), orderId: order.orderId, positionId: order.positionId, symbol, side, qty: filled.toFixed(), price, fee: D(filled).times(price).times('0.0006').toFixed(), realizedPNL: realizedPNL === '0' && tradeSide === 'CLOSE' ? '0.0000001' : realizedPNL, reduceOnly: false, clientId, ctime: now });
    }
    if (n.timeout === 'AFTER_ACCEPT') throw new BitunixPrivateError('POST place_order: timed out', 'TIMEOUT');
    if (n.duplicate) throw new BitunixPrivateError('POST place_order: Client ID duplicate (code 30042)', 'API', 30042);
    return { orderId: order.orderId, clientId } as T;
  }
}
