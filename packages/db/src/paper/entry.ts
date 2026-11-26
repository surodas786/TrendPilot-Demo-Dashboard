import { and, count, eq, inArray, sql } from 'drizzle-orm';
import {
  Decimal,
  emaAtSignalBar,
  takeProfitPrice,
  planExits,
  planTargets,
  trailingActivationPrice,
  ENTRY_REASON_TEXT,
  entryGate,
  evaluatePaperEntry,
  type EntryEvaluation,
  localTime,
  type TradingWindow,
  exchangeLabel,
  isForeignPublicSource,
  isPaperExchange,
  isTradableExchange,
  PAPER_POLICY,
  type EntryReason,
  type Weekday
} from '@trendpilot/domain';
import type { Db, Executor } from '../client';
import { enqueueJob, completeJob, type JobRow } from '../jobs';
import { fills, instruments, marketQuotes, orderBlocks, orderIntents, positions, positionTargets, signalDecisions, signalEvents, strategyVersions } from '../schema';
import { accountExchangeFor, availableOf, book, lockPaperAccount, type PaperAccountRow } from './accounts';
import { latestQuote, loadClosedCandles } from './market';
import { instrumentSpec, lighterSpecGap } from './spec';
import type { SimResult, VenueDiagnostics } from './simulator';
import { lighterLiveRefusalFor, liveEntryEligibility, resolveAccountVenue, type LiveEligibility } from '../live/liveMode';
import type { ExecutionVenue } from '../venue/types';
import { requestExit } from './exits';
import { effectiveExitPlan, latestCommonExit } from '../repos/commonExit';
import type { EffectiveExitPlanDto } from '@trendpilot/domain';
import { newClientOrderId } from './clientOrderId';

/**
 * STR-01/02 paper entries from a confirmed flat scope (EXE-01…04, ARC-02).
 *
 * Phase 1 (inside the signal dispatch transaction): evaluate under the investor's paper-account
 * lock, then commit the decision, the order intent (stable client order ID) and the margin
 * reservation together with a `paper.submit` job. Phase 2 (`paper.submit`): mark SUBMITTING,
 * submit to the simulator with the stop attached, then record the fill, position and ledger and
 * verify protection. A retry always reconciles with the simulator by client order ID first.
 */

export const PAPER_SUBMIT_JOB = 'paper.submit';
export const ENTRY_STEP = 'ENTRY_V1';
/** Worst acceptable executable price versus the intent's expected price at submission. */
export const SLIPPAGE_ALLOWANCE_PCT = '0.2';

type BlockRow = typeof orderBlocks.$inferSelect;
type VersionRow = typeof strategyVersions.$inferSelect;
type EventRow = typeof signalEvents.$inferSelect;

export interface EntryOutcome {
  status: 'ENTRY_APPROVED' | 'SKIPPED';
  reason: EntryReason | null;
  intentId?: string;
}

const UNRESOLVED = ['INTENT', 'SUBMITTING', 'ACKNOWLEDGED', 'PARTIALLY_FILLED', 'UNKNOWN'] as const;

/**
 * Exit rules saved with every new intent and position.
 * V3 (current): per-side Take Profit with an overall allocation, per-side partial Trailing Take
 * Profit (close share of the trailing pool per trigger, rearm on a new best, one-shot target close)
 * and the exit plan's source (the block's own, or an admin Common Exit Definition version).
 * V2: explicit Take Profit / Trailing Take Profit allocation (shared trailing) and arm-then-pullback
 * targets. Snapshots without a version keep the earliest rules.
 */
export const EXIT_RULES_VERSION = 'V3';
export const EXIT_RULES_V2 = 'V2';

/** The exit plan an entry of this block uses now: its own, or the latest admin rule while synced. */
export async function effectiveExitFor(tx: Executor, block: BlockRow): Promise<EffectiveExitPlanDto> {
  return effectiveExitPlan(block, block.syncAdminExit ? await latestCommonExit(tx) : null);
}

export const windowOf = (b: Pick<BlockRow, 'tradingWindowStart' | 'tradingWindowEnd'>): TradingWindow | null =>
  b.tradingWindowStart && b.tradingWindowEnd ? { start: b.tradingWindowStart, end: b.tradingWindowEnd } : null;

/**
 * Immutable copy saved with the intent and the position. `block.takeProfit` is the Take Profit
 * configuration of the ACTUAL side of this entry (Long or Short, set independently); the exit
 * engine reads only that. Both sides are kept for the record.
 */
function snapshotOf(block: BlockRow, version: VersionRow, side: 'LONG' | 'SHORT', exit: EffectiveExitPlanDto) {
  return {
    exitRules: EXIT_RULES_VERSION,
    takeProfitSide: side,
    exitPlan: { source: exit.source, adminVersion: exit.adminVersion },
    block: {
      id: block.id,
      revision: block.revision,
      direction: block.direction,
      orderCostUsdt: block.orderCostUsdt,
      leverage: block.leverage,
      marginMode: block.marginMode,
      stop: block.stop,
      takeProfit: side === 'LONG' ? exit.takeProfitLong : exit.takeProfitShort,
      takeProfitLong: exit.takeProfitLong,
      takeProfitShort: exit.takeProfitShort,
      /** The Trailing Take Profit of THIS entry's side (the exit engine reads only this one). */
      trailingSide: side === 'LONG' ? exit.trailingLong : exit.trailingShort,
      trailingLong: exit.trailingLong,
      trailingShort: exit.trailingShort,
      weekdays: block.weekdays,
      tradingWindow: windowOf(block),
      timezone: block.timezone,
      risk: block.risk
    },
    strategyVersion: { id: version.id, version: version.version, timeframe: version.timeframe, emaFilter: version.emaFilter, oppositePolicy: version.oppositePolicy, signalMaxAgeSeconds: version.signalMaxAgeSeconds }
  };
}

