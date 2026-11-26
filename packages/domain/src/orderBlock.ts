import { z } from 'zod';
import { Decimal, isDecimalString, normDecimal, percentDistance, positiveDecimal } from './decimal';
import { DomainError, ErrorCode, type Issue } from './errors';
import { ALLOWED_MODES } from './liveTransport';
import { tradingWindowSchema, type TradingWindow } from './tradingWindow';
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
/** Split Take Profit levels per side (raised from 3; one-, two- and three-level plans stay valid). */
export const MAX_TP_LEVELS = 5;
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

/**
 * Share of a quantity an exit closes when it fires: 1 to 100 inclusive, decimals up to 8 places
 * (the resulting quantity is rounded down to the contract step).
 */
export const exitClosePct = z
  .string({ error: 'Enter the value as a decimal string.' })
  .trim()
  .refine(isDecimalString, 'Enter a number from 1 to 100 with up to 8 decimal places.')
  .refine((v) => !isDecimalString(v) || (new Decimal(v).gte(1) && new Decimal(v).lte(100)), 'Enter a value from 1 to 100.')
  .transform(normDecimal);

/** Share of the confirmed opening quantity, 0 to 100 inclusive (0 is a real value, not "empty"). */
export const allocationPct = z
  .string({ error: 'Enter the value as a decimal string.' })
  .trim()
  .refine(isDecimalString, 'Enter a number from 0 to 100 with up to 8 decimal places.')
  .refine((v) => !isDecimalString(v) || new Decimal(v).lte(100), 'Enter a value from 0 to 100.')
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
    levels: z.array(takeProfitLevelSchema).max(MAX_TP_LEVELS, `At most ${MAX_TP_LEVELS} targets.`),
    /**
     * Overall Take Profit allocation: share of the confirmed opening quantity the targets manage
     * (split shares divide it). The rest is Trailing Take Profit's pool (or stays under the stop
     * loss when trailing is off). Omitted = 100% (plans saved before the field existed).
     */
    allocationPct: allocationPct.optional()
  })
  .strict();

/**
 * Legacy shared EXT-04 Trailing Take Profit (one setting for both sides). `closePct` was its share
 * of the confirmed opening quantity. Still parsed from old clients and old snapshots; a save lifts
 * it to per-side settings (liftLegacyExitPlan).
 */
export const trailingSchema = z
  .object({
    enabled: z.boolean(),
    activationPct: percentDistance.nullable(),
    distancePct: percentDistance.nullable(),
    closePct: allocationPct.nullable().optional(),
    basis: z.enum(PRICE_BASES)
  })
  .strict();

/**
 * Target close inside Trailing Take Profit: once price reaches `movePct` from the confirmed
 * average entry, close `closePct` of the trailing pool at market, once per position (it does not
 * wait for activation or a pullback). Trailing keeps running on what is left.
 */
export const targetCloseSchema = z
  .object({
    enabled: z.boolean(),
    movePct: percentDistance.nullable(),
    closePct: exitClosePct.nullable()
  })
  .strict();

/**
 * EXT-04 Trailing Take Profit for ONE position side (Long and Short are set independently).
 * - activationPct: favourable price move from the confirmed average entry before it arms;
 * - distancePct (retracement): pullback from the best price since activation that triggers a close;
 * - closePct: share of the trailing pool to close on each trigger, 1-100. The trailing pool is the
 *   confirmed remaining quantity that unfinished Take Profit targets do not reserve. Below 100%
 *   the rest stays open under the same stop loss and trailing rearms only after a new best price;
 * - targetClose: optional one-shot target inside trailing (targetCloseSchema).
 * Percentages of price are movement from entry, before fees and leverage. `basis` is the trigger
 * price stream. Fields are nullable only so a disabled side can be stored; a save of an enabled
 * side never accepts null (refineSettings).
 */
export const trailingSideSchema = z
  .object({
    enabled: z.boolean(),
    activationPct: percentDistance.nullable(),
    distancePct: percentDistance.nullable(),
    closePct: exitClosePct.nullable(),
    targetClose: targetCloseSchema.nullable().optional(),
    basis: z.enum(PRICE_BASES)
  })
  .strict();

