// Stateful mock of the Bitunix Futures private READ API (Step 2), shaped like the documented
// responses (position/get_pending_positions bare list; get_history_positions {positionList,total};
// trade/get_pending_orders, get_history_orders {orderList,total}; get_history_trades
// {tradeList,total}; tpsl/get_pending_orders bare list). It implements BitunixRequester, so the
// real reads, pagination and reconciliation run against it. Faults are injected per test.
import { BitunixPrivateError, type BitunixRequester } from '@trendpilot/db';

export interface MockPosition {
  positionId: string;
  symbol: string;
  side: 'LONG' | 'SHORT';
  qty: string;
  avgOpenPrice?: string;
  positionMode?: string;
  leverage?: number;
  liqPrice?: string;
  fee?: string;
  funding?: string;
  ctime?: number;
  mtime: number;
  subAccountId?: number;
}

export class MockBitunix implements BitunixRequester {
  mode = 'HEDGE';
  usdt = { available: '100', frozen: '0', margin: '0', crossUnrealizedPNL: '0', isolationUnrealizedPNL: '0' };
  positions = new Map<string, MockPosition>();
  history: Record<string, unknown>[] = [];
  pendingOrders: Record<string, unknown>[] = [];
  historyOrders: Record<string, unknown>[] = [];
  trades: Record<string, unknown>[] = [];
  tpsl: Record<string, unknown>[] = [];
  calls: { path: string; params: Record<string, unknown> }[] = [];
  /** path → error thrown instead of answering (once or always). */
  failures = new Map<string, { error: Error; once: boolean }>();
  /** Runs before each answer (e.g. to push a WS event mid-snapshot). */
  beforeAnswer: ((path: string) => Promise<void> | void) | null = null;

  reset(): void {
    this.mode = 'HEDGE';
    this.usdt = { available: '100', frozen: '0', margin: '0', crossUnrealizedPNL: '0', isolationUnrealizedPNL: '0' };
    this.positions.clear();
    this.history = [];
    this.pendingOrders = [];
    this.historyOrders = [];
    this.trades = [];
    this.tpsl = [];
    this.calls = [];
    this.failures.clear();
    this.beforeAnswer = null;
  }

  failOn(path: string, error: Error = new BitunixPrivateError(`GET ${path}: timed out`, 'TIMEOUT'), once = false): void {
    this.failures.set(path, { error, once });
  }

  /** Bitunix closes a position: it leaves the open list and appears in history. */
  closeOnExchange(positionId: string, o: { closePrice: string; mtime: number; fee?: string | null; funding?: string | null; realizedPNL?: string }): void {
    const p = this.positions.get(positionId)!;
    this.positions.delete(positionId);
    this.history.unshift({ positionId, symbol: p.symbol, side: p.side, maxQty: p.qty, entryPrice: p.avgOpenPrice ?? '0', closePrice: o.closePrice, liqQty: '0', fee: o.fee ?? undefined, funding: o.funding ?? undefined, realizedPNL: o.realizedPNL ?? '0', ctime: p.ctime ?? 1, mtime: o.mtime });
  }

  private page<T>(rows: T[], params: Record<string, unknown>): T[] {
    const skip = Number(params.skip ?? 0);
    const limit = Number(params.limit ?? 10);
    return rows.slice(skip, skip + limit);
  }

  async get<T>(path: string, params: Record<string, unknown> = {}): Promise<T> {
    this.calls.push({ path, params });
    await this.beforeAnswer?.(path);
    const f = this.failures.get(path);
    if (f) {
      if (f.once) this.failures.delete(path);
      throw f.error;
    }
    const inRange = (t: unknown) => (params.startTime === undefined || Number(t) >= Number(params.startTime)) && (params.endTime === undefined || Number(t) <= Number(params.endTime));
    switch (path) {
      case '/api/v1/futures/account/position_mode':
        return { positionMode: this.mode } as T;
      case '/api/v1/futures/account':
        return [{ marginCoin: 'USDT', transfer: this.usdt.available, positionMode: this.mode, bonus: '0', ...this.usdt }] as T;
      case '/api/v1/futures/position/get_pending_positions':
        return [...this.positions.values()].filter((p) => (!params.positionId || p.positionId === params.positionId) && (!params.symbol || p.symbol === params.symbol)).map((p) => ({ positionMode: this.mode, marginMode: 'ISOLATION', leverage: 10, ...p })) as T;
      case '/api/v1/futures/position/get_history_positions': {
        const rows = this.history.filter((h) => (!params.positionId || h.positionId === params.positionId) && (!params.symbol || h.symbol === params.symbol));
        return { positionList: this.page(rows, params), total: rows.length } as T;
      }
      case '/api/v1/futures/trade/get_pending_orders':
        return { orderList: this.page(this.pendingOrders, params), total: this.pendingOrders.length } as T;
      case '/api/v1/futures/trade/get_history_orders': {
        const rows = this.historyOrders.filter((o) => inRange(o.mtime ?? o.ctime));
        return { orderList: this.page(rows, params), total: rows.length } as T;
      }
      case '/api/v1/futures/trade/get_history_trades': {
        const rows = this.trades.filter((t) => inRange(t.ctime) && (!params.positionId || t.positionId === params.positionId));
        return { tradeList: this.page(rows, params), total: rows.length } as T;
      }
      case '/api/v1/futures/tpsl/get_pending_orders':
        return this.page(this.tpsl, params) as T;
      default:
        throw new BitunixPrivateError(`mock: unexpected ${path}`, 'REFUSED');
    }
  }
}