export interface EntryAssessment {
  /** Strategy, market, risk and sizing result (the same for Paper and Live). */
  result: EntryEvaluation;
  /** Live gates for an entry the strategy approved; null for Paper or when the strategy refused. */
  live: LiveEligibility | null;
  /** Balance the sizing was checked against (Live: capped by MEXC's synced available-to-open). */
  availableUsdt: string;
}

/**
 * The read-only part of phase 1: exposure in scope, quote, EMA, sizing and risk, then (Live) the
 * Live gates. Writes nothing. The worker calls it under the account lock; the read-only Live
 * preflight calls it with an unlocked read of the same account, so both use one implementation.
 */
export async function assessEntry(
  tx: Executor,
  input: { event: Pick<EventRow, 'interval' | 'barOpenAt' | 'referencePrice'> & Partial<Pick<EventRow, 'instrumentId' | 'sourceExchange' | 'sourceSymbol' | 'routeId'>>; block: BlockRow; version: VersionRow; side: 'LONG' | 'SHORT'; now: Date; account: PaperAccountRow }
): Promise<EntryAssessment> {
  const { event, block, version, side, now, account } = input;
  const [inst] = await tx.select().from(instruments).where(eq(instruments.id, block.instrumentId));
  // The EXECUTION contract must be published: a disabled contract takes no new entries (Paper or
  // Live), whatever route delivered the signal. Signal validation (the route and its own primary
  // contract) is checked separately at intake and never decides another contract's eligibility.
  if (inst!.status !== 'PUBLISHED') {
    return { result: { ok: false, reason: 'CONTRACT_DISABLED', detail: { exchange: inst!.exchange, executionSymbol: inst!.exchangeSymbol, reasonText: ENTRY_REASON_TEXT.CONTRACT_DISABLED } }, live: null, availableUsdt: availableOf(account) };
  }
  // The account must hold the contract's settlement currency (as stored from the exchange's metadata):
  // a USDT balance is never used for a USDC contract, or the reverse.
  if (account.currency && inst!.quote && account.currency !== inst!.quote) {
    return {
      result: { ok: false, reason: 'ACCOUNT_CURRENCY_MISMATCH', detail: { exchange: inst!.exchange, executionSymbol: inst!.exchangeSymbol, contractCurrency: inst!.quote, accountCurrency: account.currency, reasonText: ENTRY_REASON_TEXT.ACCOUNT_CURRENCY_MISMATCH } },
      live: null,
      availableUsdt: availableOf(account)
    };
  }
  // Live only on exchanges TrendPilot can trade Live; Lighter only inside the Lighter Live scope
  // (account, market and route; lighterLiveScope.ts), refused by default.
  if (block.mode === 'LIVE' && !isTradableExchange(inst!.exchange)) {
    const lighter = inst!.exchange === 'LIGHTER' ? await lighterLiveRefusalFor(tx, { ownerId: block.ownerId, instrumentId: block.instrumentId, routeId: event.routeId ?? null }, 'ENTRY') : ENTRY_REASON_TEXT.EXCHANGE_NOT_ENABLED;
    if (lighter) return { result: { ok: false, reason: 'EXCHANGE_NOT_ENABLED', detail: { exchange: inst!.exchange, reasonText: lighter } }, live: null, availableUsdt: availableOf(account) };
  }
  // Paper simulates MEXC (USDT account) and Lighter (isolated USDC account) contracts. A Paper block
  // on a Bitunix contract (created before this check existed) is refused.
  if (block.mode === 'PAPER' && !isPaperExchange(inst!.exchange)) {
    return {
      result: { ok: false, reason: 'PAPER_EXCHANGE_UNSUPPORTED', detail: { exchange: inst!.exchange, executionSymbol: inst!.exchangeSymbol, reasonText: ENTRY_REASON_TEXT.PAPER_EXCHANGE_UNSUPPORTED } },
      live: null,
      availableUsdt: availableOf(account)
    };
  }
  const [openInScope] = await tx
    .select({ n: count() })
    .from(positions)
    .where(and(eq(positions.paperAccountId, account.id), eq(positions.instrumentId, block.instrumentId), eq(positions.mode, block.mode), eq(positions.status, 'OPEN')));
  const [unresolved] = await tx
    .select({ n: count() })
    .from(orderIntents)
    .where(and(eq(orderIntents.paperAccountId, account.id), eq(orderIntents.instrumentId, block.instrumentId), eq(orderIntents.mode, block.mode), inArray(orderIntents.state, [...UNRESOLVED])));
  const [openForOwner] = await tx.select({ n: count() }).from(positions).where(and(eq(positions.ownerId, block.ownerId), eq(positions.mode, block.mode), eq(positions.status, 'OPEN')));

  const gap = lighterSpecGap(inst!);
  if (gap) return { result: { ok: false, reason: 'SIZE_BELOW_MINIMUM', detail: { cause: 'MAX_ORDER_SIZE_UNKNOWN', exchange: inst!.exchange, reasonText: gap } }, live: null, availableUsdt: availableOf(account) };
  const availableUsdt = availableOf(account);
  // The contract's own exchange prices only (latestQuote refuses another exchange's public quote).
  const quote = await latestQuote(tx, block.instrumentId, now);
  // EMA 200: consecutive closed candles of THIS contract's own exchange through the signal bar; a
  // candle from another exchange's feed is dropped, so a gap blocks the filtered entry.
  const ema =
    version.emaFilter === 'EMA200'
      ? emaAtSignalBar((await loadClosedCandles(tx, block.instrumentId, event.interval, event.barOpenAt)).filter((c) => !isForeignPublicSource(inst!.exchange, c.source ?? '')), event.barOpenAt, Number(event.interval) * 60_000)
      : null;
  // Currency of the TradingView reference: that of the route's own (primary) contract, which the
  // source chart is configured for. Without the route's contract (preflight), the block's own.
  let referenceCurrency: string | null = inst!.quote;
  if (event.instrumentId && event.instrumentId !== inst!.id) {
    const [primary] = await tx.select({ quote: instruments.quote }).from(instruments).where(eq(instruments.id, event.instrumentId));
    referenceCurrency = primary?.quote ?? null;
  }

  const exitPlan = await effectiveExitFor(tx, block);
  const result = evaluatePaperEntry({
    side,
    settings: {
      orderCostUsdt: block.orderCostUsdt,
      leverage: block.leverage,
      marginMode: block.marginMode,
      stop: block.stop as never,
      takeProfitLong: exitPlan.takeProfitLong,
      takeProfitShort: exitPlan.takeProfitShort,
      trailingLong: exitPlan.trailingLong,
      trailingShort: exitPlan.trailingShort,
      risk: block.risk as never
    },
    version: { emaFilter: version.emaFilter, maxPriceDeviationPct: version.maxPriceDeviationPct },
    referencePrice: event.referencePrice,
    quote,
    ema,
    spec: instrumentSpec(inst!),
    priceComparison: { referenceCurrency, venueCurrency: inst!.quote, mode: block.mode === 'LIVE' ? 'LIVE' : 'PAPER' },
    account: { availableUsdt },
    exposure: { openPositionInScope: Number(openInScope!.n) > 0, unresolvedIntentInScope: Number(unresolved!.n) > 0, openPositionsForOwner: Number(openForOwner!.n) },
    trailingConversionRequired: block.trailingConversionRequired,
    now
  });
  // Signal logs: which exchange, contract and price source the decision used, and for feed problems
  // whether a price never arrived (feed off / not covering this contract) or is only stale.
  if (!result.ok && (result.reason === 'FEED_STALE' || result.reason === 'PRICE_DEVIATION')) {
    const venueLabel = exchangeLabel(inst!.exchange);
    const ctx: Record<string, unknown> = { exchange: inst!.exchange, executionSymbol: inst!.exchangeSymbol, priceSource: quote?.source ?? null };
    if (result.reason === 'FEED_STALE') {
      const [any] = quote ? [{ n: 1 }] : await tx.select({ n: count() }).from(marketQuotes).where(eq(marketQuotes.instrumentId, block.instrumentId));
      const never = !quote && Number(any?.n ?? 0) === 0;
      ctx.feed = never ? 'NO_PRICE_EVER' : quote ? 'STALE' : 'NO_RECENT_PRICE';
      ctx.reasonText = never
        ? `No ${venueLabel} price has ever been received for ${inst!.exchangeSymbol}: the ${venueLabel} price feed is off or does not cover this contract${inst!.exchange === 'BITUNIX' ? ' (is the feed process running? BITUNIX_PUBLIC_WS must not be off)' : ''}.`
        : `The latest ${venueLabel} price for ${inst!.exchangeSymbol} is too old (the feed is stale).`;
    } else {
      ctx.reasonText = `The ${venueLabel} price for ${inst!.exchangeSymbol} is too far from the TradingView reference price.`;
    }
    Object.assign(result.detail as Record<string, unknown>, ctx);
  }
  // Live: the same strategy result must also pass the Live gates (switches, approved account,
  // activation, allowlist, limits). The worker checks them again right before sending.
  const live =
    result.ok && block.mode === 'LIVE'
      ? await liveEntryEligibility(tx, { ownerId: block.ownerId, instrumentId: block.instrumentId, contracts: result.sizing.contracts, price: result.sizing.entryPrice, leverage: block.leverage, openContracts: '0' })
      : null;
  return { result, live, availableUsdt };
}