export type TrailingSideSettings = z.output<typeof trailingSideSchema>;
export type LegacyTrailingSettings = z.output<typeof trailingSchema>;

export const TRAILING_OFF: TrailingSideSettings = { enabled: false, activationPct: null, distancePct: null, closePct: null, targetClose: null, basis: 'MARK' };

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
  /**
   * EXT-02/03 Take Profit per position side. The side of the confirmed entry selects one at entry
   * and it is saved with the position. Both are stored whatever the direction, so changing the
   * permitted direction never loses a saved configuration.
   */
  takeProfitLong: takeProfitSchema,
  takeProfitShort: takeProfitSchema,
  /** EXT-04 Trailing Take Profit per position side, selected at entry like Take Profit. */
  trailingLong: trailingSideSchema,
  trailingShort: trailingSideSchema,
  /**
   * "Sync Admin Setting": entries use the latest published Common Exit Definition for Take Profit
   * and Trailing Take Profit instead of the four fields above, which are kept (and restored when
   * sync is turned off). Omitted = unchanged on update, off on create.
   */
  syncAdminExit: z.boolean().optional(),
  weekdays: weekdaysSchema,
  /** Optional daily window for new exposure (null or omitted = All day). */
  tradingWindow: tradingWindowSchema.nullable().optional(),
  allowAdds: z.boolean(),
  maxAdds: z.number().int().nullable(),
  risk: riskSchema
});

type SettingsBase = z.output<typeof settingsBase>;

/** Structural subset of zod's refinement context. */
interface IssueSink {
  addIssue(issue: { code: 'custom'; path: (string | number)[]; message: string }): void;
}

/** A decimal string or null (an empty or partly typed field is reported by its own schema). */
const dec = (v: string | null | undefined) => (typeof v === 'string' && isDecimalString(v.trim()) ? new Decimal(v.trim()) : null);

/**
 * Cross-field rules. Runs on raw input too (while the investor is typing), so it must never
 * throw on an empty or partial number: such values are skipped here and reported by their own
 * field schema.
 */
/** Rules for one side's Take Profit configuration; issues are reported under `key`. */
function refineTakeProfit(tp: SettingsBase['takeProfitLong'], key: 'takeProfitLong' | 'takeProfitShort', add: (path: (string | number)[], message: string) => void): void {
  if (tp.mode === 'OFF' && tp.levels.length > 0) add([key, 'levels'], 'Remove targets when take profit is off.');
  if (tp.mode === 'FIXED') {
    if (tp.levels.length !== 1) add([key, 'levels'], 'Fixed take profit has exactly one target.');
    else {
      // The single target manages the whole Take Profit share; the split with Trailing Take
      // Profit is set by Trailing Take Profit's "Position to close (%)".
      const close = dec(tp.levels[0]!.closePct);
      if (close && !close.eq(100)) add([key, 'levels', 0, 'closePct'], 'A fixed target manages the whole Take Profit share (100%).');
    }
  }
  if (tp.mode === 'SPLIT') {
    if (tp.levels.length < 2) add([key, 'levels'], `Split take profit needs 2 to ${MAX_TP_LEVELS} targets.`);
    tp.levels.forEach((l, i) => {
      const prev = tp.levels[i - 1];
      const cur = dec(l.movePct);
      const before = prev ? dec(prev.movePct) : null;
      if (cur && before && !cur.gt(before)) add([key, 'levels', i, 'movePct'], 'Must be further than the previous target.');
    });
    // EXT-03: the targets divide the Take Profit share between them, so they total exactly 100%.
    const parts = tp.levels.map((l) => dec(l.closePct));
    if (parts.every((p) => p !== null)) {
      const total = parts.reduce((sum, p) => sum.plus(p!), new Decimal(0));
      if (!total.eq(100)) add([key], `Target shares total ${total.toFixed()}% — they must total exactly 100% of the Take Profit share.`);
    }
  }
  const ids = new Set(tp.levels.map((l) => l.id));
  if (ids.size !== tp.levels.length) add([key, 'levels'], 'Target IDs must be unique.');
}

