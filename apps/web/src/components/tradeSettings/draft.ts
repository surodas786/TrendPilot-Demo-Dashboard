import {
  ALL_WEEKDAYS,
  catalogIssues,
  exchangeLabel,
  MAX_TP_LEVELS,
  orderBlockSettingsSchema,
  parseWith,
  type Direction,
  type ExitPlanSettings,
  type Issue,
  type MarginMode,
  type OrderBlockDto,
  type PriceBasis,
  type RiskSettings,
  type StopType,
  type TakeProfitMode,
  type Weekday
} from '@trendpilot/domain';
import type { InstrumentDto, StrategyVersionDto } from '@trendpilot/db';

export type TpSide = 'LONG' | 'SHORT';
/** Both sides are always shown in the editor, whatever the direction currently allows. */
export const TP_SIDES: readonly TpSide[] = ['LONG', 'SHORT'];
export interface SideTakeProfit {
  mode: TakeProfitMode;
  targets: { id: string; movePct: string; closePct: string }[];
  /** Overall Take Profit allocation (% of the confirmed opening quantity). '' = not entered. */
  allocationPct: string;
}
/** One side's Trailing Take Profit, as typed. */
export interface SideTrailing {
  enabled: boolean;
  activationPct: string;
  /** Retracement (pullback from the best price since activation). */
  distancePct: string;
  /** Close on each trigger: share of the trailing pool, 1-100. */
  closePct: string;
  basis: PriceBasis;
  targetCloseEnabled: boolean;
  targetMovePct: string;
  targetClosePct: string;
}
/** API field and validation path prefix of each side's Take Profit / Trailing Take Profit. */
export const TP_KEY: Record<TpSide, 'takeProfitLong' | 'takeProfitShort'> = { LONG: 'takeProfitLong', SHORT: 'takeProfitShort' };
export const TRAILING_KEY: Record<TpSide, 'trailingLong' | 'trailingShort'> = { LONG: 'trailingLong', SHORT: 'trailingShort' };

/** The exit plan part of a form (investor order block or admin Common Exit Definition). */
export interface ExitDraft {
  tp: Record<TpSide, SideTakeProfit>;
  trailing: Record<TpSide, SideTrailing>;
}

/** Form state for one order block. Strings mirror the inputs; validation is shared with the server. */
export interface Draft extends ExitDraft {
  instrumentId: string;
  strategyVersionId: string;
  direction: Direction;
  orderCostUsdt: string;
  leverage: number | null;
  marginMode: MarginMode;
  stopType: StopType;
  /** Percent distance or absolute price, depending on stopType. */
  stopPct: string;
  stopBasis: PriceBasis;
  /** "Sync Admin Setting": entries use the admin Common Exit Definition; `tp` / `trailing` stay the custom plan. */
  syncAdminExit: boolean;
  weekdays: Weekday[];
  /** CFG-04 trading window: All day, or Start–End (HH:mm) in the block timezone. */
  windowMode: 'ALL_DAY' | 'HOURS';
  windowStart: string;
  windowEnd: string;
  allowAdds: boolean;
  maxAdds: string;
  risk: Record<keyof RiskSettings, string>;
}

export const RISK_FIELDS: { key: keyof RiskSettings; label: string; unit: string; integer?: boolean }[] = [
  { key: 'maxOpenPositions', label: 'Max open positions', unit: '', integer: true },
  { key: 'maxNotionalUsdt', label: 'Max notional', unit: 'USDT' },
  { key: 'maxStopRiskUsdt', label: 'Max loss to stop', unit: 'USDT' },
  { key: 'dailyLossLimitUsdt', label: 'Daily loss limit', unit: 'USDT' },
  { key: 'cooldownMinutes', label: 'Cooldown after exit', unit: 'min', integer: true },
  { key: 'maxSpreadPct', label: 'Max spread', unit: '%' },
  { key: 'maxPriceDeviationPct', label: 'Max price deviation', unit: '%' }
];

const emptyRisk = (): Draft['risk'] => Object.fromEntries(RISK_FIELDS.map((f) => [f.key, ''])) as Draft['risk'];