/** Phase 1. Called only for blocks that passed the routing screen; runs in the dispatch transaction. */
export async function evaluateAndReserveEntry(
  tx: Executor,
  input: { event: EventRow; block: BlockRow; version: VersionRow; side: 'LONG' | 'SHORT'; now: Date; extraDetail?: Record<string, unknown> }
): Promise<EntryOutcome> {
  const { event, block, version, side, now } = input;
  const extra = input.extraDetail ?? {};
  const [existing] = await tx
    .select({ id: signalDecisions.id, status: signalDecisions.status, reason: signalDecisions.reason })
    .from(signalDecisions)
    .where(and(eq(signalDecisions.eventId, event.id), eq(signalDecisions.orderBlockId, block.id), eq(signalDecisions.step, ENTRY_STEP)));
  if (existing) return { status: existing.status as EntryOutcome['status'], reason: existing.reason as EntryReason | null };

  // ARC-02: the account lock serialises reservations and scope checks for this investor. Live
  // trades on the instrument's exchange (MEXC or Bitunix), each with its own account.
  const [instEx] = await tx.select({ exchange: instruments.exchange }).from(instruments).where(eq(instruments.id, block.instrumentId));
  // A Lighter Live entry outside the Lighter Live scope (the default: no scope) never reaches an
  // account, a venue or an order: it is skipped before any account is locked or created. Paper
  // Lighter uses its own USDC account.
  const lighterLive = block.mode === 'LIVE' && instEx?.exchange === 'LIGHTER';
  const refusal = lighterLive
    ? await lighterLiveRefusalFor(tx, { ownerId: block.ownerId, instrumentId: block.instrumentId, routeId: event.routeId }, 'ENTRY')
    : (block.mode === 'LIVE' ? !isTradableExchange(instEx?.exchange) : !isTradableExchange(instEx?.exchange) && !isPaperExchange(instEx?.exchange))
      ? ENTRY_REASON_TEXT.EXCHANGE_NOT_ENABLED
      : null;
  if (refusal) {
    await tx
      .insert(signalDecisions)
      .values({ eventId: event.id, ownerId: block.ownerId, orderBlockId: block.id, strategyVersionId: block.strategyVersionId, step: ENTRY_STEP, evaluatedAt: now, correlationId: event.correlationId, status: 'SKIPPED', reason: 'EXCHANGE_NOT_ENABLED', detail: { side, reasonText: refusal, exchange: instEx?.exchange ?? null, strategyVersion: version.version, blockRevision: block.revision, ...extra } })
      .onConflictDoNothing();
    return { status: 'SKIPPED', reason: 'EXCHANGE_NOT_ENABLED' };
  }
  const account = await lockPaperAccount(tx, block.ownerId, block.mode, accountExchangeFor(block.mode, instEx?.exchange, { lighterLive }), { lighterLiveLedger: lighterLive });
  const { result, live } = await assessEntry(tx, { event, block, version, side, now, account });

  const base = { eventId: event.id, ownerId: block.ownerId, orderBlockId: block.id, strategyVersionId: block.strategyVersionId, step: ENTRY_STEP, evaluatedAt: now, correlationId: event.correlationId };
  if (!result.ok) {
    await tx
      .insert(signalDecisions)
      .values({ ...base, status: 'SKIPPED', reason: result.reason, detail: { side, reasonText: ENTRY_REASON_TEXT[result.reason], ...result.detail, strategyVersion: version.version, blockRevision: block.revision, ...extra } })
      .onConflictDoNothing();
    return { status: 'SKIPPED', reason: result.reason };
  }

  const s = result.sizing;
  if (block.mode === 'LIVE') {
    if (!live) throw new Error(`Live block ${block.id} was approved without a Live eligibility check.`);
    if (!live.verdict.ok) {
      await tx
        .insert(signalDecisions)
        .values({
          ...base,
          status: 'SKIPPED',
          reason: 'LIVE_NOT_ELIGIBLE',
          detail: { side, reasonText: `${ENTRY_REASON_TEXT.LIVE_NOT_ELIGIBLE} ${live.reasonText}`, liveReason: live.verdict.reason, liveBlockers: live.blockers, ...(live.verdict.detail ?? {}), sizing: s, strategyVersion: version.version, blockRevision: block.revision, ...extra }
        })
        .onConflictDoNothing();
      return { status: 'SKIPPED', reason: 'LIVE_NOT_ELIGIBLE' };
    }
  }
  const [decision] = await tx
    .insert(signalDecisions)
    .values({
      ...base,
      status: 'ENTRY_APPROVED',
      reason: null,
      detail: {
        side,
        reasonText: null,
        checks: result.checks,
        sizing: s,
        liquidationEstimate: result.liquidationPrice,
        strategyVersion: version.version,
        blockRevision: block.revision,
        note: block.mode === 'LIVE' ? 'Live entry approved; the MEXC order with its stop loss is submitted next.' : 'Paper entry approved; the simulated order is submitted next.',
        ...extra
      }
    })
    .onConflictDoNothing()
    .returning({ id: signalDecisions.id });
  if (!decision) return { status: 'ENTRY_APPROVED', reason: null };

  const [intent] = await tx
    .insert(orderIntents)
    .values({
      ownerId: block.ownerId,
      paperAccountId: account.id,
      orderBlockId: block.id,
      decisionId: decision.id,
      eventId: event.id,
      instrumentId: block.instrumentId,
      mode: block.mode,
      kind: 'OPEN',
      side,
      // Generated once and stored: every submission, lookup and resubmission reuses it.
      // 32 characters: fits MEXC's externalOid limit (see clientOrderId.ts).
      clientOrderId: newClientOrderId(),
      contracts: s.contracts,
      quantity: s.quantity,
      expectedPrice: s.entryPrice,
      stopPrice: s.stopPrice,
      stopBasis: s.stopBasis,
      leverage: block.leverage,
      marginMode: block.marginMode,
      reservedUsdt: result.requiredUsdt,
      sizing: { ...s, liquidationEstimate: result.liquidationPrice },
      settingsSnapshot: snapshotOf(block, version, side, await effectiveExitFor(tx, block))
    })
    .returning({ id: orderIntents.id });
  await book(tx, account, [{ kind: 'ORDER_RESERVE', bucket: 'ORDER_RESERVE', amount: result.requiredUsdt, refType: 'order_intent', refId: intent!.id, memo: `Margin and fee reserved for ${block.mode === 'LIVE' ? 'Live' : 'paper'} entry` }]);
  await enqueueJob(tx, { kind: PAPER_SUBMIT_JOB, dedupeKey: `${PAPER_SUBMIT_JOB}:${intent!.id}`, payload: { intentId: intent!.id }, runAfter: now });
  return { status: 'ENTRY_APPROVED', reason: null, intentId: intent!.id };
}

