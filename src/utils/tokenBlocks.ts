import { leverageChoices } from '../data/leverageChoices';
import type { ExchangeConnectionMeta, StrategyPackage, TradingPair } from '../types/platform';
import type { BlockStatus, TokenBlock, TokenBlockDraft } from '../types/tradeSettings';
import type { DemoAccount } from '../types/trading';
import { ALL_DAYS, effectiveDays } from './tradingDays';

export const MAX_TARGETS = 3;
export const MODE_LABEL = { paper: 'Paper', live: 'Live — simulated' } as const;
export const BOTH_MODES_NOTE = 'Both modes are simulated in this demo. No real orders are submitted.';

const str = (n: number) => String(n);

/** Exit fields prefilled from the administrator's pair defaults. */
export function exitDefaults(pair: TradingPair | undefined): Pick<TokenBlockDraft, 'stopLossPct' | 'split' | 'targets' | 'trailingEnabled' | 'trailingPct'> {
  return {
    stopLossPct: pair ? str(pair.stopLossPct) : '',
    split: false,
    targets: [{ movePct: pair ? str(pair.takeProfitPct) : '', closePct: '100' }],
    trailingEnabled: pair?.trailingEnabled ?? false,
    trailingPct: pair ? str(pair.trailingPct) : ''
  };
}

export function newDraft(pair: TradingPair | undefined, packageId: string, accountId = ''): TokenBlockDraft {
  const choices = pair ? leverageChoices(pair.symbol) : [];
  return {
    symbol: pair?.symbol ?? '',
    mode: 'paper',
    accountId,
    packageId,
    orderCost: '50',
    leverage: choices.includes(5) ? 5 : choices[0] ?? null,
    marginMode: 'isolated',
    ...exitDefaults(pair),
    allowAdditionalEntries: false,
    maxEntriesPerDirection: '1',
    allowSimultaneousDirections: false,
    tradingDays: [...ALL_DAYS]
  };
}

export function draftFromBlock(b: TokenBlock): TokenBlockDraft {
  return {
    symbol: b.symbol,
    mode: b.mode,
    accountId: b.accountId ?? '',
    packageId: b.packageId,
    orderCost: str(b.orderCost),
    leverage: b.leverage,
    marginMode: b.marginMode,
    stopLossPct: str(b.stopLossPct),
    split: b.takeProfits.length > 1,
    targets: b.takeProfits.map((t) => ({ movePct: str(t.movePct), closePct: str(t.closePct) })),
    trailingEnabled: b.trailingEnabled,
    trailingPct: str(b.trailingPct),
    allowAdditionalEntries: b.allowAdditionalEntries,
    maxEntriesPerDirection: str(b.maxEntriesPerDirection),
    allowSimultaneousDirections: b.allowSimultaneousDirections,
    // Settings saved before schedules existed default to every day.
    tradingDays: [...effectiveDays(b.tradingDays)]
  };
}

const num = (v: string) => v.trim() === '' ? NaN : Number(v);

function pctError(v: string): string | undefined {
  const n = num(v);
  if (Number.isNaN(n)) return 'Enter a number.';
  if (n <= 0 || n >= 100) return 'Must be greater than 0 and below 100.';
  return undefined;
}

export interface DraftErrors {
  symbol?: string;
  packageId?: string;
  orderCost?: string;
  leverage?: string;
  stopLossPct?: string;
  targets: {movePct?: string;closePct?: string;}[];
  allocation?: string;
  trailingPct?: string;
  maxEntriesPerDirection?: string;
  tradingDays?: string;
}

/** Sum of close allocations, in hundredths to avoid floating-point drift. */
export function allocationTotal(d: TokenBlockDraft): number {
  const targets = d.split ? d.targets : d.targets.slice(0, 1);
  return targets.reduce((s, t) => s + Math.round((num(t.closePct) || 0) * 100), 0) / 100;
}