/** Sides a direction can open. */
export const sidesOf = (d: Direction): ('LONG' | 'SHORT')[] => (d === 'LONG_ONLY' ? ['LONG'] : d === 'SHORT_ONLY' ? ['SHORT'] : ['LONG', 'SHORT']);

/** Rules for one side's Trailing Take Profit; issues are reported under `key`. */
function refineTrailing(t: TrailingSideSettings, key: 'trailingLong' | 'trailingShort', add: (path: (string | number)[], message: string) => void): void {
  if (t.enabled) {
    // All values are explicit: activation is never assumed or derived from the retracement.
    if (t.activationPct === null) add([key, 'activationPct'], 'Enter Activate after profit (%).');
    if (t.distancePct === null) add([key, 'distancePct'], 'Enter Retracement (%).');
    if (t.closePct === null) add([key, 'closePct'], 'Enter Close on each trigger (%), from 1 to 100.');
    const tc = t.targetClose;
    if (tc?.enabled) {
      if (tc.movePct === null) add([key, 'targetClose', 'movePct'], 'Enter the target close move (%).');
      if (tc.closePct === null) add([key, 'targetClose', 'closePct'], 'Enter the target close share (%), from 1 to 100.');
    } else if (tc && (tc.movePct !== null || tc.closePct !== null)) add([key, 'targetClose'], 'Clear the target close values while it is off.');
  } else if (t.distancePct !== null || t.activationPct !== null || t.closePct !== null || (t.targetClose && (t.targetClose.enabled || t.targetClose.movePct !== null || t.targetClose.closePct !== null))) {
    add([key], 'Clear the Trailing Take Profit values while it is off.');
  }
}

/** The exit-plan part of the settings (Take Profit and Trailing Take Profit per side). */
export interface ExitPlanSettings {
  takeProfitLong: TakeProfitSettings;
  takeProfitShort: TakeProfitSettings;
  trailingLong: TrailingSideSettings;
  trailingShort: TrailingSideSettings;
}

export const EXIT_PLAN_FIELDS = ['takeProfitLong', 'takeProfitShort', 'trailingLong', 'trailingShort'] as const;

/** Cross-field exit-plan rules shared by order blocks and the admin Common Exit Definition. */
export function refineExitPlan(s: ExitPlanSettings, add: (path: (string | number)[], message: string) => void): void {
  // Both sides are always editable (and saved) whatever the direction, so both are validated:
  // a side the direction does not trade yet must still be a usable plan once it is allowed.
  refineTakeProfit(s.takeProfitLong, 'takeProfitLong', add);
  refineTakeProfit(s.takeProfitShort, 'takeProfitShort', add);
  refineTrailing(s.trailingLong, 'trailingLong', add);
  refineTrailing(s.trailingShort, 'trailingShort', add);
}

function refineSettings(s: SettingsBase, ctx: IssueSink): void {
  const add = (path: (string | number)[], message: string) => ctx.addIssue({ code: 'custom', path, message });
  refineExitPlan(s, add);
  if (s.allowAdds) {
    if (s.maxAdds === null || s.maxAdds < 1 || s.maxAdds > MAX_ADDS) add(['maxAdds'], `Enter a whole number from 1 to ${MAX_ADDS}.`);
  } else if (s.maxAdds !== null) {
    add(['maxAdds'], 'Leave additional entries empty while they are off.');
  }
}

/**
 * Clients written before per-side Take Profit send one `takeProfit`: it becomes the configuration
 * of both sides (a side the request sends itself wins).
 */
export function liftSharedTakeProfit(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !('takeProfit' in raw)) return raw;
  const { takeProfit, ...rest } = raw as Record<string, unknown>;
  return { takeProfitLong: takeProfit, takeProfitShort: takeProfit, ...rest };
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * One side of a legacy shared Trailing Take Profit, converted to the per-side model with the same
 * effect on the first trigger:
 * - Take Profit on: the old "Position to close (%)" (c, share of the opening quantity) becomes the
 *   Take Profit allocation 100 - c, and trailing closes 100% of its pool (= the old c% allocation);
 * - Take Profit off: trailing closes c% of the remaining quantity. Unlike before, it may close c%
 *   of what is left again after a new best price (rearm on the remainder).
 * A side with Take Profit on and no allocation yet gets 100 - c (trailing on) or 100 (off).
 */