/* ─────────────────────────────── Phase 2: submit ─────────────────────────────── */

export interface SubmitHooks {
  /** Test/demo seam: runs after the simulator filled the order, before the platform records it. */
  afterSimulatorFill?: () => void | Promise<void>;
  /** Test seam: execute through this venue (e.g. the MEXC adapter over a mocked exchange). Refused in production. */
  venue?: ExecutionVenue;
}

/** The venue knows nothing about an uncertain submission yet: retry later; never resubmit blind. */
export class AwaitingReconciliation extends Error {
  constructor(clientOrderId: string, waitedMs: number) {
    super(`Order ${clientOrderId} was submitted ${Math.round(waitedMs / 1000)} s ago and is not visible at the venue yet; reconciling before any resubmission.`);
    this.name = 'AwaitingReconciliation';
  }
}

export interface SubmitSummary {
  intentId: string;
  state: string;
  reason?: string;
  positionId?: string;
  reconciled: boolean;
}

type IntentRow = typeof orderIntents.$inferSelect;
type ExitPlanTp = { mode: 'FIXED' | 'SPLIT' | 'OFF'; levels: { id: string; movePct: string; closePct: string }[] };
type ExitPlanTrailing = { enabled: boolean; activationPct: string | null; distancePct: string | null; closePct?: string | null; basis: string } | undefined;
type ExitPlanTrailingSide = {
  enabled: boolean;
  activationPct: string | null;
  distancePct: string | null;
  closePct: string | null;
  targetClose?: { enabled: boolean; movePct: string | null; closePct: string | null } | null;
  basis: string;
};