export const BASIS_LABELS: Record<PriceBasis, string> = { MARK: 'Mark price', LAST: 'Last price' };

export const MAX_TARGETS = MAX_TP_LEVELS;

export const DIRECTION_LABELS: Record<Direction, string> = { LONG_ONLY: 'Long only', SHORT_ONLY: 'Short only', BOTH: 'Long and Short' };
export const OPPOSITE_LABELS = { KEEP_OPEN: 'Keep position open', CLOSE_ONLY: 'Close position only', CLOSE_AND_REVERSE: 'Close and reverse' } as const;

let seq = 0;
export const newTargetId = () => `tp${Date.now().toString(36)}${(seq++).toString(36)}`;

export const pairLabel = (i: Pick<InstrumentDto, 'base' | 'quote'>) => `${i.base}/${i.quote}`;

/** "MEXC" / "Bitunix" for display. */
export const exchangeName = (exchange: string) => exchangeLabel(exchange);

/** Pair list entry: "BTC/USDT · Bitunix BTCUSDT", "BTC/USDT · MEXC BTC_USDT" (the same coin exists once per exchange). */
export const pairOptionLabel = (i: Pick<InstrumentDto, 'base' | 'quote' | 'exchange' | 'exchangeSymbol'> & { marketId?: number | null }) =>
  `${pairLabel(i)} · ${exchangeName(i.exchange)} ${i.exchangeSymbol}${i.marketId !== null && i.marketId !== undefined ? ` (market ${i.marketId})` : ''}`;

/** Currency of order cost and money amounts for a pair: its settlement/quote currency (USDT on MEXC and Bitunix, USDC on Lighter). */
export const costCurrency = (i: Pick<InstrumentDto, 'quote'> | undefined) => i?.quote || 'USDT';

/** Paper simulates MEXC (USDT) and Lighter (USDC) contracts; Bitunix pairs are Live only. Lighter Live is not available. */
/**
 * Which modes a pair can be CONFIGURED in. Live: every exchange (a Lighter Live block is saved paused;
 * whether it may be activated and trade is decided server-side by the Live eligibility checks).
 * Paper: the simulators (MEXC, Lighter).
 */
export const supportsMode = (i: Pick<InstrumentDto, 'exchange'>, mode: 'PAPER' | 'LIVE') => (mode === 'LIVE' ? true : i.exchange === 'MEXC' || i.exchange === 'LIGHTER');

export const trailingOff = (distancePct = ''): SideTrailing => ({ enabled: false, activationPct: '', distancePct, closePct: '', basis: 'MARK', targetCloseEnabled: false, targetMovePct: '', targetClosePct: '' });

/**
 * Exit fields prefilled from the administrator's published pair suggestions (CFG-05).
 * Trailing Take Profit starts off: it needs an explicit activation value and a quantity left
 * by the targets, neither of which a suggestion can choose. Its retracement is prefilled from the
 * suggestion for when the investor turns it on.
 */
export function exitDefaults(i: InstrumentDto | undefined): Pick<Draft, 'stopType' | 'stopPct' | 'tp' | 'trailing'> {
  const fixed = (): SideTakeProfit => ({ mode: 'FIXED', targets: [{ id: newTargetId(), movePct: i?.suggested.takeProfitPct ?? '', closePct: '100' }], allocationPct: '100' });
  const trail = i?.suggested.trailingPct ?? '';
  return {
    stopType: 'PERCENT',
    stopPct: i?.suggested.stopPct ?? '',
    tp: { LONG: fixed(), SHORT: fixed() },
    trailing: { LONG: trailingOff(trail), SHORT: trailingOff(trail) }
  };
}

export function defaultLeverage(i: InstrumentDto | undefined): number | null {
  if (!i) return null;
  return i.leverageChoices.includes(5) ? 5 : (i.leverageChoices[0] ?? null);
}

