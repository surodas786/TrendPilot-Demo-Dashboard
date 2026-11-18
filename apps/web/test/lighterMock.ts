// A mocked Lighter exchange and signer for Step 4 tests. Follows the documented contract:
// one net position per market, nonce per API key (a wrong nonce is rejected without consuming it),
// OTO grouped orders (the reduce-only stop arms only after the entry fills), reduce-only orders
// never cross zero, tx status 0 failed / 1 pending / 2 executed. Nothing here talks to Lighter.
import { createHash } from 'node:crypto';
import { Decimal, LIGHTER_ENVIRONMENTS, LIGHTER_TX_TYPE, type LighterOrderReq } from '@trendpilot/domain';
import { LighterPrivateError, type LighterAccountSnapshot, type LighterApi, type LighterBook, type LighterOrder, type LighterSignedTx, type LighterSigner, type LighterTrade } from '@trendpilot/db';

const D = (v: Decimal.Value) => new Decimal(v);

interface MarketCfg {
  sizeDecimals: number;
  priceDecimals: number;
  bid: string;
  ask: string;
  marginMode: 'CROSS' | 'ISOLATED';
  leverage: number;
}

interface Pos {
  sign: 1 | -1 | 0;
  size: Decimal;
  entry: Decimal;
}

interface MockOrder extends LighterOrder {
  /** For an OTO child: its parent's client index. */
  parentClientIndex?: number;
}

export interface NextFault {
  /** The request is lost before Lighter sees it (timeout). */
  timeoutBeforeApply?: boolean;
  /** Lighter applies the tx, the acknowledgement is lost (timeout). */
  timeoutAfterApply?: boolean;
  /** Another client consumes the expected nonce just before this send (nonce conflict). */
  nonceStolen?: boolean;
  /** Definitive API rejection with this code (nonce not consumed). */
  apiError?: number;
  /** Entry fills only this fraction of its size (partial fill of the IOC parent). */
  fillFraction?: string;
  /** The OTO child stop keeps the PARENT size instead of the filled size. */
  childKeepsParentSize?: boolean;
  /** The OTO child stop is not armed (stays waiting for its parent). */
  childNotArmed?: boolean;
}

/** Lighter order indexes are unique for the exchange: shared by every mock instance. */
let orderSeq = 5000;

export class MockLighter implements LighterApi {
  accountIndex: number;
  apiKeyIndex: number;
  registeredPublicKey: string | null = 'ab'.repeat(40);
  accountExists = true;
  available = '1000';
  collateral = '1000';
  markets = new Map<number, MarketCfg>();
  positions = new Map<number, Pos>();
  orders = new Map<number, MockOrder>();
  trades = new Map<string, LighterTrade[]>();
  txs = new Map<string, number>();
  expectedNonce = 7;
  next: NextFault = {};
  sent: { txType: number; nonce: number; body: unknown }[] = [];
  takerFee = '0.012';

  constructor(accountIndex = 4242, apiKeyIndex = 5) {
    this.accountIndex = accountIndex;
    this.apiKeyIndex = apiKeyIndex;
    this.markets.set(92, { sizeDecimals: 4, priceDecimals: 2, bid: '2399.90', ask: '2400.10', marginMode: 'ISOLATED', leverage: 10 });
  }

  /** Which Lighter environment this mock pretends to be (by ZkLighter contract). */
  contractAddress: string = LIGHTER_ENVIRONMENTS.MAINNET.contractAddress;

  /* ── reads ── */

  async identity() {
    return { networkId: 1, contractAddress: this.contractAddress };
  }

  /** Private/account reads fail (HTTP 503) while set. */
  failReads = false;

  /** A testnet-shaped mock: testnet contract, testnet ETH (4095, size 4 dp, price 2 dp); no XAU, no 92. */
  static testnet(accountIndex: number, apiKeyIndex: number): MockLighter {
    const m = new MockLighter(accountIndex, apiKeyIndex);
    m.contractAddress = LIGHTER_ENVIRONMENTS.TESTNET.contractAddress;
    m.markets.clear();
    m.markets.set(4095, { sizeDecimals: 4, priceDecimals: 2, bid: '3000.00', ask: '3000.50', marginMode: 'CROSS', leverage: 5 });
    return m;
  }