/**
 * V3 partial Trailing Take Profit columns for a new position: waits for the activation move; each
 * trigger closes `closePct` of the trailing pool. The optional target close is one-shot. No
 * trailing exit when it is off, has no activation value, or there is no pool and no target close.
 */
export function partialTrailingAtEntry(side: 'LONG' | 'SHORT', entry: string, tr: ExitPlanTrailingSide | undefined, tick: string, now: Date, poolContracts: string) {
  if (!tr?.enabled || !tr.activationPct || !tr.distancePct || !tr.closePct) return {};
  if (new Decimal(poolContracts).lte(0)) return {};
  const tc = tr.targetClose?.enabled && tr.targetClose.movePct && tr.targetClose.closePct ? tr.targetClose : null;
  return {
    trailingKind: 'TAKE_PROFIT' as const,
    trailingStatus: 'WAITING' as const,
    trailingBasis: tr.basis,
    trailingDistancePct: tr.distancePct,
    trailingActivationPrice: trailingActivationPrice(side, entry, tr.activationPct, tick),
    trailingClosePct: tr.closePct,
    trailingUpdatedAt: now,
    ...(tc ? { trailingTargetPrice: takeProfitPrice(side, entry, tc.movePct!, tick), trailingTargetClosePct: tc.closePct, trailingTargetStatus: 'PENDING' } : {})
  };
}

/**
 * Trailing Take Profit columns for a new position. It always waits for the activation move,
 * measured from the confirmed average entry on the saved basis; it is never active from entry.
 * A plan without an activation value (only possible in a legacy snapshot) gets no trailing exit.
 * `plannedContracts`: its allocated quantity (null = legacy: what no target reserves); an
 * allocation of 0 contracts gives no trailing exit.
 */
export function trailingAtEntry(side: 'LONG' | 'SHORT', entry: string, tr: NonNullable<ExitPlanTrailing>, tick: string, now: Date, plannedContracts: string | null = null) {
  if (!tr.activationPct || !tr.distancePct) return {};
  if (plannedContracts !== null && new Decimal(plannedContracts).lte(0)) return {};
  return {
    trailingPlannedContracts: plannedContracts,
    trailingKind: 'TAKE_PROFIT' as const,
    trailingStatus: 'WAITING' as const,
    trailingBasis: tr.basis,
    trailingDistancePct: tr.distancePct,
    trailingActivationPrice: trailingActivationPrice(side, entry, tr.activationPct, tick),
    trailingUpdatedAt: now
  };
}

/**
 * V2 intents (saved before per-side trailing): trailing's allocation is c% of the opening quantity
 * rounded down to the step; Take Profit (when on) gets the exact rest, with Take Profit off the rest
 * is unallocated. Kept exactly so intents in flight at deploy size as they were saved.
 */
function v2Plan(side: 'LONG' | 'SHORT', price: string, contracts: string, tp: ExitPlanTp, tr: ExitPlanTrailing, spec: { priceTick: string; qtyStep: string }) {
  const c = tr?.enabled ? new Decimal(tr.closePct ?? 0) : new Decimal(0);
  const trailingContracts = Decimal.min(contracts, new Decimal(contracts).times(c).div(100).div(spec.qtyStep).floor().times(spec.qtyStep));
  if (tp.mode === 'OFF') return { targets: [], trailingContracts: trailingContracts.toFixed(), takeProfitContracts: '0' };
  return planExits(side, price, contracts, { takeProfit: { ...tp, allocationPct: new Decimal(100).minus(c).toFixed() }, trailing: { enabled: Boolean(tr?.enabled) } }, spec);
}

/** Resolves an unfilled intent and releases its reservation (one ledger row per intent). Caller holds the intent lock. */
export async function releaseIntent(tx: Executor, intent: IntentRow, state: 'CANCELLED' | 'EXPIRED' | 'REJECTED', reason: string, now: Date): Promise<void> {
  return release(tx, intent, state, reason, now);
}

async function release(tx: Executor, intent: IntentRow, state: 'CANCELLED' | 'EXPIRED' | 'REJECTED', reason: string, now: Date) {
  await tx.update(orderIntents).set({ state, stateReason: reason, resolvedAt: now, updatedAt: sql`now()` }).where(eq(orderIntents.id, intent.id));
  await book(tx, { id: intent.paperAccountId, ownerId: intent.ownerId }, [
    { kind: 'ORDER_RESERVE_RELEASE', bucket: 'ORDER_RESERVE', amount: new Decimal(intent.reservedUsdt).neg().toFixed(), refType: 'order_intent', refId: intent.id, memo: `Reservation released (${reason})` }
  ]);
}

/**
 * Books a venue outcome for an OPEN intent exactly once: under the intent row lock, only while the
 * intent is unresolved. The submit job passes its claim (completed in the same transaction); the
 * exchange reconciliation (REST sync, private order push, ops recovery) passes null. Whoever gets
 * the lock first books; the other finds the intent FILLED or REJECTED and books nothing.
 */
