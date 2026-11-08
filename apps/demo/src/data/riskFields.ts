import { PLATFORM_LIMITS } from './strategyCatalog';
import type { NumericRiskKey } from '../types/risk';

export type RiskSection = 'order' | 'limits' | 'quality';

export interface RiskFieldMeta {
  key: NumericRiskKey;
  label: string;
  unit: string;
  section: RiskSection;
  integer?: boolean;
  /** Minimum allowed value. */
  min: number;
  /** Whether the minimum itself is allowed. */
  minInclusive: boolean;
  /** Fictional platform cap — values above are rejected, never silently changed. */
  platformCap?: number;
  /** Sanity maximum for fields without a platform cap. */
  max?: number;
  hint?: string;
  decimals: number;
}

export const riskFields: RiskFieldMeta[] = [
{ key: 'defaultOrderCost', label: 'Default order cost', unit: 'USDT', section: 'order', min: 0, minInclusive: false, platformCap: PLATFORM_LIMITS.maxOrderCost, decimals: 2, hint: 'Initial margin per entry, excluding fees and funding.' },
{ key: 'maxOpenPositions', label: 'Maximum open positions', unit: 'positions', section: 'limits', integer: true, min: 1, minInclusive: true, platformCap: PLATFORM_LIMITS.maxOpenPositions, decimals: 0 },
{ key: 'maxAggregateNotional', label: 'Maximum aggregate notional', unit: 'USDT', section: 'limits', min: 0, minInclusive: false, platformCap: PLATFORM_LIMITS.maxAggregateNotional, decimals: 2 },
{ key: 'maxAggregateStopRisk', label: 'Maximum aggregate initial stop risk', unit: 'USDT', section: 'limits', min: 0, minInclusive: false, platformCap: PLATFORM_LIMITS.maxAggregateStopRisk, decimals: 2, hint: 'Sum of estimated losses to each position’s initial stop.' },
{ key: 'maxOrderCost', label: 'Maximum order cost', unit: 'USDT', section: 'limits', min: 0, minInclusive: false, platformCap: PLATFORM_LIMITS.maxOrderCost, decimals: 2 },
{ key: 'dailyLossLimit', label: 'Daily loss limit', unit: 'USDT', section: 'limits', min: 0, minInclusive: false, max: 100000, decimals: 2, hint: 'Reaching it blocks new entries. Positions are not closed automatically.' },
{ key: 'freeMarginReserve', label: 'Minimum free-margin reserve', unit: 'USDT', section: 'limits', min: 0, minInclusive: true, max: 100000, decimals: 2 },
{ key: 'cooldownMinutes', label: 'Cooldown after a completed trade', unit: 'min', section: 'limits', integer: true, min: 0, minInclusive: true, max: 1440, decimals: 0 },
{ key: 'maxSpreadPct', label: 'Maximum spread', unit: '%', section: 'quality', min: 0, minInclusive: false, max: 5, decimals: 2 },
{ key: 'maxDeviationPct', label: 'Maximum deviation from signal reference price', unit: '%', section: 'quality', min: 0, minInclusive: false, max: 5, decimals: 2 },
{ key: 'maxSignalAgeSec', label: 'Maximum signal age', unit: 's', section: 'quality', integer: true, min: 1, minInclusive: true, max: 3600, decimals: 0, hint: 'A strategy’s stricter limit still applies (Supertrend 15m: 30 s).' }];