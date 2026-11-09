import { Decimal } from './decimal';
import type { MarketSource } from './marketFeed';
import { applyEmaFilter, type EmaResult } from './market';
import { PLATFORM_CEILINGS, type OrderBlockSettings } from './orderBlock';
import { previewOrder, type ContractSpec, type SidePreview } from './preview';

/**
 * STR-01/02 + STR-08 entry checks for a confirmed-flat paper scope, and EXE-01/02 sizing and
 * protection. Pure: callers load state under the account lock and persist the result.
 */

export const PAPER_POLICY = {
  /** Quote older than this at evaluation is stale (MKT-02 FEED_STALE). */
  maxQuoteAgeSeconds: 15,
  /** Clock skew tolerated for a quote stamped slightly in the future. */
  quoteClockToleranceSeconds: 2,
  /** Fixture maintenance margin rate for the isolated-margin liquidation estimate. */
  maintenanceMarginRate: '0.005',
  /** Minimum distance between stop and estimated liquidation, as % of entry. */
  liquidationBufferPct: '0.5',
  /** Starting paper balance for a new paper account (fixture). */
  startingBalanceUsdt: '10000'
} as const;

export type EntryReason =
  | 'POSITION_NOT_FLAT'
  | 'ORDER_UNCERTAIN'
  | 'FEED_STALE'
  | 'SPREAD_TOO_WIDE'
  | 'PRICE_DEVIATION'
  | 'EMA_UNAVAILABLE'
  | 'EMA_FILTERED'
  | 'SIZE_BELOW_MINIMUM'
  | 'RISK_LIMIT'
  | 'PROTECTION_FAILED'
  | 'INSUFFICIENT_MARGIN';

export const ENTRY_REASON_TEXT: Record<EntryReason, string> = {
  POSITION_NOT_FLAT: 'A position is already open on this pair; adds and reversals are not enabled yet.',
  ORDER_UNCERTAIN: 'An earlier order on this pair is still unresolved.',
  FEED_STALE: 'No fresh price was available when the signal was evaluated.',
  SPREAD_TOO_WIDE: 'The bid/ask spread was wider than allowed.',
  PRICE_DEVIATION: 'The exchange price moved too far from the TradingView reference price.',
  EMA_UNAVAILABLE: 'EMA 200 could not be calculated from aligned closed candles.',
  EMA_FILTERED: 'The EMA 200 filter did not allow this direction.',
  SIZE_BELOW_MINIMUM: 'Order cost and leverage are below the contract minimum. Size is never increased automatically.',
  RISK_LIMIT: 'One of your risk limits would be exceeded.',
  PROTECTION_FAILED: 'A valid stop loss could not be attached to the opening order.',
  INSUFFICIENT_MARGIN: 'Your paper balance cannot cover the margin and fees.'
};

export interface PaperQuote {
  bid: string;
  ask: string;
  mark: string;
  asOf: Date;
  /** FIXTURE or MEXC_PUBLIC; recorded with every entry decision. Defaults to FIXTURE. */
  source?: string;
}

export interface EntryInput {
  side: 'LONG' | 'SHORT';
  settings: Pick<OrderBlockSettings, 'orderCostUsdt' | 'leverage' | 'stop' | 'takeProfit' | 'trailing' | 'risk' | 'marginMode'>;
  version: { emaFilter: 'OFF' | 'EMA200'; maxPriceDeviationPct: string };
  referencePrice: string;
  quote: PaperQuote | null;
  ema: EmaResult | null;
  spec: ContractSpec;
  account: { availableUsdt: string };
  exposure: { openPositionInScope: boolean; unresolvedIntentInScope: boolean; openPositionsForOwner: number };
  now: Date;
}

export interface ApprovedEntry {
  ok: true;
  sizing: SidePreview;
  liquidationPrice: string;
  requiredUsdt: string;
  checks: Record<string, unknown>;
}
export type EntryEvaluation = ApprovedEntry | { ok: false; reason: EntryReason; detail: Record<string, unknown> };

const D = (v: Decimal.Value) => new Decimal(v);
const min = (a: string | null, ceiling: string) => (a === null ? D(ceiling) : Decimal.min(a, ceiling));

/** Isolated-margin liquidation estimate (labelled estimate; cross margin depends on the account). */
export function estimateLiquidation(side: 'LONG' | 'SHORT', entry: string, leverage: number, mmr: string = PAPER_POLICY.maintenanceMarginRate): string {
  const inv = D(1).div(leverage);
  const p = side === 'LONG' ? D(entry).times(D(1).minus(inv).plus(mmr)) : D(entry).times(D(1).plus(inv).minus(mmr));
  return p.toDecimalPlaces(8).toFixed();
}