export function liftLegacyTrailingSide(legacy: unknown, tp: unknown): { trailing: unknown; takeProfit: unknown } {
  if (!isObj(legacy)) return { trailing: legacy, takeProfit: tp };
  const tpOn = isObj(tp) && tp.mode !== undefined && tp.mode !== 'OFF';
  const c = typeof legacy.closePct === 'string' ? legacy.closePct : null;
  const cOk = c !== null && isDecimalString(c.trim()) && new Decimal(c.trim()).gte(0) && new Decimal(c.trim()).lte(100);
  const enabled = legacy.enabled === true;
  // An invalid legacy value is passed through unchanged so it is reported under trailing*.closePct.
  const trailing = enabled
    ? { enabled: true, activationPct: legacy.activationPct ?? null, distancePct: legacy.distancePct ?? null, closePct: c === null ? null : !cOk ? c : tpOn ? '100' : c, targetClose: null, basis: legacy.basis ?? 'MARK' }
    : // Off: stray values are carried over so validation still asks for them to be cleared.
      { enabled: false, activationPct: legacy.activationPct ?? null, distancePct: legacy.distancePct ?? null, closePct: c, targetClose: null, basis: legacy.basis ?? 'MARK' };
  let takeProfit = tp;
  if (tpOn && isObj(tp) && tp.allocationPct === undefined) {
    const share = enabled && cOk ? new Decimal(100).minus(new Decimal(c!.trim())) : new Decimal(100);
    takeProfit = { ...tp, allocationPct: share.toFixed() };
  }
  return { trailing, takeProfit };
}

/**
 * Clients and snapshots written before per-side Trailing Take Profit send one `trailing`: it is
 * converted for each side against that side's Take Profit (liftLegacyTrailingSide). A side the
 * request sends itself wins.
 */
export function liftLegacyExitPlan(raw: unknown): unknown {
  const r = liftSharedTakeProfit(raw);
  if (!isObj(r) || !('trailing' in r)) return r;
  const { trailing, ...rest } = r;
  const long = liftLegacyTrailingSide(trailing, rest.takeProfitLong);
  const short = liftLegacyTrailingSide(trailing, rest.takeProfitShort);
  return {
    ...rest,
    ...(rest.takeProfitLong !== undefined && !('trailingLong' in rest) ? { takeProfitLong: long.takeProfit } : {}),
    ...(rest.takeProfitShort !== undefined && !('trailingShort' in rest) ? { takeProfitShort: short.takeProfit } : {}),
    ...(!('trailingLong' in rest) ? { trailingLong: long.trailing } : {}),
    ...(!('trailingShort' in rest) ? { trailingShort: short.trailing } : {})
  };
}

const settingsStrict = settingsBase.strict().superRefine((s, ctx) => refineSettings(s, ctx));
const createStrict = settingsBase
  .extend({
    instrumentId: z.uuid({ error: 'Select a trading pair.' }),
    mode: z.enum(MODES)
  })
  .strict()
  .superRefine((s, ctx) => refineSettings(s, ctx));
/** PATCH: any subset of settings, plus an optional change of trading mode (checked by the server). */
const patchStrict = settingsBase.partial().extend({ mode: z.enum(MODES).optional() }).strict();

export const orderBlockSettingsSchema = z.preprocess(liftLegacyExitPlan, settingsStrict);
export const orderBlockCreateSchema = z.preprocess(liftLegacyExitPlan, createStrict);
/** PATCH body: any subset of settings and optionally `mode`. The instrument cannot change. The server lifts a legacy `trailing` against the merged Take Profit before parsing. */
export const orderBlockPatchSchema = z.preprocess(liftSharedTakeProfit, patchStrict);