export async function recordOpeningOutcome(db: Db, job: JobRow | null, intent: IntentRow, sim: SimResult, now: Date, reconciled: boolean, venue: ExecutionVenue): Promise<SubmitSummary> {
  return record(db, job, intent, sim, now, reconciled, venue);
}

async function record(db: Db, job: JobRow | null, intent: IntentRow, sim: SimResult, now: Date, reconciled: boolean, venue: ExecutionVenue): Promise<SubmitSummary> {
  return db.transaction(async (tx) => {
    const [cur] = await tx.select().from(orderIntents).where(eq(orderIntents.id, intent.id)).for('update');
    if (!(UNRESOLVED as readonly string[]).includes(cur!.state)) {
      if (job) await completeJob(tx, job);
      const [p] = await tx.select({ id: positions.id }).from(positions).where(eq(positions.openIntentId, intent.id));
      return { intentId: intent.id, state: cur!.state, positionId: p?.id, reconciled };
    }
    if ((sim.orderId && !cur!.exchangeOrderId) || sim.diagnostics)
      await tx
        .update(orderIntents)
        .set({
          ...(sim.orderId && !cur!.exchangeOrderId ? { exchangeOrderId: sim.orderId } : {}),
          ...(sim.diagnostics ? { venueRequest: sim.diagnostics.request ?? null, venueResponse: sim.diagnostics.response ?? null } : {})
        })
        .where(eq(orderIntents.id, cur!.id));
    if (sim.status === 'REJECTED') {
      await release(tx, cur!, 'REJECTED', sim.reason, now);
      if (job) await completeJob(tx, job);
      return { intentId: intent.id, state: 'REJECTED', reason: sim.reason, reconciled };
    }

    const account = { id: cur!.paperAccountId, ownerId: cur!.ownerId };
    const f = sim.fill;
    // EXE-04: fills are deduplicated by venue fill ID within the account.
    await tx
      .insert(fills)
      .values({ ownerId: cur!.ownerId, paperAccountId: cur!.paperAccountId, intentId: cur!.id, exchangeFillId: f.fillId, side: cur!.side, contracts: f.contracts, price: f.price, fee: f.fee, filledAt: f.filledAt })
      .onConflictDoNothing();

    const [inst] = await tx.select().from(instruments).where(eq(instruments.id, cur!.instrumentId));
    const qty = new Decimal(f.contracts).times(inst!.contractMultiplier);
    const margin = qty.times(f.price).div(cur!.leverage).toDecimalPlaces(8, Decimal.ROUND_UP);
    const sizing = cur!.sizing as { liquidationEstimate: string };
    const snap = cur!.settingsSnapshot as {
      exitRules?: string;
      exitPlan?: { source: 'CUSTOM' | 'ADMIN'; adminVersion: number | null };
      block: { takeProfit: ExitPlanTp & { allocationPct?: string }; trailing?: ExitPlanTrailing; trailingSide?: ExitPlanTrailingSide };
      strategyVersion: { id: string };
    };
    const side = cur!.side as 'LONG' | 'SHORT';
    const spec = { priceTick: inst!.priceTick, qtyStep: inst!.qtyStep };
    // V3: per-side allocation and partial trailing. V2: shared trailing with an allocation of the
    // opening quantity. Older intents: targets close their share of the whole position and
    // trailing manages the rest. Each keeps the rules it was saved with.
    const v3 = snap.exitRules === EXIT_RULES_VERSION;
    const v2 = snap.exitRules === EXIT_RULES_V2;
    const tr = snap.block.trailing;
    const trSide = snap.block.trailingSide;
    const plan = v3
      ? planExits(side, f.price, f.contracts, { takeProfit: snap.block.takeProfit, trailing: { enabled: Boolean(trSide?.enabled) } }, spec)
      : v2
        ? v2Plan(side, f.price, f.contracts, snap.block.takeProfit, tr, spec)
        : { targets: planTargets(side, f.price, f.contracts, snap.block.takeProfit, spec), trailingContracts: null };
    const tpLevel = snap.block.takeProfit.mode === 'FIXED' && plan.targets.length ? snap.block.takeProfit.levels[0] : undefined;
    const tpPrice = tpLevel ? takeProfitPrice(side, f.price, tpLevel.movePct, inst!.priceTick) : null;
    // EXT-04: trailing state from the saved plan, persisted on the position.
    const trailing = v3
      ? partialTrailingAtEntry(side, f.price, trSide, inst!.priceTick, now, plan.trailingContracts ?? '0')
      : tr?.enabled && tr.distancePct
        ? trailingAtEntry(side, f.price, tr, inst!.priceTick, now, plan.trailingContracts)
        : {};
    const exitPlanCols = v3 && snap.exitPlan ? { exitPlanSource: snap.exitPlan.source, exitPlanAdminVersion: snap.exitPlan.adminVersion } : {};

    // EXE-03: verify the venue's resting stop against the filled exposure. Never trust the ack alone.
    const prot = await venue.inspectProtection(sim.stop.orderId, cur!.instrumentId);
    const covers =
      !!prot &&
      prot.status === 'ACTIVE' &&
      prot.reduceOnly &&
      prot.side === (cur!.side === 'LONG' ? 'SHORT' : 'LONG') &&
      new Decimal(prot.contracts).eq(f.contracts) &&
      (cur!.side === 'LONG' ? new Decimal(prot.triggerPrice!).lt(f.price) : new Decimal(prot.triggerPrice!).gt(f.price));

    const [pos] = await tx
      .insert(positions)
      .values({
        ownerId: cur!.ownerId,
        paperAccountId: cur!.paperAccountId,
        instrumentId: cur!.instrumentId,
        orderBlockId: cur!.orderBlockId,
        openIntentId: cur!.id,
        mode: cur!.mode,
        side: cur!.side,
        contracts: f.contracts,
        initialContracts: f.contracts,
        quantity: qty.toFixed(),
        avgEntryPrice: f.price,
        leverage: cur!.leverage,
        marginMode: cur!.marginMode,
        marginUsdt: margin.toFixed(),
        liquidationEstimate: sizing.liquidationEstimate,
        stopPrice: sim.stop.triggerPrice,
        stopBasis: sim.stop.basis,
        stopOrderRef: sim.stop.clientOrderId,
        // The venue's own position reference when it reports one at fill time (Bitunix positionId).
        exchangePositionRef: sim.positionRef ?? null,
        stopContracts: prot?.contracts ?? null,
        protectionStatus: covers ? 'PROTECTED' : 'UNPROTECTED',
        protectionVerifiedAt: covers ? now : null,
        settingsSnapshot: cur!.settingsSnapshot,
        strategyVersionId: snap.strategyVersion.id,
        // EXT-02: fixed TP target from the confirmed fill; triggers on the saved stop basis.
        takeProfitPrice: tpPrice,
        takeProfitBasis: tpPrice ? sim.stop.basis : null,
        ...trailing,
        ...exitPlanCols,
        feesUsdt: f.fee,
        openedAt: f.filledAt
      })
      .onConflictDoNothing({ target: positions.openIntentId })
      .returning({ id: positions.id });
    if (pos) {
      // EXT-03: targets from the saved plan and the confirmed fill (base quantity = filled contracts).
      if (plan.targets.length) {
        await tx
          .insert(positionTargets)
          .values(plan.targets.map((t) => ({ ownerId: cur!.ownerId, positionId: pos.id, ...t, triggerBasis: sim.stop.basis, triggerRule: v2 || v3 ? ('ARM_PULLBACK' as const) : ('TOUCH' as const) })));
      }
    }

    await book(tx, account, [
      { kind: 'ORDER_RESERVE_RELEASE', bucket: 'ORDER_RESERVE', amount: new Decimal(cur!.reservedUsdt).neg().toFixed(), refType: 'order_intent', refId: cur!.id, memo: 'Reservation converted on fill' },
      { kind: 'POSITION_MARGIN', bucket: 'POSITION_MARGIN', amount: margin.toFixed(), refType: 'order_intent', refId: cur!.id, memo: 'Isolated margin for paper position' },
      { kind: 'TRADING_FEE', bucket: 'WALLET', amount: new Decimal(f.fee).neg().toFixed(), refType: 'fill', refId: f.fillId, memo: 'Simulated taker fee' }
    ]);
    await tx.update(orderIntents).set({ state: 'FILLED', filledContracts: f.contracts, resolvedAt: now, stateReason: covers ? null : 'PROTECTION_UNVERIFIED', updatedAt: sql`now()` }).where(eq(orderIntents.id, cur!.id));
    // OPS-03: exposure without a verified stop is closed at once (emergency close, reduce-only).
    if (pos && !covers) {
      const [row] = await tx.select().from(positions).where(eq(positions.id, pos.id));
      await requestExit(tx, { position: row!, reason: 'PROTECTION_FAILURE', now });
    }
    if (job) await completeJob(tx, job);
    const [p] = pos ? [pos] : await tx.select({ id: positions.id }).from(positions).where(eq(positions.openIntentId, cur!.id));
    return { intentId: cur!.id, state: 'FILLED', positionId: p?.id, reconciled, ...(covers ? {} : { reason: 'PROTECTION_FAILED' }) };
  });
}

