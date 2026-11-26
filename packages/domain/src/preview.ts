import { Decimal } from './decimal';
import { partialCloseContracts, partialExitCheck, planExits, targetClosePrice, trailingActivationPrice } from './exits';
import type { MarketSource } from './marketFeed';
import { exitAllocation, takeProfitFor, trailingFor, type OrderBlockSettings, type PriceBasis, type TakeProfitMode } from './orderBlock';

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
   * This side's Trailing Take Profit: arms at `activationPrice`; its pool is `contracts`
   * (`managesPct` of the position: what Take Profit does not reserve). Each trigger closes
   * `closePct` of the pool left (`firstCloseContracts` on the first trigger). `targetClose`: the
   * optional one-shot target inside trailing.
   */
  trailing: {
    activationPrice: string | null;
    distancePct: string;
    managesPct: string;
    contracts: string;
    closePct: string | null;
    firstCloseContracts: string;
    targetClose: { price: string; closePct: string; contracts: string } | null;
  } | null;
  /**
   * Exit quantities from this size that the exchange would refuse (below a step or the minimum, or
   * leaving a remainder below the minimum). Advisory: such an exit is reported and skipped at
   * runtime, never widened into a full close.
   */
  exitWarnings: { exit: string; code: string; message: string }[];
  reasons: { code: PreviewReason; message: string }[];
  ok: boolean;
}

export interface OrderPreview {
  quote: Quote;
  sides: SidePreview[];
  notes: string[];
}

type PreviewSettings = Pick<OrderBlockSettings, 'orderCostUsdt' | 'leverage' | 'direction' | 'stop' | 'takeProfitLong' | 'takeProfitShort' | 'trailingLong' | 'trailingShort' | 'risk'>;

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

  const tr = trailingFor(s, dir);
  const exits = { takeProfit: takeProfitFor(s, dir), trailing: tr };
  const plan = planExits(dir, fmt(p), fmt(contracts), exits, { priceTick: spec.priceTick, qtyStep: spec.qtyStep });
  const tps = plan.targets.map((t) => ({ id: t.levelId, price: t.triggerPrice, closePct: t.closePct, contracts: t.plannedContracts }));
  const allocation = exitAllocation(exits);
  const limits = { qtyStep: spec.qtyStep, minQty: spec.minQty };
  const exitWarnings: SidePreview['exitWarnings'] = [];
  if (contracts.gt(0)) {
    let left = contracts;
    plan.targets.forEach((t, i) => {
      const c = partialExitCheck(t.plannedContracts, left.toFixed(), limits);
      if (!c.ok) exitWarnings.push({ exit: `Take profit target ${i + 1}`, code: c.code, message: c.message });
      left = left.minus(t.plannedContracts);
    });
  }

  // Same activation rounding as the running position (never closer than configured).
  let trailing: SidePreview['trailing'] = null;
  if (tr.enabled && tr.distancePct) {
    const pool = plan.trailingContracts;
    const first = tr.closePct ? partialCloseContracts(pool, tr.closePct, spec.qtyStep) : '0';
    const tc = tr.targetClose?.enabled && tr.targetClose.movePct && tr.targetClose.closePct ? tr.targetClose : null;
    const tcContracts = tc ? partialCloseContracts(pool, tc.closePct!, spec.qtyStep) : '0';
    trailing = {
      activationPrice: trailingActivationPrice(dir, fmt(p), tr.activationPct, spec.priceTick),
      distancePct: tr.distancePct,
      managesPct: allocation.trailingPct,
      contracts: pool,
      closePct: tr.closePct,
      firstCloseContracts: first,
      targetClose: tc ? { price: targetClosePrice(dir, fmt(p), tc.movePct!, spec.priceTick), closePct: tc.closePct!, contracts: tcContracts } : null
    };
    if (contracts.gt(0)) {
      if (D(pool).lte(0)) exitWarnings.push({ exit: 'Trailing take profit', code: 'NO_TRAILING_POOL', message: 'Take profit reserves the whole position, so Trailing take profit has nothing to close. Lower the Take profit allocation or turn trailing off.' });
      else {
        const c = partialExitCheck(first, fmt(contracts), limits);
        if (!c.ok) exitWarnings.push({ exit: 'Trailing take profit', code: c.code, message: c.message });
        if (tc) {
          const t = partialExitCheck(tcContracts, fmt(contracts), limits);
          if (!t.ok) exitWarnings.push({ exit: 'Trailing target close', code: t.code, message: t.message });
        }
      }
    }
  }

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
    exitWarnings,
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