export type OrderBlockSettings = z.output<typeof settingsStrict>;
export type OrderBlockCreate = z.output<typeof createStrict>;
export type OrderBlockPatch = z.output<typeof patchStrict>;
/** Client-side shape before validation (decimals still strings, weekdays any order). */
export type OrderBlockSettingsInput = z.input<typeof settingsStrict>;
export type TakeProfitSettings = OrderBlockSettings['takeProfitLong'];

/** The Take Profit configuration a position on `side` uses (selected at entry from the actual side). */
export const takeProfitFor = (s: Pick<OrderBlockSettings, 'takeProfitLong' | 'takeProfitShort'>, side: 'LONG' | 'SHORT'): TakeProfitSettings =>
  side === 'LONG' ? s.takeProfitLong : s.takeProfitShort;

/** The Trailing Take Profit configuration a position on `side` uses (selected at entry from the actual side). */
export const trailingFor = (s: Pick<OrderBlockSettings, 'trailingLong' | 'trailingShort'>, side: 'LONG' | 'SHORT'): TrailingSideSettings =>
  side === 'LONG' ? s.trailingLong : s.trailingShort;

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

/** D1, OPS-02: Paper and Live can be configured; Live orders still pass every gate in live.ts. */
export function assertModeAllowed(mode: Mode): void {
  if (!(ALLOWED_MODES as readonly string[]).includes(mode)) {
    throw new DomainError(422, ErrorCode.LIVE_DISABLED, 'Live trading is unavailable in this build.');
  }
}

/**
 * The exit plan entries of a block actually use: its own (custom) Take Profit and Trailing Take
 * Profit, or the latest published Common Exit Definition while "Sync Admin Setting" is on.
 */
export interface EffectiveExitPlanDto extends ExitPlanSettings {
  source: 'CUSTOM' | 'ADMIN';
  /** Admin rule version in use (source ADMIN), else null. */
  adminVersion: number | null;
  adminPublishedAt: string | null;
  /** Sync is on but no Common Exit Definition is published: the custom plan applies meanwhile. */
  adminUnavailable?: boolean;
}

/** API representation of an order block (§10: decimals as strings, opaque IDs). */
export interface OrderBlockDto extends Omit<OrderBlockSettings, 'tradingWindow' | 'syncAdminExit'> {
  /** null = All day. */
  tradingWindow: TradingWindow | null;
  syncAdminExit: boolean;
  /** What new entries use (custom or the admin definition). */
  effectiveExit: EffectiveExitPlanDto;
  id: string;
  instrumentId: string;
  symbol: string;
  exchange: string;
  mode: Mode;
  timezone: string;
  status: BlockStatus;
  revision: number;
  /**
   * Saved before Trailing Take Profit with trailing on. New entries are held until the
   * investor saves trailing settings with an explicit activation value (or turns trailing off).
   */
  trailingConversionRequired: boolean;
  createdAt: string;
  updatedAt: string;
}

/** Overall Take Profit allocation of a side, in % of the confirmed opening quantity. */
export function takeProfitAllocationPct(tp: { mode: TakeProfitMode; allocationPct?: string | null }): Decimal {
  if (tp.mode === 'OFF') return new Decimal(0);
  return Decimal.min(100, Decimal.max(0, dec(tp.allocationPct) ?? new Decimal(100)));
}

/**
 * Share of each new position, in % of the confirmed opening quantity, that each exit manages.
 * Take Profit (when on) manages its overall allocation. With Trailing Take Profit on, the rest is
 * its pool (it closes "Close on each trigger (%)" of that pool per trigger). Anything left is
 * unallocated: it stays open under the stop loss and signal or manual closes. The fixed Stop
 * Loss always covers the whole open quantity.
 */
export function exitAllocation(s: { takeProfit: { mode: TakeProfitMode; allocationPct?: string | null }; trailing: { enabled: boolean } }): {
  takeProfitPct: string;
  trailingPct: string;
  unallocatedPct: string;
} {
  const takeProfit = takeProfitAllocationPct(s.takeProfit);
  const trailing = s.trailing.enabled ? new Decimal(100).minus(takeProfit) : new Decimal(0);
  return { takeProfitPct: takeProfit.toFixed(), trailingPct: trailing.toFixed(), unallocatedPct: new Decimal(100).minus(trailing).minus(takeProfit).toFixed() };
}

