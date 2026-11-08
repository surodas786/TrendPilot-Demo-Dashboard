import { and, count, eq, inArray, sql } from 'drizzle-orm';
import {
  Decimal,
  emaAtSignalBar,
  takeProfitPrice,
  planTargets,
  trailingActivationPrice,
  trailingLevelFrom,
  ENTRY_REASON_TEXT,
  evaluatePaperEntry,
  isEntryDay,
  localWeekday,
  PAPER_POLICY,
  type EntryReason,
  type Weekday
} from '@trendpilot/domain';
import type { Db, Executor } from '../client';
import { enqueueJob, completeJob, type JobRow } from '../jobs';
import { fills, instruments, orderBlocks, orderIntents, positions, positionTargets, signalDecisions, signalEvents, strategyVersions } from '../schema';
import { availableOf, book, lockPaperAccount } from './accounts';
import { latestQuote, loadClosedCandles } from './market';
import { inspectProtection, lookupOrder, placeOpeningOrderWithStop, type SimResult } from './simulator';

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

function snapshotOf(block: BlockRow, version: VersionRow) {
  return {
    block: {
      id: block.id,
      revision: block.revision,
      direction: block.direction,
      orderCostUsdt: block.orderCostUsdt,
      leverage: block.leverage,
      marginMode: block.marginMode,
      stop: block.stop,
      takeProfit: block.takeProfit,
      trailing: block.trailing,
      weekdays: block.weekdays,
      timezone: block.timezone,
      risk: block.risk
    },
    strategyVersion: { id: version.id, version: version.version, timeframe: version.timeframe, emaFilter: version.emaFilter, oppositePolicy: version.oppositePolicy, signalMaxAgeSeconds: version.signalMaxAgeSeconds }
  };
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

  // ARC-02: the account lock serialises reservations and scope checks for this investor.
  const account = await lockPaperAccount(tx, block.ownerId);
  const [inst] = await tx.select().from(instruments).where(eq(instruments.id, block.instrumentId));
  const [openInScope] = await tx
    .select({ n: count() })
    .from(positions)
    .where(and(eq(positions.paperAccountId, account.id), eq(positions.instrumentId, block.instrumentId), eq(positions.mode, block.mode), eq(positions.status, 'OPEN')));
  const [unresolved] = await tx
    .select({ n: count() })
    .from(orderIntents)
    .where(and(eq(orderIntents.paperAccountId, account.id), eq(orderIntents.instrumentId, block.instrumentId), eq(orderIntents.mode, block.mode), inArray(orderIntents.state, [...UNRESOLVED])));
  const [openForOwner] = await tx.select({ n: count() }).from(positions).where(and(eq(positions.ownerId, block.ownerId), eq(positions.mode, block.mode), eq(positions.status, 'OPEN')));

  const quote = await latestQuote(tx, block.instrumentId, now);
  const ema =
    version.emaFilter === 'EMA200' ? emaAtSignalBar(await loadClosedCandles(tx, block.instrumentId, event.interval, event.barOpenAt), event.barOpenAt, Number(event.interval) * 60_000) : null;

  const result = evaluatePaperEntry({
    side,
    settings: {
      orderCostUsdt: block.orderCostUsdt,
      leverage: block.leverage,
      marginMode: block.marginMode,
      stop: block.stop as never,
      takeProfit: block.takeProfit as never,
      trailing: block.trailing as never,
      risk: block.risk as never
    },
    version: { emaFilter: version.emaFilter, maxPriceDeviationPct: version.maxPriceDeviationPct },
    referencePrice: event.referencePrice,
    quote,
    ema,
    spec: { contractMultiplier: inst!.contractMultiplier, qtyStep: inst!.qtyStep, minQty: inst!.minQty, maxQty: inst!.maxQty, priceTick: inst!.priceTick, takerFeeRate: inst!.takerFeeRate },
    account: { availableUsdt: availableOf(account) },
    exposure: { openPositionInScope: Number(openInScope!.n) > 0, unresolvedIntentInScope: Number(unresolved!.n) > 0, openPositionsForOwner: Number(openForOwner!.n) },
    now
  });

  const base = { eventId: event.id, ownerId: block.ownerId, orderBlockId: block.id, strategyVersionId: block.strategyVersionId, step: ENTRY_STEP, evaluatedAt: now, correlationId: event.correlationId };
  if (!result.ok) {
    await tx
      .insert(signalDecisions)
      .values({ ...base, status: 'SKIPPED', reason: result.reason, detail: { side, reasonText: ENTRY_REASON_TEXT[result.reason], ...result.detail, strategyVersion: version.version, blockRevision: block.revision, ...extra } })
      .onConflictDoNothing();
    return { status: 'SKIPPED', reason: result.reason };
  }

  const s = result.sizing;
  const [decision] = await tx
    .insert(signalDecisions)
    .values({
      ...base,
      status: 'ENTRY_APPROVED',
      reason: null,
      detail: { side, reasonText: null, checks: result.checks, sizing: s, liquidationEstimate: result.liquidationPrice, strategyVersion: version.version, blockRevision: block.revision, note: 'Paper entry approved; the simulated order is submitted next.', ...extra }
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
      // Stable and unique per decision: every resubmission reuses it.
      clientOrderId: `tp-${decision.id}`,
      contracts: s.contracts,
      quantity: s.quantity,
      expectedPrice: s.entryPrice,
      stopPrice: s.stopPrice,
      stopBasis: s.stopBasis,
      leverage: block.leverage,
      marginMode: block.marginMode,
      reservedUsdt: result.requiredUsdt,
      sizing: { ...s, liquidationEstimate: result.liquidationPrice },
      settingsSnapshot: snapshotOf(block, version)
    })
    .returning({ id: orderIntents.id });
  await book(tx, account, [{ kind: 'ORDER_RESERVE', bucket: 'ORDER_RESERVE', amount: result.requiredUsdt, refType: 'order_intent', refId: intent!.id, memo: 'Margin and fee reserved for paper entry' }]);
  await enqueueJob(tx, { kind: PAPER_SUBMIT_JOB, dedupeKey: `${PAPER_SUBMIT_JOB}:${intent!.id}`, payload: { intentId: intent!.id }, runAfter: now });
  return { status: 'ENTRY_APPROVED', reason: null, intentId: intent!.id };
}