export function newDraft(i: InstrumentDto | undefined, v: StrategyVersionDto | undefined): Draft {
  return {
    instrumentId: i?.id ?? '',
    strategyVersionId: v?.id ?? '',
    direction: v?.permittedDirections ?? 'BOTH',
    orderCostUsdt: '50',
    leverage: defaultLeverage(i),
    marginMode: 'ISOLATED',
    ...exitDefaults(i),
    stopBasis: 'MARK',
    syncAdminExit: false,
    weekdays: [...ALL_WEEKDAYS],
    windowMode: 'ALL_DAY',
    windowStart: '',
    windowEnd: '',
    allowAdds: false,
    maxAdds: '1',
    risk: emptyRisk()
  };
}

const sideFromSaved = (t: OrderBlockDto['takeProfitLong']): SideTakeProfit => ({
  mode: t.mode,
  targets: t.levels.length ? t.levels.map((l) => ({ ...l })) : [{ id: newTargetId(), movePct: '', closePct: '100' }],
  allocationPct: t.mode === 'OFF' ? '100' : (t.allocationPct ?? '100')
});

const trailingFromSaved = (t: OrderBlockDto['trailingLong'] | undefined): SideTrailing => ({
  enabled: !!t?.enabled,
  activationPct: t?.activationPct ?? '',
  distancePct: t?.distancePct ?? '',
  closePct: t?.closePct ?? '',
  basis: t?.basis ?? 'MARK',
  targetCloseEnabled: !!t?.targetClose?.enabled,
  targetMovePct: t?.targetClose?.movePct ?? '',
  targetClosePct: t?.targetClose?.closePct ?? ''
});

/** Form state of a stored exit plan (block or admin definition). */
export function exitDraftFrom(p: ExitPlanSettings): ExitDraft {
  return {
    tp: { LONG: sideFromSaved(p.takeProfitLong), SHORT: sideFromSaved(p.takeProfitShort) },
    trailing: { LONG: trailingFromSaved(p.trailingLong), SHORT: trailingFromSaved(p.trailingShort) }
  };
}

/** The API shape of one side: a fixed target manages the whole Take Profit share; split targets divide it. */
const sidePayload = (t: SideTakeProfit) => {
  const levels = t.mode === 'OFF' ? [] : t.mode === 'FIXED' ? [{ ...t.targets[0]!, closePct: '100' }] : t.targets;
  return {
    mode: t.mode,
    levels: levels.map((l) => ({ id: l.id, movePct: l.movePct.trim(), closePct: l.closePct.trim() })),
    ...(t.mode === 'OFF' ? {} : { allocationPct: t.allocationPct.trim() })
  };
};

const opt = (on: boolean, v: string) => (on && v.trim() !== '' ? v.trim() : null);
const trailingPayload = (t: SideTrailing) => ({
  enabled: t.enabled,
  activationPct: opt(t.enabled, t.activationPct),
  distancePct: opt(t.enabled, t.distancePct),
  closePct: opt(t.enabled, t.closePct),
  targetClose: t.enabled && t.targetCloseEnabled ? { enabled: true, movePct: opt(true, t.targetMovePct), closePct: opt(true, t.targetClosePct) } : null,
  basis: t.basis
});

/** API exit-plan fields (Take Profit and Trailing Take Profit, both sides). */
export function exitPlanPayload(d: ExitDraft) {
  return {
    takeProfitLong: sidePayload(d.tp.LONG),
    takeProfitShort: sidePayload(d.tp.SHORT),
    trailingLong: trailingPayload(d.trailing.LONG),
    trailingShort: trailingPayload(d.trailing.SHORT)
  };
}

export function draftFromBlock(b: OrderBlockDto): Draft {
  return {
    instrumentId: b.instrumentId,
    strategyVersionId: b.strategyVersionId,
    direction: b.direction,
    orderCostUsdt: b.orderCostUsdt,
    leverage: b.leverage,
    marginMode: b.marginMode,
    stopType: b.stop.type,
    stopPct: b.stop.value,
    stopBasis: b.stop.basis,
    ...exitDraftFrom(b),
    syncAdminExit: b.syncAdminExit,
    weekdays: [...b.weekdays],
    windowMode: b.tradingWindow ? 'HOURS' : 'ALL_DAY',
    windowStart: b.tradingWindow?.start ?? '',
    windowEnd: b.tradingWindow?.end ?? '',
    allowAdds: b.allowAdds,
    maxAdds: b.maxAdds === null ? '1' : String(b.maxAdds),
    risk: Object.fromEntries(RISK_FIELDS.map((f) => [f.key, b.risk[f.key] === null ? '' : String(b.risk[f.key])])) as Draft['risk']
  };
}