/**
 * Contracts of a confirmed opening quantity assigned to Take Profit and to the trailing pool. The
 * non-Take-Profit share is rounded down to the contract step and Take Profit (when on) gets the
 * exact rest, so together they never exceed the position (the same rounding as before per-side
 * trailing, so converted plans size identically).
 */
export function allocateContracts(
  baseContracts: string,
  s: { takeProfit: { mode: TakeProfitMode; allocationPct?: string | null }; trailing: { enabled: boolean } },
  qtyStep: string
): { takeProfitContracts: string; trailingContracts: string } {
  const base = new Decimal(baseContracts);
  if (s.takeProfit.mode === 'OFF') return { takeProfitContracts: '0', trailingContracts: s.trailing.enabled ? base.toFixed() : '0' };
  const rest = new Decimal(100).minus(takeProfitAllocationPct(s.takeProfit));
  const nonTp = Decimal.min(base, base.times(rest).div(100).div(qtyStep).floor().times(qtyStep));
  return { takeProfitContracts: base.minus(nonTp).toFixed(), trailingContracts: s.trailing.enabled ? nonTp.toFixed() : '0' };
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
    takeProfitLong: dto.takeProfitLong,
    takeProfitShort: dto.takeProfitShort,
    trailingLong: dto.trailingLong,
    trailingShort: dto.trailingShort,
    syncAdminExit: dto.syncAdminExit,
    weekdays: dto.weekdays as Weekday[],
    tradingWindow: dto.tradingWindow,
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
  'takeProfitLong',
  'takeProfitShort',
  'trailingLong',
  'trailingShort',
  'syncAdminExit',
  'weekdays',
  'tradingWindow',
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

/* ───────────────────────── Admin → Common Exit Definition ───────────────────────── */

/**
 * The admin's central exit plan: the same Take Profit and Trailing Take Profit fields and rules as
 * an investor's Exit Plan (independent Long and Short, Fixed / Split / Off, up to five split levels,
 * overall Take Profit allocation, trailing activation, retracement, target close, close share).
 */
export const commonExitDefinitionSchema = z
  .object({
    takeProfitLong: takeProfitSchema,
    takeProfitShort: takeProfitSchema,
    trailingLong: trailingSideSchema,
    trailingShort: trailingSideSchema
  })
  .strict()
  .superRefine((s, ctx) => refineExitPlan(s, (path, message) => ctx.addIssue({ code: 'custom', path, message })));

export type CommonExitDefinition = z.output<typeof commonExitDefinitionSchema>;

/** Where a published admin revision applies. */
export const EXIT_APPLY_SCOPES = ['FUTURE_ENTRIES', 'EXISTING_POSITIONS'] as const;
export type ExitApplyScope = (typeof EXIT_APPLY_SCOPES)[number];

export const commonExitPublishSchema = z
  .object({
    plan: z.unknown(),
    /** FUTURE_ENTRIES (default): open positions keep their snapshot. EXISTING_POSITIONS: also update linked open positions. */
    scope: z.enum(EXIT_APPLY_SCOPES).default('FUTURE_ENTRIES'),
    /** The version the admin edited (optimistic concurrency). null = first publish. */
    expectedVersion: z.number().int().nonnegative().nullable(),
    note: z.string().trim().max(500).optional()
  })
  .strict();

/** Fields of an exit plan that differ (for the audit log and notifications). */
export function exitPlanChanges(before: Partial<ExitPlanSettings> | null, after: ExitPlanSettings): { field: string; before: unknown; after: unknown }[] {
  return EXIT_PLAN_FIELDS.filter((k) => canonicalJson(before?.[k] ?? null) !== canonicalJson(after[k])).map((k) => ({ field: k, before: before?.[k] ?? null, after: after[k] }));
}

/** JSON with object keys sorted (stored jsonb does not keep key order). */
function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v as object).sort().filter((k) => (v as Record<string, unknown>)[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonicalJson((v as Record<string, unknown>)[k])}`).join(',')}}`;
  return JSON.stringify(v ?? null);
}
