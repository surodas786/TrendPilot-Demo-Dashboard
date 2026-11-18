import type { ContractSpec } from '@trendpilot/domain';
import type { instruments } from '../schema';

type InstrumentRow = typeof instruments.$inferSelect;

/**
 * The contract rules sizing uses. MEXC and Bitunix: unchanged (quantity limits from the exchange,
 * USDT). Lighter: the catalog's base step, base minimum and USDC order-value limits
 * (`min_quote_amount`, `order_quote_limit`); Lighter reports no base-unit maximum, so the stored
 * `max_qty` (a column default for Lighter rows) is never used. A Lighter row without a stored
 * `max_notional` (registered before Step 3) has no verified maximum: `lighterSpecGap` says so.
 */
export function instrumentSpec(inst: InstrumentRow): ContractSpec {
  const base = { contractMultiplier: inst.contractMultiplier, qtyStep: inst.qtyStep, minQty: inst.minQty, priceTick: inst.priceTick, takerFeeRate: inst.takerFeeRate };
  if (inst.exchange !== 'LIGHTER') return { ...base, maxQty: inst.maxQty };
  return { ...base, maxQty: null, minNotional: inst.minNotional, maxNotional: inst.maxNotional, quoteCurrency: inst.quote };
}

/** Why a Lighter instrument cannot be sized yet (no verified per-order maximum), or null. */
export function lighterSpecGap(inst: Pick<InstrumentRow, 'exchange' | 'maxNotional'>): string | null {
  return inst.exchange === 'LIGHTER' && inst.maxNotional === null ? 'No verified maximum order value is stored for this Lighter market. An administrator must refresh it from the Lighter catalog (Admin → Trading Pairs) before entries can be sized.' : null;
}
