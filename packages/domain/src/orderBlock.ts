import { z } from 'zod';
import { Decimal, isDecimalString, normDecimal, percentDistance, positiveDecimal } from './decimal';
import { DomainError, ErrorCode, type Issue } from './errors';
import { ALLOWED_MODES } from './liveTransport';
import { canonicalWeekdays, WEEKDAYS, type Weekday } from './weekdays';

/** CFG-03 order block schema. Requirement IDs: CFG-03, CFG-04, UI-03. */
export const MODES = ['PAPER', 'LIVE'] as const;
export const DIRECTIONS = ['LONG_ONLY', 'SHORT_ONLY', 'BOTH'] as const;
export const MARGIN_MODES = ['ISOLATED', 'CROSS'] as const;
export const BLOCK_STATUSES = ['ACTIVE', 'PAUSED'] as const;
export const TP_MODES = ['FIXED', 'SPLIT', 'OFF'] as const;
export const STOP_TYPES = ['PERCENT', 'PRICE'] as const;
/** Exchange price stream a trigger compares against (MKT-01). */
export const PRICE_BASES = ['MARK', 'LAST'] as const;
export const MAX_TP_LEVELS = 3;
export const MAX_ADDS = 10;

export type Mode = (typeof MODES)[number];
export type Direction = (typeof DIRECTIONS)[number];
export type MarginMode = (typeof MARGIN_MODES)[number];
export type BlockStatus = (typeof BLOCK_STATUSES)[number];
export type TakeProfitMode = (typeof TP_MODES)[number];
export type PriceBasis = (typeof PRICE_BASES)[number];
export type StopType = (typeof STOP_TYPES)[number];

/**
 * Platform ceilings (CFG-03 risk). Investors may only set stricter values.
 * Proposed engineering defaults (SRS §13); live values need approval.
 */
export const PLATFORM_CEILINGS = {
  orderCostUsdt: '100000',
  maxOpenPositions: 20,
  maxNotionalUsdt: '1000000',
  maxStopRiskUsdt: '50000',
  dailyLossLimitUsdt: '50000',
  cooldownMinutes: 1440,
  maxSpreadPct: '2',
  maxPriceDeviationPct: '5'
} as const;

const closeFraction = z
  .string({ error: 'Enter the value as a decimal string.' })
  .trim()
  .refine(isDecimalString, 'Enter a number with up to 8 decimal places.')
  .refine((v) => !isDecimalString(v) || (new Decimal(v).gt(0) && new Decimal(v).lte(100)), 'Enter a value above 0 and up to 100.')
  .transform(normDecimal);

/** Stop is required (EXT-01). PERCENT is a distance from entry; PRICE is an absolute trigger price. */
export const stopSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('PERCENT'), value: percentDistance, basis: z.enum(PRICE_BASES) }).strict(),
  z.object({ type: z.literal('PRICE'), value: positiveDecimal, basis: z.enum(PRICE_BASES) }).strict()
]);

export const takeProfitLevelSchema = z
  .object({
    /** Stable level ID (CFG-03). Client-generated, unique within the block. */
    id: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/, 'Invalid level ID.'),
    movePct: percentDistance,
    closePct: closeFraction
  })
  .strict();

export const takeProfitSchema = z
  .object({
    mode: z.enum(TP_MODES),
    levels: z.array(takeProfitLevelSchema).max(MAX_TP_LEVELS, `At most ${MAX_TP_LEVELS} targets.`)
  })
  .strict();

/** EXT-04: activation threshold (favourable move from entry, null = immediately), distance and trigger basis. */
export const trailingSchema = z
  .object({
    enabled: z.boolean(),
    activationPct: percentDistance.nullable(),
    distancePct: percentDistance.nullable(),
    basis: z.enum(PRICE_BASES)
  })
  .strict();

const optionalCap = (max: string, label: string) =>
  positiveDecimal
    .refine((v) => new Decimal(v).lte(max), `${label} cannot exceed the platform ceiling of ${max}.`)
    .nullable();
const optionalIntCap = (max: number, label: string, min = 1) =>
  z.number().int().min(min).max(max, `${label} cannot exceed the platform ceiling of ${max}.`).nullable();

/** CFG-03 optional stricter caps. null = use the platform ceiling. */
export const riskSchema = z
  .object({
    maxOpenPositions: optionalIntCap(PLATFORM_CEILINGS.maxOpenPositions, 'Open positions'),
    maxNotionalUsdt: optionalCap(PLATFORM_CEILINGS.maxNotionalUsdt, 'Notional'),
    maxStopRiskUsdt: optionalCap(PLATFORM_CEILINGS.maxStopRiskUsdt, 'Loss to stop'),
    dailyLossLimitUsdt: optionalCap(PLATFORM_CEILINGS.dailyLossLimitUsdt, 'Daily loss limit'),
    cooldownMinutes: optionalIntCap(PLATFORM_CEILINGS.cooldownMinutes, 'Cooldown', 0),
    maxSpreadPct: optionalCap(PLATFORM_CEILINGS.maxSpreadPct, 'Spread'),
    maxPriceDeviationPct: optionalCap(PLATFORM_CEILINGS.maxPriceDeviationPct, 'Price deviation')
  })
  .strict();

