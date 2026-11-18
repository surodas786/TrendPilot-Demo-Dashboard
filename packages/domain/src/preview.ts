import { Decimal } from './decimal';
import { planExits, trailingActivationPrice } from './exits';
import type { MarketSource } from './marketFeed';
import { exitAllocation, takeProfitFor, type OrderBlockSettings, type PriceBasis, type TakeProfitMode } from './orderBlock';

/**
 * EXE-01 order preview: sizing, stop, targets and fees from a quote, without placing
 * anything. A preview is an estimate, not a fill guarantee. Pure; no I/O.
 */

export interface ContractSpec {
  contractMultiplier: string;
  qtyStep: string;
  minQty: string;
  /** Largest quantity per order; null when the exchange reports no base-unit maximum (Lighter: see maxNotional). */
  maxQty: string | null;
  priceTick: string;
  takerFeeRate: string;
  /** Smallest order value in the quote currency (Lighter `min_quote_amount`); absent where not reported. */
  minNotional?: string | null;
  /** Largest order value in the quote currency (Lighter `order_quote_limit`); absent where not reported. */
  maxNotional?: string | null;
  /** Currency of notional, margin, fees and caps (USDT on MEXC / Bitunix, USDC on Lighter). Default USDT. */
  quoteCurrency?: string;
}

export interface Quote {
  bid: string;
  ask: string;
  mark: string;
  asOf: string;
  /** Where the quote came from: labelled fixtures or public MEXC market data. */
  source: MarketSource;
}

export type PreviewReason = 'SIZE_BELOW_MINIMUM' | 'SIZE_ABOVE_MAXIMUM' | 'STOP_WRONG_SIDE' | 'RISK_LIMIT' | 'DIRECTION_DISABLED';

export interface SidePreview {
  side: 'LONG' | 'SHORT';
  entryPrice: string;
  entryPriceBasis: 'ASK' | 'BID';
  targetNotionalUsdt: string;
  rawContracts: string;
  contracts: string;
  quantity: string;
  estimatedNotionalUsdt: string;
  estimatedMarginUsdt: string;
  estimatedEntryFeeUsdt: string;
  stopPrice: string;
  stopBasis: PriceBasis;
  stopDistancePct: string;
  lossToStopUsdt: string;
  /** This side's Take Profit configuration (Long and Short are set independently). */
  takeProfitMode: TakeProfitMode;
  /** % of the position this side's Take Profit manages (the rest after Trailing Take Profit). */
  takeProfitManagesPct: string;
  /** Each target with the contracts it would close from this size (above entry for a Long, below for a Short). */
  takeProfits: { id: string; price: string; closePct: string; contracts: string }[];
  /**
   * Trailing Take Profit: arms at `activationPrice` and manages `contracts` (`managesPct` of
   * the position, its "Position to close (%)").
   */
  trailing: { activationPrice: string | null; distancePct: string; managesPct: string; contracts: string } | null;
  reasons: { code: PreviewReason; message: string }[];
  ok: boolean;
}

export interface OrderPreview {
  quote: Quote;
  sides: SidePreview[];
  notes: string[];
}

type PreviewSettings = Pick<OrderBlockSettings, 'orderCostUsdt' | 'leverage' | 'direction' | 'stop' | 'takeProfitLong' | 'takeProfitShort' | 'trailing' | 'risk'>;

const D = (v: string | number | Decimal) => new Decimal(v);
const fmt = (v: Decimal, dp = 8) => v.toDecimalPlaces(dp, Decimal.ROUND_HALF_UP).toFixed();

function roundToTick(price: Decimal, tick: Decimal, mode: Decimal.Rounding): Decimal {
  return price.div(tick).toDecimalPlaces(0, mode).times(tick);
}