/* ─────────────────────────────── Phase 2: submit ─────────────────────────────── */

export interface SubmitHooks {
  /** Test/demo seam: runs after the simulator filled the order, before the platform records it. */
  afterSimulatorFill?: () => void | Promise<void>;
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
type ExitPlanTrailing = { enabled: boolean; activationPct: string | null; distancePct: string | null; basis: string } | undefined;

/** Trailing columns for a new position: active from entry when no activation move is set. */
export function trailingAtEntry(side: 'LONG' | 'SHORT', entry: string, tr: NonNullable<ExitPlanTrailing>, tick: string, now: Date) {
  const activationPrice = trailingActivationPrice(side, entry, tr.activationPct, tick);
  const base = { trailingBasis: tr.basis, trailingDistancePct: tr.distancePct!, trailingActivationPrice: activationPrice, trailingUpdatedAt: now };
  return activationPrice === null
    ? { ...base, trailingStatus: 'ACTIVE', trailingActivatedAt: now, trailingWatermark: entry, trailingStopPrice: trailingLevelFrom(side, entry, tr.distancePct!, tick) }
    : { ...base, trailingStatus: 'WAITING' };
}

async function release(tx: Executor, intent: IntentRow, state: 'CANCELLED' | 'EXPIRED' | 'REJECTED', reason: string, now: Date) {
  await tx.update(orderIntents).set({ state, stateReason: reason, resolvedAt: now, updatedAt: sql`now()` }).where(eq(orderIntents.id, intent.id));
  await book(tx, { id: intent.paperAccountId, ownerId: intent.ownerId }, [
    { kind: 'ORDER_RESERVE_RELEASE', bucket: 'ORDER_RESERVE', amount: new Decimal(intent.reservedUsdt).neg().toFixed(), refType: 'order_intent', refId: intent.id, memo: `Reservation released (${reason})` }
  ]);
}

async function record(db: Db, job: JobRow, intent: IntentRow, sim: SimResult, now: Date, reconciled: boolean): Promise<SubmitSummary> {
  return db.transaction(async (tx) => {
    const [cur] = await tx.select().from(orderIntents).where(eq(orderIntents.id, intent.id)).for('update');
    if (cur!.state === 'FILLED' || cur!.state === 'REJECTED') {
      await completeJob(tx, job);
      const [p] = await tx.select({ id: positions.id }).from(positions).where(eq(positions.openIntentId, intent.id));
      return { intentId: intent.id, state: cur!.state, positionId: p?.id, reconciled };
    }
    if (sim.status === 'REJECTED') {
      await release(tx, cur!, 'REJECTED', sim.reason, now);
      await completeJob(tx, job);
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
    const snap = cur!.settingsSnapshot as { block: { takeProfit: ExitPlanTp; trailing: ExitPlanTrailing }; strategyVersion: { id: string } };
    const side = cur!.side as 'LONG' | 'SHORT';
    const tpLevel = snap.block.takeProfit.mode === 'FIXED' ? snap.block.takeProfit.levels[0] : undefined;
    const tpPrice = tpLevel ? takeProfitPrice(side, f.price, tpLevel.movePct, inst!.priceTick) : null;
    // EXT-04: trailing state from the saved plan, persisted on the position.
    const tr = snap.block.trailing;
    const trailing = tr?.enabled && tr.distancePct ? trailingAtEntry(side, f.price, tr, inst!.priceTick, now) : {};

    // EXE-03: verify the venue's resting stop against the filled exposure. Never trust the ack alone.
    const prot = await inspectProtection(db, sim.stop.orderId);
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
        stopContracts: prot?.contracts ?? null,
        protectionStatus: covers ? 'PROTECTED' : 'UNPROTECTED',
        protectionVerifiedAt: covers ? now : null,
        settingsSnapshot: cur!.settingsSnapshot,
        strategyVersionId: snap.strategyVersion.id,
        // EXT-02: fixed TP target from the confirmed fill; triggers on the saved stop basis.
        takeProfitPrice: tpPrice,
        takeProfitBasis: tpPrice ? sim.stop.basis : null,
        ...trailing,
        feesUsdt: f.fee,
        openedAt: f.filledAt
      })
      .onConflictDoNothing({ target: positions.openIntentId })
      .returning({ id: positions.id });
    if (pos) {
      // EXT-03: targets from the saved plan and the confirmed fill (base quantity = filled contracts).
      const targets = planTargets(side, f.price, f.contracts, snap.block.takeProfit, { priceTick: inst!.priceTick, qtyStep: inst!.qtyStep });
      if (targets.length) {
        await tx.insert(positionTargets).values(targets.map((t) => ({ ownerId: cur!.ownerId, positionId: pos.id, ...t, triggerBasis: sim.stop.basis })));
      }
    }

    await book(tx, account, [
      { kind: 'ORDER_RESERVE_RELEASE', bucket: 'ORDER_RESERVE', amount: new Decimal(cur!.reservedUsdt).neg().toFixed(), refType: 'order_intent', refId: cur!.id, memo: 'Reservation converted on fill' },
      { kind: 'POSITION_MARGIN', bucket: 'POSITION_MARGIN', amount: margin.toFixed(), refType: 'order_intent', refId: cur!.id, memo: 'Isolated margin for paper position' },
      { kind: 'TRADING_FEE', bucket: 'WALLET', amount: new Decimal(f.fee).neg().toFixed(), refType: 'fill', refId: f.fillId, memo: 'Simulated taker fee' }
    ]);
    await tx.update(orderIntents).set({ state: 'FILLED', filledContracts: f.contracts, resolvedAt: now, stateReason: covers ? null : 'PROTECTION_UNVERIFIED', updatedAt: sql`now()` }).where(eq(orderIntents.id, cur!.id));
    await completeJob(tx, job);
    const [p] = pos ? [pos] : await tx.select({ id: positions.id }).from(positions).where(eq(positions.openIntentId, cur!.id));
    return { intentId: cur!.id, state: 'FILLED', positionId: p?.id, reconciled, ...(covers ? {} : { reason: 'PROTECTION_FAILED' }) };
  });
}