  async account(i: number): Promise<LighterAccountSnapshot | null> {
    if (this.failReads) throw new LighterPrivateError('GET /api/v1/account: HTTP 503', 'HTTP', 503);
    if (i !== this.accountIndex || !this.accountExists) return null;
    const positions = [...this.markets.entries()].map(([marketId, m]) => {
      const p = this.positions.get(marketId) ?? { sign: 0 as const, size: D(0), entry: D(0) };
      const resting = [...this.orders.values()].filter((o) => o.marketIndex === marketId && (o.status === 'pending' || o.status === 'open'));
      return {
        marketId,
        symbol: marketId === 92 ? 'XAU' : marketId === 4095 ? 'ETH' : `M${marketId}`,
        side: p.size.isZero() ? null : p.sign === 1 ? ('LONG' as const) : ('SHORT' as const),
        size: p.size.toFixed(),
        avgEntryPrice: p.size.isZero() ? null : p.entry.toFixed(),
        liquidationPrice: p.size.isZero() ? null : '1800',
        unrealizedPnl: '0',
        totalFundingPaidOut: p.size.isZero() ? null : '-0.01',
        marginMode: m.marginMode,
        leverage: m.leverage,
        allocatedMargin: '0',
        openOrderCount: 0,
        pendingOrderCount: resting.length,
        positionTiedOrderCount: 0
      };
    });
    return { accountIndex: i, l1Address: '0xabc', accountType: 0, tradingMode: 0, status: 1, collateral: this.collateral, availableBalance: this.available, totalAssetValue: this.collateral, positions, transactionTimeUs: null };
  }
  async apiKeyPublicKey(a: number, k: number) {
    return a === this.accountIndex && k === this.apiKeyIndex ? this.registeredPublicKey : null;
  }
  async nextNonce() {
    return this.expectedNonce;
  }
  async txStatus(hash: string) {
    return this.txs.has(hash) ? this.txs.get(hash)! : null;
  }
  async orderBook(marketId: number): Promise<LighterBook> {
    const m = this.markets.get(marketId)!;
    return { bestBid: m.bid, bestAsk: m.ask };
  }
  async ordersByClientIndex(_a: number, idx: number[], token: string) {
    if (token !== 'tok') throw new LighterPrivateError('accountOrders: unauthorized', 'API', 20001);
    return idx.map((i) => this.orders.get(i)).filter((o): o is MockOrder => !!o);
  }
  async tradesForOrder(_a: number, orderIndex: string, token: string) {
    if (token !== 'tok') throw new LighterPrivateError('trades: unauthorized', 'API', 20001);
    return this.trades.get(orderIndex) ?? [];
  }

  /* ── send ── */

  async sendTx(txType: number, txInfo: string) {
    const f = this.next;
    this.next = {};
    const tx = JSON.parse(txInfo) as { nonce: number; hash: string; body: unknown };
    if (f.timeoutBeforeApply) throw new LighterPrivateError('sendTx: timed out', 'TIMEOUT');
    if (f.nonceStolen) this.expectedNonce += 1;
    if (tx.nonce !== this.expectedNonce) throw new LighterPrivateError('sendTx: invalid nonce', 'API', 21104);
    if (f.apiError) throw new LighterPrivateError(`sendTx: error ${f.apiError}`, 'API', f.apiError);
    this.expectedNonce += 1;
    this.sent.push({ txType, nonce: tx.nonce, body: tx.body });
    this.txs.set(tx.hash, 2);
    if (txType === LIGHTER_TX_TYPE.CREATE_GROUPED_ORDERS) this.applyGrouped(tx.body as { orders: LighterOrderReq[] }, f);
    else if (txType === LIGHTER_TX_TYPE.CREATE_ORDER) this.applyOrder(tx.body as LighterOrderReq);
    else if (txType === LIGHTER_TX_TYPE.MODIFY_ORDER) this.applyModify(tx.body as { index: number; baseAmount: string });
    if (f.timeoutAfterApply) throw new LighterPrivateError('sendTx: timed out', 'TIMEOUT');
    return { txHash: tx.hash };
  }

