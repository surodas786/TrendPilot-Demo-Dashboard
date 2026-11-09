import { Decimal } from './decimal';
import type { MarketSource } from './marketFeed';
import type { OrderBlockSettings, PriceBasis } from './orderBlock';

/**
 * EXE-01 order preview: sizing, stop, targets and fees from a quote, without placing
 * anything. A preview is an estimate, not a fill guarantee. Pure; no I/O.
 */

export interface ContractSpec {
  contractMultiplier: string;
  qtyStep: string;
  minQty: string;
  maxQty: string;
  priceTick: string;
  takerFeeRate: string;
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
  takeProfits: { id: string; price: string; closePct: string }[];
  trailing: { activationPrice: string | null; distancePct: string } | null;
  reasons: { code: PreviewReason; message: string }[];
  ok: boolean;
}

export interface OrderPreview {
  quote: Quote;
  sides: SidePreview[];
  notes: string[];
}

type PreviewSettings = Pick<OrderBlockSettings, 'orderCostUsdt' | 'leverage' | 'direction' | 'stop' | 'takeProfit' | 'trailing' | 'risk'>;

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

  const reasons: SidePreview['reasons'] = [];
  if (contracts.lt(D(spec.minQty))) {
    reasons.push({ code: 'SIZE_BELOW_MINIMUM', message: `Order cost and leverage buy ${fmt(contracts)} contracts; the minimum is ${spec.minQty}. Size is never increased automatically.` });
  }
  if (contracts.gt(D(spec.maxQty))) reasons.push({ code: 'SIZE_ABOVE_MAXIMUM', message: `Exceeds the contract maximum of ${spec.maxQty}.` });
  if ((long && stop.gte(p)) || (!long && stop.lte(p))) {
    reasons.push({ code: 'STOP_WRONG_SIDE', message: long ? 'A long stop must be below the entry price.' : 'A short stop must be above the entry price.' });
  }
  if (s.risk.maxNotionalUsdt && notional.gt(D(s.risk.maxNotionalUsdt))) {
    reasons.push({ code: 'RISK_LIMIT', message: `Notional ${fmt(notional, 2)} USDT exceeds your cap of ${s.risk.maxNotionalUsdt} USDT.` });
  }
  if (s.risk.maxStopRiskUsdt && lossToStop.gt(D(s.risk.maxStopRiskUsdt))) {
    reasons.push({ code: 'RISK_LIMIT', message: `Loss to stop ${fmt(lossToStop, 2)} USDT exceeds your cap of ${s.risk.maxStopRiskUsdt} USDT.` });
  }

  const tps = s.takeProfit.levels.map((l) => {
    const move = D(l.movePct).div(100);
    const raw = long ? p.times(D(1).plus(move)) : p.times(D(1).minus(move));
    return { id: l.id, price: fmt(roundToTick(raw, tick, long ? Decimal.ROUND_DOWN : Decimal.ROUND_UP)), closePct: s.takeProfit.mode === 'FIXED' ? '100' : l.closePct };
  });

  const trailing =
    s.trailing.enabled && s.trailing.distancePct
      ? {
          activationPrice: s.trailing.activationPct
            ? fmt(roundToTick(long ? p.times(D(1).plus(D(s.trailing.activationPct).div(100))) : p.times(D(1).minus(D(s.trailing.activationPct).div(100))), tick, Decimal.ROUND_HALF_UP))
            : null,
          distancePct: s.trailing.distancePct
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