/** The settings payload sent to the API (PATCH body; POST adds instrumentId and mode). */
export function settingsPayload(d: Draft) {
  // The custom exit plan is always sent (kept while "Sync Admin Setting" is on, restored when off).
  return {
    strategyVersionId: d.strategyVersionId,
    direction: d.direction,
    orderCostUsdt: d.orderCostUsdt.trim(),
    leverage: d.leverage ?? 0,
    marginMode: d.marginMode,
    stop: { type: d.stopType, value: d.stopPct.trim(), basis: d.stopBasis },
    ...exitPlanPayload(d),
    syncAdminExit: d.syncAdminExit,
    weekdays: d.weekdays,
    tradingWindow: d.windowMode === 'HOURS' ? { start: d.windowStart.trim(), end: d.windowEnd.trim() } : null,
    allowAdds: d.allowAdds,
    maxAdds: d.allowAdds ? Number(d.maxAdds) : null,
    risk: Object.fromEntries(
      RISK_FIELDS.map((f) => {
        const v = d.risk[f.key].trim();
        return [f.key, v === '' ? null : f.integer ? Number(v) : v];
      })
    ) as RiskSettings
  };
}

/** Same rules the server applies (shared domain schema + catalog checks). */
export function validateDraft(d: Draft, instrument: InstrumentDto | undefined, version: StrategyVersionDto | undefined): Issue[] {
  const issues: Issue[] = [];
  if (!instrument) issues.push({ path: 'instrumentId', message: 'Select a trading pair.' });
  if (!version) issues.push({ path: 'strategyVersionId', message: 'Select a strategy.' });
  if (d.leverage === null) issues.push({ path: 'leverage', message: 'Select a leverage available for this pair.' });
  // Runs on every keystroke: a validation failure must become a field message, never an
  // exception that would take the editor down (e.g. a field cleared with Backspace).
  try {
    const parsed = parseWith(orderBlockSettingsSchema, settingsPayload(d));
    if (!parsed.ok) issues.push(...parsed.issues);
  } catch {
    issues.push({ path: '', message: 'Some values could not be checked. Review the highlighted fields.' });
  }
  if (instrument && version && d.leverage !== null) issues.push(...catalogIssues({ leverage: d.leverage, direction: d.direction }, { instrument, version }));
  return issues;
}

/**
 * Strategy choices for a pair: the latest published version of each package approved for it,
 * plus the version a saved block is pinned to (kept until the investor explicitly switches).
 */
export function versionChoices(versions: StrategyVersionDto[], instrumentId: string, pinnedId?: string): StrategyVersionDto[] {
  // Archived packages are hidden from new selections; a block already pinned to one still shows it.
  const out = versions.filter((v) => v.isLatest && !v.packageArchived && v.instrumentIds.includes(instrumentId));
  const pinned = pinnedId ? versions.find((v) => v.id === pinnedId) : undefined;
  if (pinned && !out.some((v) => v.id === pinned.id)) out.unshift(pinned);
  return out;
}

/** "Supertrend 15m — paper fixture · v2 · 5m": the real timeframe, whatever the package name says. */
export const versionLabel = (v: StrategyVersionDto) => `${v.packageName} · v${v.version} · ${v.timeframe}${v.isLatest ? '' : ' (pinned — newer version available)'}${v.packageArchived ? ' (archived)' : ''}`;

/** Field errors keyed by path; the first message per path wins. */
export function errorMap(issues: Issue[]): Record<string, string> {
  const m: Record<string, string> = {};
  for (const i of issues) {
    const key = i.path === 'stop.value' ? 'stop' : i.path.startsWith('risk.') ? i.path : i.path;
    m[key] ??= i.message;
  }
  return m;
}