export async function processPaperSubmit(db: Db, job: JobRow, now: Date, hooks: SubmitHooks = {}): Promise<SubmitSummary> {
  const { intentId } = job.payload as { intentId: string };

  // The venue for this order's account: the simulator (Paper) or the guarded MEXC adapter (Live).
  // Resolved before anything is marked SUBMITTING, so an unavailable Live venue (transport off,
  // key removed) rejects the order cleanly instead of leaving it uncertain.
  const [peek] = await db.select().from(orderIntents).where(eq(orderIntents.id, intentId));
  let venue: ExecutionVenue | null = null;
  let venueError: string | null = null;
  if (peek && !['FILLED', 'REJECTED', 'CANCELLED', 'EXPIRED'].includes(peek.state)) {
    try {
      venue = await resolveAccountVenue(db, { mode: peek.mode, paperAccountId: peek.paperAccountId, ownerId: peek.ownerId }, hooks.venue);
    } catch (e) {
      venueError = (e as Error).message.slice(0, 200);
    }
  }

  // Step A: decide whether to (re)submit, reconcile, or stop — under the intent lock.
  const step = await db.transaction(async (tx) => {
    const [intent] = await tx.select().from(orderIntents).where(eq(orderIntents.id, intentId)).for('update');
    if (!intent) throw new Error(`Order intent ${intentId} not found.`);
    if (['FILLED', 'REJECTED', 'CANCELLED', 'EXPIRED'].includes(intent.state)) {
      await completeJob(tx, job);
      return { kind: 'done' as const, intent };
    }
    if (intent.state === 'SUBMITTING') {
      // Never resubmit or give up on an uncertain order without its venue: retry later.
      if (venueError) throw new Error(`Cannot reconcile ${intent.clientOrderId}: ${venueError}`);
      return { kind: 'reconcile' as const, intent };
    }
    if (venueError) {
      await release(tx, intent, 'REJECTED', `VENUE_UNAVAILABLE: ${venueError}`, now);
      await completeJob(tx, job);
      return { kind: 'stopped' as const, intent, reason: 'VENUE_UNAVAILABLE' };
    }

    // CFG-04: the trading window and the local weekday are checked again at submission.
    const snap = intent.settingsSnapshot as { block: { weekdays: Weekday[]; timezone: string; tradingWindow?: TradingWindow | null } };
    const gate = entryGate(snap.block.weekdays, snap.block.tradingWindow, now, snap.block.timezone);
    if (!gate.ok) {
      await release(tx, intent, 'CANCELLED', `${gate.reason} at submission (${localTime(now, snap.block.timezone)} ${snap.block.timezone})`, now);
      await completeJob(tx, job);
      return { kind: 'stopped' as const, intent, reason: gate.reason };
    }
    // MKT-02 and slippage policy at submission.
    const q = await latestQuote(tx, intent.instrumentId, now);
    const fresh = q && now.getTime() - q.asOf.getTime() <= PAPER_POLICY.maxQuoteAgeSeconds * 1000;
    const exec = q ? new Decimal(intent.side === 'LONG' ? q.ask : q.bid) : null;
    const worse = exec && (intent.side === 'LONG' ? exec.minus(intent.expectedPrice) : new Decimal(intent.expectedPrice).minus(exec)).div(intent.expectedPrice).times(100);
    if (!fresh || !q || (worse && worse.gt(SLIPPAGE_ALLOWANCE_PCT))) {
      const reason = !fresh ? 'FEED_STALE' : 'SLIPPAGE_LIMIT';
      await release(tx, intent, 'EXPIRED', reason, now);
      await completeJob(tx, job);
      return { kind: 'stopped' as const, intent, reason };
    }
    await tx.update(orderIntents).set({ state: 'SUBMITTING', submittedAt: now, updatedAt: sql`now()` }).where(eq(orderIntents.id, intent.id));
    return { kind: 'submit' as const, intent, quote: q };
  });

  if (step.kind === 'done') return { intentId, state: step.intent.state, reconciled: false };
  if (step.kind === 'stopped')
    return {
      intentId,
      state: step.intent.state === 'INTENT' ? (step.reason === 'VENUE_UNAVAILABLE' ? 'REJECTED' : step.reason === 'DAY_DISABLED' || step.reason === 'OUTSIDE_TRADING_WINDOW' ? 'CANCELLED' : 'EXPIRED') : step.intent.state,
      reason: step.reason,
      reconciled: false
    };

  const intent = step.intent;
  if (!venue) throw new Error(`No venue for ${intent.clientOrderId}.`);
  try {
    return await submitOrReconcile(db, job, step, venue, now, hooks);
  } catch (e) {
    // Evidence for an unresolved order: what this attempt sent (sanitized) and why it failed. Kept
    // with the intent, so a job that runs out of attempts never leaves the order unexplained.
    await noteAttempt(db, intent.id, e, now).catch(() => undefined);
    throw e;
  }
}

