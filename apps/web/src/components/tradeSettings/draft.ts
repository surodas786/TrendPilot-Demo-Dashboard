import {
  ALL_WEEKDAYS,
  catalogIssues,
  orderBlockSettingsSchema,
  parseWith,
  type Direction,
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

/** Form state for one order block. Strings mirror the inputs; validation is shared with the server. */
export interface Draft {
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
  tpMode: TakeProfitMode;
  targets: { id: string; movePct: string; closePct: string }[];
  trailingEnabled: boolean;
  trailingActivationPct: string;
  trailingPct: string;
  trailingBasis: PriceBasis;
  weekdays: Weekday[];
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

export const MAX_TARGETS = 3;

export const DIRECTION_LABELS: Record<Direction, string> = { LONG_ONLY: 'Long only', SHORT_ONLY: 'Short only', BOTH: 'Long and Short' };
export const OPPOSITE_LABELS = { KEEP_OPEN: 'Keep position open', CLOSE_ONLY: 'Close position only', CLOSE_AND_REVERSE: 'Close and reverse' } as const;

let seq = 0;
export const newTargetId = () => `tp${Date.now().toString(36)}${(seq++).toString(36)}`;

export const pairLabel = (i: Pick<InstrumentDto, 'base' | 'quote'>) => `${i.base}/${i.quote}`;

/** Exit fields prefilled from the administrator's published pair suggestions (CFG-05). */
export function exitDefaults(i: InstrumentDto | undefined): Pick<Draft, 'stopType' | 'stopPct' | 'tpMode' | 'targets' | 'trailingEnabled' | 'trailingPct' | 'trailingActivationPct'> {
  return {
    stopType: 'PERCENT',
    stopPct: i?.suggested.stopPct ?? '',
    trailingActivationPct: '',
    tpMode: 'FIXED',
    targets: [{ id: newTargetId(), movePct: i?.suggested.takeProfitPct ?? '', closePct: '100' }],
    trailingEnabled: i?.suggested.trailingEnabled ?? false,
    trailingPct: i?.suggested.trailingPct ?? ''
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
    trailingBasis: 'MARK',
    weekdays: [...ALL_WEEKDAYS],
    allowAdds: false,
    maxAdds: '1',
    risk: emptyRisk()
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
    tpMode: b.takeProfit.mode,
    targets: b.takeProfit.levels.length ? b.takeProfit.levels.map((l) => ({ ...l })) : [{ id: newTargetId(), movePct: '', closePct: '100' }],
    trailingEnabled: b.trailing.enabled,
    trailingPct: b.trailing.distancePct ?? '',
    trailingActivationPct: b.trailing.activationPct ?? '',
    trailingBasis: b.trailing.basis,
    weekdays: [...b.weekdays],
    allowAdds: b.allowAdds,
    maxAdds: b.maxAdds === null ? '1' : String(b.maxAdds),
    risk: Object.fromEntries(RISK_FIELDS.map((f) => [f.key, b.risk[f.key] === null ? '' : String(b.risk[f.key])])) as Draft['risk']
  };
}

/** The settings payload sent to the API (PATCH body; POST adds instrumentId and mode). */
export function settingsPayload(d: Draft) {
  const levels = d.tpMode === 'OFF' ? [] : d.tpMode === 'FIXED' ? [{ ...d.targets[0]!, closePct: '100' }] : d.targets;
  return {
    strategyVersionId: d.strategyVersionId,
    direction: d.direction,
    orderCostUsdt: d.orderCostUsdt.trim(),
    leverage: d.leverage ?? 0,
    marginMode: d.marginMode,
    stop: { type: d.stopType, value: d.stopPct.trim(), basis: d.stopBasis },
    takeProfit: { mode: d.tpMode, levels: levels.map((l) => ({ id: l.id, movePct: l.movePct.trim(), closePct: l.closePct.trim() })) },
    trailing: {
      enabled: d.trailingEnabled,
      activationPct: d.trailingEnabled && d.trailingActivationPct.trim() ? d.trailingActivationPct.trim() : null,
      distancePct: d.trailingEnabled ? d.trailingPct.trim() : null,
      basis: d.trailingBasis
    },
    weekdays: d.weekdays,
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
  const parsed = parseWith(orderBlockSettingsSchema, settingsPayload(d));
  if (!parsed.ok) issues.push(...parsed.issues);
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