  private px = (m: MarketCfg, scaled: string) => D(scaled).div(D(10).pow(m.priceDecimals));
  private sz = (m: MarketCfg, scaled: string) => D(scaled).div(D(10).pow(m.sizeDecimals));

  private newOrder(o: LighterOrderReq, m: MarketCfg, status: string, triggerStatus = 'na'): MockOrder {
    const ord: MockOrder = {
      orderIndex: String(++orderSeq),
      clientOrderIndex: o.ClientOrderIndex,
      marketIndex: o.MarketIndex,
      isAsk: o.IsAsk === 1,
      type: o.Type === 2 ? 'stop-loss' : o.Type === 1 ? 'market' : 'limit',
      reduceOnly: o.ReduceOnly === 1,
      status,
      triggerStatus,
      initialBaseAmount: this.sz(m, o.BaseAmount).toFixed(),
      remainingBaseAmount: this.sz(m, o.BaseAmount).toFixed(),
      filledBaseAmount: '0',
      filledQuoteAmount: '0',
      price: this.px(m, o.Price).toFixed(),
      triggerPrice: this.px(m, o.TriggerPrice).toFixed(),
      orderExpiryMs: o.OrderExpiry,
      parentOrderIndex: null
    };
    if (this.orders.has(o.ClientOrderIndex)) throw new LighterPrivateError('client order index exists', 'API', 21728);
    this.orders.set(o.ClientOrderIndex, ord);
    return ord;
  }

  /** Market IOC fill at the book (all or a fraction), never crossing zero when reduce-only. */
  private fill(ord: MockOrder, m: MarketCfg, qty: Decimal) {
    const p = this.positions.get(ord.marketIndex) ?? { sign: 0 as const, size: D(0), entry: D(0) };
    const sign: 1 | -1 = ord.isAsk ? -1 : 1;
    let q = qty;
    if (ord.reduceOnly) {
      if (p.size.isZero() || p.sign === sign) q = D(0);
      else q = Decimal.min(q, p.size);
    }
    const price = D(ord.isAsk ? m.bid : m.ask);
    if (q.gt(0)) {
      if (p.size.isZero() || p.sign === sign) {
        const size = p.size.plus(q);
        this.positions.set(ord.marketIndex, { sign, size, entry: p.size.isZero() ? price : p.entry.times(p.size).plus(price.times(q)).div(size) });
      } else {
        const size = p.size.minus(q);
        this.positions.set(ord.marketIndex, { sign: size.isZero() ? 0 : p.sign, size, entry: p.entry });
      }
      this.trades.set(ord.orderIndex, [{ tradeId: `t${ord.orderIndex}`, size: q.toFixed(), price: price.toFixed(), fee: this.takerFee, timestampMs: Date.parse('2026-11-08T10:00:00Z'), realizedPnl: null }]);
    }
    ord.filledBaseAmount = q.toFixed();
    ord.filledQuoteAmount = q.times(price).toFixed();
    ord.remainingBaseAmount = '0';
    ord.status = q.isZero() ? (ord.reduceOnly ? 'canceled-reduce-only' : 'canceled-not-enough-liquidity') : 'filled';
    this.afterPositionChange(ord.marketIndex);
  }