export type RiskSettings = z.output<typeof riskSchema>;

export const EMPTY_RISK: RiskSettings = {
  maxOpenPositions: null,
  maxNotionalUsdt: null,
  maxStopRiskUsdt: null,
  dailyLossLimitUsdt: null,
  cooldownMinutes: null,
  maxSpreadPct: null,
  maxPriceDeviationPct: null
};

export const weekdaysSchema = z
  .array(z.enum(WEEKDAYS, { error: 'Unknown weekday.' }))
  .max(7)
  .transform((d) => canonicalWeekdays(d));

/** Fields an investor edits. Owner, timezone, status and revision are never client input. */
const settingsBase = z.object({
  strategyVersionId: z.uuid({ error: 'Select a strategy.' }),
  direction: z.enum(DIRECTIONS),
  orderCostUsdt: positiveDecimal.refine((v) => new Decimal(v).lte(PLATFORM_CEILINGS.orderCostUsdt), `Order cost cannot exceed ${PLATFORM_CEILINGS.orderCostUsdt} USDT.`),
  leverage: z.number().int('Leverage must be a whole number.').positive(),
  marginMode: z.enum(MARGIN_MODES),
  stop: stopSchema,
  takeProfit: takeProfitSchema,
  trailing: trailingSchema,
  weekdays: weekdaysSchema,
  allowAdds: z.boolean(),
  maxAdds: z.number().int().nullable(),
  risk: riskSchema
});

type SettingsBase = z.output<typeof settingsBase>;

/** Structural subset of zod's refinement context. */
interface IssueSink {
  addIssue(issue: { code: 'custom'; path: (string | number)[]; message: string }): void;
}

function refineSettings(s: SettingsBase, ctx: IssueSink): void {
  const tp = s.takeProfit;
  const add = (path: (string | number)[], message: string) => ctx.addIssue({ code: 'custom', path, message });

  if (tp.mode === 'OFF' && tp.levels.length > 0) add(['takeProfit', 'levels'], 'Remove targets when take profit is off.');
  if (tp.mode === 'FIXED') {
    if (tp.levels.length !== 1) add(['takeProfit', 'levels'], 'Fixed take profit has exactly one target.');
    else if (!new Decimal(tp.levels[0]!.closePct).eq(100)) add(['takeProfit', 'levels', 0, 'closePct'], 'A fixed target closes 100%.');
  }
  if (tp.mode === 'SPLIT') {
    if (tp.levels.length < 2) add(['takeProfit', 'levels'], 'Split take profit needs 2 or 3 targets.');
    tp.levels.forEach((l, i) => {
      const prev = tp.levels[i - 1];
      if (prev && !new Decimal(l.movePct).gt(prev.movePct)) add(['takeProfit', 'levels', i, 'movePct'], 'Must be further than the previous target.');
    });
    const total = tp.levels.reduce((sum, l) => sum.plus(l.closePct), new Decimal(0));
    // A full split allocates 100% (EXT-07). Remainder-to-trailing arrives with M2 exit plans.
    if (!total.eq(100)) add(['takeProfit'], `Close allocations total ${total.toFixed()}% — they must total exactly 100%.`);
  }
  const ids = new Set(tp.levels.map((l) => l.id));
  if (ids.size !== tp.levels.length) add(['takeProfit', 'levels'], 'Target IDs must be unique.');

  if (s.trailing.enabled && s.trailing.distancePct === null) add(['trailing', 'distancePct'], 'Enter a trailing distance.');
  if (!s.trailing.enabled && (s.trailing.distancePct !== null || s.trailing.activationPct !== null)) {
    add(['trailing'], 'Clear trailing values while the trailing stop is off.');
  }

  if (s.allowAdds) {
    if (s.maxAdds === null || s.maxAdds < 1 || s.maxAdds > MAX_ADDS) add(['maxAdds'], `Enter a whole number from 1 to ${MAX_ADDS}.`);
  } else if (s.maxAdds !== null) {
    add(['maxAdds'], 'Leave additional entries empty while they are off.');
  }
}

export const orderBlockSettingsSchema = settingsBase.strict().superRefine((s, ctx) => refineSettings(s, ctx));

export const orderBlockCreateSchema = settingsBase
  .extend({
    instrumentId: z.uuid({ error: 'Select a trading pair.' }),
    mode: z.enum(MODES)
  })
  .strict()
  .superRefine((s, ctx) => refineSettings(s, ctx));