export function evaluatePaperEntry(i: EntryInput): EntryEvaluation {
  const checks: Record<string, unknown> = {};

  // STR-07 / ARC-02: only a confirmed flat scope with no unresolved order may open.
  if (i.exposure.unresolvedIntentInScope) return { ok: false, reason: 'ORDER_UNCERTAIN', detail: {} };
  if (i.exposure.openPositionInScope) return { ok: false, reason: 'POSITION_NOT_FLAT', detail: {} };

  // MKT-02 freshness.
  if (!i.quote) return { ok: false, reason: 'FEED_STALE', detail: { cause: 'NO_QUOTE' } };
  const ageMs = i.now.getTime() - i.quote.asOf.getTime();
  if (ageMs > PAPER_POLICY.maxQuoteAgeSeconds * 1000 || ageMs < -PAPER_POLICY.quoteClockToleranceSeconds * 1000) {
    return { ok: false, reason: 'FEED_STALE', detail: { quoteAsOf: i.quote.asOf.toISOString(), ageSeconds: Math.round(ageMs / 1000) } };
  }
  const source: MarketSource = i.quote.source === 'MEXC_PUBLIC' ? 'MEXC_PUBLIC' : 'FIXTURE';
  checks.quote = { bid: i.quote.bid, ask: i.quote.ask, mark: i.quote.mark, asOf: i.quote.asOf.toISOString(), source };

  // Spread and price deviation (investor caps never exceed platform ceilings).
  const mid = D(i.quote.bid).plus(i.quote.ask).div(2);
  const spreadPct = D(i.quote.ask).minus(i.quote.bid).div(mid).times(100);
  const maxSpread = min(i.settings.risk.maxSpreadPct, PLATFORM_CEILINGS.maxSpreadPct);
  if (spreadPct.gt(maxSpread)) return { ok: false, reason: 'SPREAD_TOO_WIDE', detail: { spreadPct: spreadPct.toFixed(4), maxSpreadPct: maxSpread.toFixed() } };
  const devPct = mid.minus(i.referencePrice).abs().div(i.referencePrice).times(100);
  const maxDev = Decimal.min(i.version.maxPriceDeviationPct, min(i.settings.risk.maxPriceDeviationPct, PLATFORM_CEILINGS.maxPriceDeviationPct));
  if (devPct.gt(maxDev)) return { ok: false, reason: 'PRICE_DEVIATION', detail: { deviationPct: devPct.toFixed(4), maxDeviationPct: maxDev.toFixed(), referencePrice: i.referencePrice, mid: mid.toFixed() } };
  checks.spreadPct = spreadPct.toFixed(4);
  checks.deviationPct = devPct.toFixed(4);

  // STR-09 EMA filter (Off bypasses).
  const ema = applyEmaFilter(i.version.emaFilter, i.side, i.ema);
  checks.ema = ema.detail;
  if (!ema.pass) return { ok: false, reason: ema.reason, detail: ema.detail };

  // EXE-01 sizing from the executable side of the fresh quote.
  const quote = { bid: i.quote.bid, ask: i.quote.ask, mark: i.quote.mark, asOf: i.quote.asOf.toISOString(), source };
  const preview = previewOrder({ ...i.settings, direction: i.side === 'LONG' ? 'LONG_ONLY' : 'SHORT_ONLY' }, i.spec, quote);
  const s = preview.sides[0]!;
  const codes = s.reasons.map((r) => r.code);
  if (codes.includes('SIZE_BELOW_MINIMUM') || codes.includes('SIZE_ABOVE_MAXIMUM')) return { ok: false, reason: 'SIZE_BELOW_MINIMUM', detail: { contracts: s.contracts, minQty: i.spec.minQty, reasons: s.reasons } };
  if (codes.includes('STOP_WRONG_SIDE')) return { ok: false, reason: 'PROTECTION_FAILED', detail: { cause: 'STOP_WRONG_SIDE', stopPrice: s.stopPrice, entryPrice: s.entryPrice } };
  if (codes.includes('RISK_LIMIT')) return { ok: false, reason: 'RISK_LIMIT', detail: { reasons: s.reasons } };
  const maxPositions = i.settings.risk.maxOpenPositions ?? PLATFORM_CEILINGS.maxOpenPositions;
  if (i.exposure.openPositionsForOwner >= maxPositions) return { ok: false, reason: 'RISK_LIMIT', detail: { cause: 'MAX_OPEN_POSITIONS', open: i.exposure.openPositionsForOwner, max: maxPositions } };

  // EXE-02: the stop must sit before the estimated liquidation with a buffer.
  const liq = estimateLiquidation(i.side, s.entryPrice, i.settings.leverage);
  const buffer = D(s.entryPrice).times(PAPER_POLICY.liquidationBufferPct).div(100);
  const safe = i.side === 'LONG' ? D(s.stopPrice).minus(liq).gte(buffer) : D(liq).minus(s.stopPrice).gte(buffer);
  if (!safe) return { ok: false, reason: 'PROTECTION_FAILED', detail: { cause: 'STOP_BEYOND_LIQUIDATION_BUFFER', stopPrice: s.stopPrice, liquidationEstimate: liq } };

  // Funds: margin plus estimated entry fee must fit the available paper balance.
  const required = D(s.estimatedMarginUsdt).plus(s.estimatedEntryFeeUsdt);
  if (required.gt(i.account.availableUsdt)) return { ok: false, reason: 'INSUFFICIENT_MARGIN', detail: { requiredUsdt: required.toFixed(), availableUsdt: i.account.availableUsdt } };

  checks.dailyLoss = 'not applicable until exits exist';
  checks.cooldown = 'not applicable until exits exist';
  return { ok: true, sizing: s, liquidationPrice: liq, requiredUsdt: required.toFixed(), checks };
}