  private applyGrouped(g: { orders: LighterOrderReq[] }, f: NextFault) {
    const [entryReq, stopReq] = g.orders as [LighterOrderReq, LighterOrderReq];
    const m = this.markets.get(entryReq.MarketIndex)!;
    const entry = this.newOrder(entryReq, m, 'in-progress');
    const stop = this.newOrder(stopReq, m, 'pending', 'parent-order');
    stop.parentClientIndex = entry.clientOrderIndex;
    stop.parentOrderIndex = entry.orderIndex;
    const want = D(entry.initialBaseAmount);
    const q = f.fillFraction ? want.times(f.fillFraction).toDecimalPlaces(m.sizeDecimals, Decimal.ROUND_DOWN) : want;
    this.fill(entry, m, q);
    if (D(entry.filledBaseAmount).isZero()) {
      stop.status = 'canceled-child';
      return;
    }
    if (!f.childNotArmed) stop.triggerStatus = 'mark-price';
    // The child is sent with size 0 (OTO rule); Lighter sizes it (assumed: the filled size).
    stop.initialBaseAmount = entry.initialBaseAmount;
    stop.remainingBaseAmount = f.childKeepsParentSize ? entry.initialBaseAmount : entry.filledBaseAmount;
  }

  private applyOrder(o: LighterOrderReq) {
    const m = this.markets.get(o.MarketIndex)!;
    const ord = this.newOrder(o, m, 'in-progress');
    this.fill(ord, m, D(ord.initialBaseAmount));
  }

  private applyModify(b: { index: number; baseAmount: string }) {
    const ord = this.orders.get(b.index)!;
    const m = this.markets.get(ord.marketIndex)!;
    ord.remainingBaseAmount = this.sz(m, b.baseAmount).toFixed();
  }

  /** A reduce-only stop on a flat market is cancelled (documented reduce-only behaviour). */
  private afterPositionChange(marketId: number) {
    const p = this.positions.get(marketId);
    if (p && !p.size.isZero()) return;
    for (const o of this.orders.values()) if (o.marketIndex === marketId && o.reduceOnly && o.status === 'pending' && o.triggerStatus === 'mark-price') o.status = 'canceled-reduce-only';
  }

  /* ── exchange-side events ── */

  /** The native stop triggers on the mark price and fills (reduce-only). */
  triggerStop(clientOrderIndex: number) {
    const s = this.orders.get(clientOrderIndex)!;
    const m = this.markets.get(s.marketIndex)!;
    this.fill(s, m, D(s.remainingBaseAmount));
  }

  /** A close made directly on Lighter (unknown order, no TrendPilot record). */
  closeOnLighter(marketId: number, qty: Decimal.Value) {
    const p = this.positions.get(marketId)!;
    const size = p.size.minus(qty);
    this.positions.set(marketId, { sign: size.isZero() ? 0 : p.sign, size, entry: p.entry });
    this.afterPositionChange(marketId);
  }

  stopOf(marketId: number) {
    return [...this.orders.values()].find((o) => o.marketIndex === marketId && o.type === 'stop-loss' && o.status === 'pending');
  }
}

/** Signs nothing real: the "signed" tx is JSON carrying the nonce, so the mock can check order. */
export function mockSigner(publicKey = 'ab'.repeat(40)): LighterSigner & { signed: number } {
  const s = {
    signed: 0,
    publicKey: async () => publicKey,
    createAuthToken: async () => 'tok',
    sign(txType: number, body: unknown, nonce: number): LighterSignedTx {
      s.signed += 1;
      const hash = createHash('sha256').update(JSON.stringify({ txType, body, nonce })).digest('hex');
      return { txType, txInfo: JSON.stringify({ nonce, hash, body }), txHash: hash };
    },
    signCreateGroupedOrders: async (g: { groupingType: number; orders: LighterOrderReq[] }, n: number) => s.sign(LIGHTER_TX_TYPE.CREATE_GROUPED_ORDERS, g, n),
    signCreateOrder: async (o: LighterOrderReq, n: number) => s.sign(LIGHTER_TX_TYPE.CREATE_ORDER, o, n),
    signModifyOrder: async (m: { marketIndex: number; index: number; baseAmount: string; price: string; triggerPrice: string }, n: number) => s.sign(LIGHTER_TX_TYPE.MODIFY_ORDER, m, n),
    signCancelOrder: async (m: { marketIndex: number; index: number }, n: number) => s.sign(LIGHTER_TX_TYPE.CANCEL_ORDER, m, n)
  };
  return s;
}