/** PATCH body: any subset of settings. Instrument and mode identify the block and cannot change. */
export const orderBlockPatchSchema = settingsBase.partial().strict();

export type OrderBlockSettings = z.output<typeof orderBlockSettingsSchema>;
export type OrderBlockCreate = z.output<typeof orderBlockCreateSchema>;
export type OrderBlockPatch = z.output<typeof orderBlockPatchSchema>;
/** Client-side shape before validation (decimals still strings, weekdays any order). */
export type OrderBlockSettingsInput = z.input<typeof orderBlockSettingsSchema>;

export function issuesFromZod(error: z.ZodError): Issue[] {
  return error.issues.map((i) => ({ path: i.path.map(String).join('.'), message: i.message }));
}

export type ParseResult<T> = { ok: true; value: T } | { ok: false; issues: Issue[] };

export function parseWith<T>(schema: z.ZodType<T>, raw: unknown): ParseResult<T> {
  const r = schema.safeParse(raw);
  return r.success ? { ok: true, value: r.data } : { ok: false, issues: issuesFromZod(r.error) };
}

/** Published catalog facts the settings must agree with. */
export interface CatalogContext {
  instrument: { id?: string; status: 'PUBLISHED' | 'DISABLED'; leverageChoices: number[] };
  /** instrumentIds: approved contract mappings of the version (CFG-02). Omitted = not checked. */
  version: { published: boolean; permittedDirections: Direction; instrumentIds?: string[] };
}

export function directionPermitted(direction: Direction, permitted: Direction): boolean {
  return permitted === 'BOTH' || permitted === direction;
}

/** D3, EXE-01: cross-record checks the static schema cannot do. */
export function catalogIssues(s: Pick<OrderBlockSettings, 'leverage' | 'direction'>, ctx: CatalogContext): Issue[] {
  const issues: Issue[] = [];
  if (ctx.instrument.status !== 'PUBLISHED') issues.push({ path: 'instrumentId', message: 'This pair is not available.' });
  if (!ctx.instrument.leverageChoices.includes(s.leverage)) issues.push({ path: 'leverage', message: 'Select a leverage available for this pair.' });
  if (!ctx.version.published) issues.push({ path: 'strategyVersionId', message: 'This strategy version is not published.' });
  if (!directionPermitted(s.direction, ctx.version.permittedDirections)) issues.push({ path: 'direction', message: 'The selected strategy does not permit this direction.' });
  if (ctx.instrument.id && ctx.version.instrumentIds && !ctx.version.instrumentIds.includes(ctx.instrument.id)) {
    issues.push({ path: 'strategyVersionId', message: 'This strategy version is not approved for the selected pair.' });
  }
  return issues;
}

/** D1, OPS-02: only Paper can be configured in this build. */
export function assertModeAllowed(mode: Mode): void {
  if (!(ALLOWED_MODES as readonly string[]).includes(mode)) {
    throw new DomainError(422, ErrorCode.LIVE_DISABLED, 'Live trading is unavailable in this build.');
  }
}

/** API representation of an order block (§10: decimals as strings, opaque IDs). */
export interface OrderBlockDto extends OrderBlockSettings {
  id: string;
  instrumentId: string;
  symbol: string;
  exchange: string;
  mode: Mode;
  timezone: string;
  status: BlockStatus;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

/** Editable settings of a stored block, used to merge a PATCH before validating the result. */
export function settingsOf(dto: OrderBlockDto): OrderBlockSettingsInput {
  return {
    strategyVersionId: dto.strategyVersionId,
    direction: dto.direction,
    orderCostUsdt: dto.orderCostUsdt,
    leverage: dto.leverage,
    marginMode: dto.marginMode,
    stop: dto.stop,
    takeProfit: dto.takeProfit,
    trailing: dto.trailing,
    weekdays: dto.weekdays as Weekday[],
    allowAdds: dto.allowAdds,
    maxAdds: dto.maxAdds,
    risk: dto.risk
  };
}

/** Field names an audit diff records (no secrets exist on order blocks). */
export const AUDITED_FIELDS = [
  'strategyVersionId',
  'direction',
  'orderCostUsdt',
  'leverage',
  'marginMode',
  'stop',
  'takeProfit',
  'trailing',
  'weekdays',
  'allowAdds',
  'maxAdds',
  'risk',
  'status'
] as const;

export function changedFields(before: Partial<OrderBlockDto>, after: Partial<OrderBlockDto>): { before: Record<string, unknown>; after: Record<string, unknown> } {
  const b: Record<string, unknown> = {};
  const a: Record<string, unknown> = {};
  for (const k of AUDITED_FIELDS) {
    if (JSON.stringify(before[k]) !== JSON.stringify(after[k])) {
      b[k] = before[k];
      a[k] = after[k];
    }
  }
  return { before: b, after: a };
}