/** Records a failed submit/reconcile attempt on the intent (never changes its state). */
export async function noteAttempt(db: Executor, intentId: string, e: unknown, now: Date): Promise<void> {
  const err = e as Error & { diagnostics?: VenueDiagnostics };
  const note = `${now.toISOString()} ${err?.name ?? 'Error'}: ${err?.message ?? String(e)}`.slice(0, 500);
  await db
    .update(orderIntents)
    .set({
      lastReconcileAt: now,
      lastReconcileNote: note,
      ...(err?.diagnostics ? { venueRequest: err.diagnostics.request ?? null, venueResponse: err.diagnostics.response ?? null } : {}),
      updatedAt: sql`now()`
    })
    .where(eq(orderIntents.id, intentId));
}

async function submitOrReconcile(db: Db, job: JobRow, step: { kind: 'submit' | 'reconcile'; intent: IntentRow; quote?: Awaited<ReturnType<typeof latestQuote>> }, venue: ExecutionVenue, now: Date, hooks: SubmitHooks): Promise<SubmitSummary> {
  const intent = step.intent;
  let sim: SimResult | null = null;
  let reconciled = false;
  if (step.kind === 'reconcile') {
    // ARC-02: an earlier attempt may have reached the venue. Look it up before sending anything.
    sim = await venue.lookupOrder(intent.clientOrderId, intent.instrumentId);
    reconciled = sim !== null;
    // A live venue may not show an accepted order at once: absence counts only after its grace period.
    const grace = (venue as { reconcileGraceMs?: number }).reconcileGraceMs ?? 0;
    const waited = now.getTime() - (intent.submittedAt?.getTime() ?? 0);
    if (!sim && grace > 0 && waited < grace) throw new AwaitingReconciliation(intent.clientOrderId, waited);
  }
  if (!sim) {
    const [inst] = await db.select().from(instruments).where(eq(instruments.id, intent.instrumentId));
    const q = step.kind === 'submit' && step.quote ? step.quote : await latestQuote(db, intent.instrumentId, now);
    if (!q) throw new Error('No quote available for submission.');
    sim = await venue.placeOpeningOrderWithStop({
      paperAccountId: intent.paperAccountId,
      clientOrderId: intent.clientOrderId,
      instrumentId: intent.instrumentId,
      side: intent.side as 'LONG' | 'SHORT',
      contracts: intent.contracts,
      contract: { multiplier: inst!.contractMultiplier, qtyStep: inst!.qtyStep, minQty: inst!.minQty, takerFeeRate: inst!.takerFeeRate },
      quote: { bid: q.bid, ask: q.ask },
      stop: { price: intent.stopPrice, basis: intent.stopBasis },
      now,
      leverage: intent.leverage,
      marginMode: intent.marginMode as 'ISOLATED' | 'CROSS'
    });
    if (sim.status === 'FILLED') await hooks.afterSimulatorFill?.();
  }
  return record(db, job, intent, sim, now, reconciled, venue);
}
