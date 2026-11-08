import { z } from 'zod';
import { Decimal, percentDistance, positiveDecimal } from './decimal';
import { DIRECTIONS } from './orderBlock';

/** CFG-02 strategy package versions and UI-05 trading pairs (admin configuration). */

export const TIMEFRAMES = ['5m', '15m'] as const;
export const EMA_FILTERS = ['OFF', 'EMA200'] as const;
export const OPPOSITE_POLICIES = ['KEEP_OPEN', 'CLOSE_ONLY', 'CLOSE_AND_REVERSE'] as const;
export type Timeframe = (typeof TIMEFRAMES)[number];
export type EmaFilter = (typeof EMA_FILTERS)[number];
export type OppositePolicy = (typeof OPPOSITE_POLICIES)[number];

export const TIMEFRAME_LABELS: Record<Timeframe, string> = { '5m': '5 minutes', '15m': '15 minutes' };
export const EMA_LABELS: Record<EmaFilter, string> = { OFF: 'Off', EMA200: 'EMA 200' };
export const OPPOSITE_LABELS: Record<OppositePolicy, string> = {
  KEEP_OPEN: 'Keep position open',
  CLOSE_ONLY: 'Close position only',
  CLOSE_AND_REVERSE: 'Close and reverse'
};

export const packageCreateSchema = z.object({ name: z.string().trim().min(3, 'Enter at least 3 characters.').max(80) }).strict();

/** Settings of a draft version. Publishing freezes them (immutable published versions). */
export const strategyVersionDraftSchema = z
  .object({
    timeframe: z.enum(TIMEFRAMES),
    atrLength: z.number().int('Whole number.').min(1).max(200),
    atrFactor: positiveDecimal.refine((v) => new Decimal(v).lte(20), 'Factor must be 20 or less.'),
    permittedDirections: z.enum(DIRECTIONS),
    emaFilter: z.enum(EMA_FILTERS),
    oppositePolicy: z.enum(OPPOSITE_POLICIES),
    signalMaxAgeSeconds: z.number().int().min(10).max(3600),
    maxPriceDeviationPct: percentDistance.refine((v) => new Decimal(v).lte(10), 'At most 10%.'),
    /** Approved contract mappings: pairs this version may trade. */
    instrumentIds: z.array(z.uuid()).min(1, 'Approve at least one pair.').max(50)
  })
  .strict();

export type StrategyVersionDraft = z.output<typeof strategyVersionDraftSchema>;

export const PAPER_TEMPLATE: Omit<StrategyVersionDraft, 'instrumentIds'> = {
  timeframe: '15m',
  atrLength: 10,
  atrFactor: '3',
  permittedDirections: 'BOTH',
  emaFilter: 'OFF',
  oppositePolicy: 'KEEP_OPEN',
  signalMaxAgeSeconds: 120,
  maxPriceDeviationPct: '0.5'
};

const suggestions = {
  suggestedStopPct: percentDistance,
  suggestedTakeProfitPct: percentDistance,
  suggestedTrailingEnabled: z.boolean(),
  suggestedTrailingPct: percentDistance
};

export const tickerSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9]{2,20}USDT$/, 'Enter a USDT perpetual ticker such as BTCUSDT.');

export const instrumentValidateSchema = z.object({ symbol: tickerSchema }).strict();
export const instrumentCreateSchema = z.object({ symbol: tickerSchema, ...suggestions }).strict();
export const instrumentUpdateSchema = z
  .object({
    suggestedStopPct: suggestions.suggestedStopPct.optional(),
    suggestedTakeProfitPct: suggestions.suggestedTakeProfitPct.optional(),
    suggestedTrailingEnabled: suggestions.suggestedTrailingEnabled.optional(),
    suggestedTrailingPct: suggestions.suggestedTrailingPct.optional(),
    status: z.enum(['PUBLISHED', 'DISABLED']).optional()
  })
  .strict();