function side(s: PreviewSettings, spec: ContractSpec, quote: Quote, dir: 'LONG' | 'SHORT'): SidePreview {
  const long = dir === 'LONG';
  // EXE-01: ask-side input for buying, bid-side for selling.
  const p = D(long ? quote.ask : quote.bid);
  const m = D(spec.contractMultiplier);
  const step = D(spec.qtyStep);
  const tick = D(spec.priceTick);
  const fee = D(spec.takerFeeRate);
  const lev = D(s.leverage);

  const targetNotional = D(s.orderCostUsdt).times(lev);
  const raw = targetNotional.div(p).div(m);
  // Round down to the quantity step; never increase size to satisfy a minimum.
  const contracts = raw.div(step).floor().times(step);
  const qty = contracts.times(m);
  const notional = qty.times(p);
  const margin = notional.div(lev);
  const entryFee = notional.times(fee);

  // Stop: rounded toward entry so the preview never shows a wider stop than configured.
  const stopRaw =
    s.stop.type === 'PRICE' ? D(s.stop.value) : long ? p.times(D(1).minus(D(s.stop.value).div(100))) : p.times(D(1).plus(D(s.stop.value).div(100)));
  const stop = roundToTick(stopRaw, tick, long ? Decimal.ROUND_UP : Decimal.ROUND_DOWN);
  const stopDistance = p.minus(stop).abs();
  const exitFeeAtStop = qty.times(stop).times(fee);
  const lossToStop = qty.times(stopDistance).plus(entryFee).plus(exitFeeAtStop);

  const ccy = spec.quoteCurrency ?? 'USDT';
  const reasons: SidePreview['reasons'] = [];
  if (contracts.lt(D(spec.minQty))) {
    reasons.push({ code: 'SIZE_BELOW_MINIMUM', message: `Order cost and leverage buy ${fmt(contracts)} contracts; the minimum is ${spec.minQty}. Size is never increased automatically.` });
  }
  if (spec.maxQty !== null && contracts.gt(D(spec.maxQty))) reasons.push({ code: 'SIZE_ABOVE_MAXIMUM', message: `Exceeds the contract maximum of ${spec.maxQty}.` });
  if (spec.minNotional && notional.lt(D(spec.minNotional))) {
    reasons.push({ code: 'SIZE_BELOW_MINIMUM', message: `Order value ${fmt(notional, 2)} ${ccy} is below the exchange minimum of ${spec.minNotional} ${ccy}. Size is never increased automatically.` });
  }
  if (spec.maxNotional && notional.gt(D(spec.maxNotional))) reasons.push({ code: 'SIZE_ABOVE_MAXIMUM', message: `Order value ${fmt(notional, 2)} ${ccy} exceeds the exchange maximum of ${spec.maxNotional} ${ccy} per order.` });
  if ((long && stop.gte(p)) || (!long && stop.lte(p))) {
    reasons.push({ code: 'STOP_WRONG_SIDE', message: long ? 'A long stop must be below the entry price.' : 'A short stop must be above the entry price.' });
  }
  if (s.risk.maxNotionalUsdt && notional.gt(D(s.risk.maxNotionalUsdt))) {
    reasons.push({ code: 'RISK_LIMIT', message: `Notional ${fmt(notional, 2)} ${ccy} exceeds your cap of ${s.risk.maxNotionalUsdt} ${ccy}.` });
  }
  if (s.risk.maxStopRiskUsdt && lossToStop.gt(D(s.risk.maxStopRiskUsdt))) {
    reasons.push({ code: 'RISK_LIMIT', message: `Loss to stop ${fmt(lossToStop, 2)} ${ccy} exceeds your cap of ${s.risk.maxStopRiskUsdt} ${ccy}.` });
  }

  const exits = { takeProfit: takeProfitFor(s, dir), trailing: s.trailing };
  const plan = planExits(dir, fmt(p), fmt(contracts), exits, { priceTick: spec.priceTick, qtyStep: spec.qtyStep });
  const tps = plan.targets.map((t) => ({ id: t.levelId, price: t.triggerPrice, closePct: t.closePct, contracts: t.plannedContracts }));
  const allocation = exitAllocation(exits);

  // Same activation rounding as the running position (never closer than configured).
  const trailing =
    s.trailing.enabled && s.trailing.distancePct
      ? {
          activationPrice: trailingActivationPrice(dir, fmt(p), s.trailing.activationPct, spec.priceTick),
          distancePct: s.trailing.distancePct,
          managesPct: allocation.trailingPct,
          contracts: plan.trailingContracts
        }
      : null;

  return {
    side: dir,
    entryPrice: fmt(p),
    entryPriceBasis: long ? 'ASK' : 'BID',
    targetNotionalUsdt: fmt(targetNotional, 2),
    rawContracts: fmt(raw, 6),
    contracts: fmt(contracts),
    quantity: fmt(qty),
    estimatedNotionalUsdt: fmt(notional, 2),
    estimatedMarginUsdt: fmt(margin, 2),
    estimatedEntryFeeUsdt: fmt(entryFee, 4),
    stopPrice: fmt(stop),
    stopBasis: s.stop.basis,
    stopDistancePct: fmt(stopDistance.div(p).times(100), 3),
    lossToStopUsdt: fmt(lossToStop, 2),
    takeProfitMode: exits.takeProfit.mode,
    takeProfitManagesPct: allocation.takeProfitPct,
    takeProfits: tps,
    trailing,
    reasons,
    ok: reasons.length === 0
  };
}

export function previewOrder(s: PreviewSettings, spec: ContractSpec, quote: Quote): OrderPreview {
  const sides: SidePreview[] = [];
  if (s.direction !== 'SHORT_ONLY') sides.push(side(s, spec, quote, 'LONG'));
  if (s.direction !== 'LONG_ONLY') sides.push(side(s, spec, quote, 'SHORT'));
  return {
    quote,
    sides,
    notes: [
      'Fixture quote and contract data — not live MEXC prices or limits.',
      'Market entry estimate before slippage. A preview is not a guarantee of fill price.',
      'Available margin is not checked yet: paper balances arrive in M2.'
    ]
  };
}