export async function processPaperSubmit(db: Db, job: JobRow, now: Date, hooks: SubmitHooks = {}): Promise<SubmitSummary> {
  const { intentId } = job.payload as { intentId: string };

  // Step A: decide whether to (re)submit, reconcile, or stop — under the intent lock.
  const step = await db.transaction(async (tx) => {
    const [intent] = await tx.select().from(orderIntents).where(eq(orderIntents.id, intentId)).for('update');
    if (!intent) throw new Error(`Order intent ${intentId} not found.`);
    if (['FILLED', 'REJECTED', 'CANCELLED', 'EXPIRED'].includes(intent.state)) {
      await completeJob(tx, job);
      return { kind: 'done' as const, intent };
    }
    if (intent.state === 'SUBMITTING') return { kind: 'reconcile' as const, intent };

    // CFG-04: the local weekday is checked again at submission.
    const snap = intent.settingsSnapshot as { block: { weekdays: Weekday[]; timezone: string } };
    if (!isEntryDay(snap.block.weekdays, now, snap.block.timezone)) {
      await release(tx, intent, 'CANCELLED', `DAY_DISABLED at submission (${localWeekday(now, snap.block.timezone)})`, now);
      await completeJob(tx, job);
      return { kind: 'stopped' as const, intent, reason: 'DAY_DISABLED' };
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
  if (step.kind === 'stopped') return { intentId, state: step.intent.state === 'INTENT' ? (step.reason === 'DAY_DISABLED' ? 'CANCELLED' : 'EXPIRED') : step.intent.state, reason: step.reason, reconciled: false };

  const intent = step.intent;
  let sim: SimResult | null = null;
  let reconciled = false;
  if (step.kind === 'reconcile') {
    // ARC-02: an earlier attempt may have reached the venue. Look it up before sending anything.
    sim = await lookupOrder(db, intent.clientOrderId);
    reconciled = sim !== null;
  }
  if (!sim) {
    const [inst] = await db.select().from(instruments).where(eq(instruments.id, intent.instrumentId));
    const q = step.kind === 'submit' ? step.quote : await latestQuote(db, intent.instrumentId, now);
    if (!q) throw new Error('No quote available for submission.');
    sim = await placeOpeningOrderWithStop(db, {
      paperAccountId: intent.paperAccountId,
      clientOrderId: intent.clientOrderId,
      instrumentId: intent.instrumentId,
      side: intent.side as 'LONG' | 'SHORT',
      contracts: intent.contracts,
      contract: { multiplier: inst!.contractMultiplier, qtyStep: inst!.qtyStep, minQty: inst!.minQty, takerFeeRate: inst!.takerFeeRate },
      quote: { bid: q.bid, ask: q.ask },
      stop: { price: intent.stopPrice, basis: intent.stopBasis },
      now
    });
    if (sim.status === 'FILLED') await hooks.afterSimulatorFill?.();
  }
  return record(db, job, intent, sim, now, reconciled);
}