export function validateDraft(d: TokenBlockDraft, duplicate: boolean): DraftErrors {
  const e: DraftErrors = { targets: [] };
  if (!d.symbol) e.symbol = 'Select a trading pair.';else
  if (duplicate) e.symbol = `You already have a ${MODE_LABEL[d.mode]} block for this pair.`;
  if (!d.packageId) e.packageId = 'Select a strategy package.';
  const cost = num(d.orderCost);
  if (Number.isNaN(cost) || cost <= 0) e.orderCost = 'Order cost must be greater than 0.';
  if (d.leverage === null || !leverageChoices(d.symbol).includes(d.leverage)) e.leverage = 'Select a leverage available for this pair.';
  e.stopLossPct = pctError(d.stopLossPct);

  const targets = d.split ? d.targets : d.targets.slice(0, 1);
  let prev = 0;
  targets.forEach((t, i) => {
    const te: {movePct?: string;closePct?: string;} = {};
    te.movePct = pctError(t.movePct);
    if (!te.movePct && i > 0 && num(t.movePct) <= prev) te.movePct = 'Must be further than the previous target.';
    if (!Number.isNaN(num(t.movePct))) prev = num(t.movePct);
    const c = num(t.closePct);
    if (d.split && (Number.isNaN(c) || c <= 0 || c > 100)) te.closePct = 'Enter 0–100.';
    e.targets[i] = te;
  });
  if (allocationTotal(d) !== 100) e.allocation = `Close allocations total ${allocationTotal(d)}% — they must total exactly 100%.`;
  if (d.trailingEnabled) e.trailingPct = pctError(d.trailingPct);
  const max = num(d.maxEntriesPerDirection);
  if (d.allowAdditionalEntries && (!Number.isInteger(max) || max < 1 || max > 10)) e.maxEntriesPerDirection = 'Enter a whole number from 1 to 10.';
  if (d.tradingDays.length === 0) e.tradingDays = 'Select at least one day. To stop all new entries, use Pause instead.';
  return e;
}

export function hasDraftErrors(e: DraftErrors): boolean {
  return Boolean(e.symbol || e.packageId || e.orderCost || e.leverage || e.stopLossPct || e.allocation || e.trailingPct || e.maxEntriesPerDirection || e.tradingDays || e.targets.some((t) => t.movePct || t.closePct));
}

export interface ActivationContext {
  pairs: TradingPair[];
  packages: StrategyPackage[];
  connection?: ExchangeConnectionMeta;
  subscriberActive: boolean;
  /** The subscriber's own trading accounts. */
  accounts: DemoAccount[];
}

/** First unmet activation requirement, or undefined when the block may accept new entries. Blocks always use My Account. */
export function activationBlocker(b: {symbol: string;packageId: string;mode: TokenBlock['mode'];accountId: string | null;}, ctx: ActivationContext): string | undefined {
  if (!ctx.accounts.some((a) => a.environment === b.mode)) return `My Account has no ${MODE_LABEL[b.mode]} balance yet.`;
  if (!ctx.subscriberActive) return 'Subscriber account is not active.';
  const pair = ctx.pairs.find((p) => p.symbol === b.symbol);
  if (!pair) return 'Pair is no longer configured by the administrator.';
  if (!pair.enabled) return 'Pair disabled by the administrator.';
  const pkg = ctx.packages.find((p) => p.id === b.packageId);
  if (!pkg) return 'Strategy package no longer exists.';
  if (pkg.status !== 'active') return 'Strategy package is inactive.';
  if (b.mode === 'live') {
    if (!ctx.connection) return 'Live mode needs an exchange connection.';
    if (ctx.connection.status !== 'connected') return 'Exchange connection is disconnected.';
  }
  return undefined;
}

export function blockStatus(b: TokenBlock, ctx: ActivationContext): BlockStatus {
  const reason = activationBlocker(b, ctx);
  if (!b.active) return { kind: 'paused', blockedReason: reason };
  if (reason) return { kind: 'blocked', reason };
  return { kind: 'active' };
}

export function blockFromDraft(d: TokenBlockDraft, base: {id: string;subscriberId: string;active: boolean;openPositions: number;version: number;createdAt: number;}, at: number): TokenBlock {
  const targets = (d.split ? d.targets : d.targets.slice(0, 1)).map((t) => ({ movePct: Number(t.movePct), closePct: d.split ? Number(t.closePct) : 100 }));
  return {
    ...base,
    symbol: d.symbol,
    mode: d.mode,
    accountId: d.accountId || null,
    packageId: d.packageId,
    orderCost: Number(d.orderCost),
    leverage: d.leverage ?? 1,
    marginMode: d.marginMode,
    stopLossPct: Number(d.stopLossPct),
    takeProfits: targets,
    trailingEnabled: d.trailingEnabled,
    trailingPct: d.trailingEnabled ? Number(d.trailingPct) : Number(d.trailingPct) || 0,
    allowAdditionalEntries: d.allowAdditionalEntries,
    maxEntriesPerDirection: d.allowAdditionalEntries ? Number(d.maxEntriesPerDirection) : 1,
    allowSimultaneousDirections: d.allowSimultaneousDirections,
    tradingDays: ALL_DAYS.filter((day) => d.tradingDays.includes(day)),
    updatedAt: at
  };
}

export const formatUsdt = (n: number) => `${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USDT`;