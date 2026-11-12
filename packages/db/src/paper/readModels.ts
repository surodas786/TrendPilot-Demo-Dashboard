import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { Decimal, marketSourceLabel, trailingTakeProfitContracts, type MarketSource, type TrailingKind } from '@trendpilot/domain';
import type { Executor } from '../client';
import { fills, instruments, ledgerEntries, orderIntents, paperAccounts, paperFunding, positionExits, positions, positionTargets, signalDecisions, signalEvents } from '../schema';

/**
 * Investor read models for paper trading (UI-02 Holdings, UI-04 My Trades, §10.1 /me routes).
 * Every query is constrained to the session owner: an unowned ID behaves like a missing one.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const n = (v: string | null) => (v === null ? null : new Decimal(v).toFixed());

export interface PaperAccountDto {
  currency: string;
  walletBalanceUsdt: string;
  positionMarginUsdt: string;
  orderReserveUsdt: string;
  availableUsdt: string;
  label: 'Paper — simulated balance';
}

export async function getMyPaperAccount(db: Executor, ownerId: string): Promise<PaperAccountDto | null> {
  const [a] = await db.select().from(paperAccounts).where(eq(paperAccounts.ownerId, ownerId));
  if (!a) return null;
  return {
    currency: a.currency,
    walletBalanceUsdt: n(a.walletBalance)!,
    positionMarginUsdt: n(a.positionMargin)!,
    orderReserveUsdt: n(a.orderReserve)!,
    availableUsdt: new Decimal(a.walletBalance).minus(a.positionMargin).minus(a.orderReserve).toFixed(),
    label: 'Paper — simulated balance'
  };
}

export interface PositionDto {
  id: string;
  symbol: string;
  /** The exact contract: exchange and its perpetual symbol (e.g. MEXC · BTC_USDT). */
  instrumentId: string;
  exchange: string;
  exchangeSymbol: string;
  pair: string;
  contractMultiplier: string;
  mode: string;
  side: string;
  status: string;
  contracts: string;
  quantity: string;
  avgEntryPrice: string;
  leverage: number;
  marginMode: string;
  marginUsdt: string;
  liquidationEstimate: string;
  stop: { price: string; basis: string; orderRef: string | null; contracts: string | null; protection: string; verifiedAt: string | null };
  takeProfit: { price: string; basis: string } | null;
  initialContracts: string;
  realizedPnlUsdt: string;
  feesUsdt: string;
  /** Realized P&L after all fees (entry and exits). */
  netRealizedUsdt: string;
  closeReason: string | null;
  closedAt: string | null;
  openedAt: string;
  orderId: string;
  signal: { eventId: string; action: string; barOpenAt: string; barCloseAt: string } | null;
  /** EXT-03 target progress: planned share, requested and confirmed filled quantity per target. */
  targets: TargetDto[];
  /** EXT-04 persisted trailing exit state (null = no trailing exit). */
  trailing: TrailingDto | null;
}

export interface TargetDto {
  levelId: string;
  ordinal: number;
  movePct: string;
  closePct: string;
  triggerPrice: string;
  basis: string;
  plannedContracts: string;
  requestedContracts: string;
  filledContracts: string;
  status: string;
  completedAt: string | null;
  /** ARM_PULLBACK: arms when reached, closes on a later pullback through the target. TOUCH: legacy, closes when reached. */
  triggerRule: string;
  armedAt: string | null;
  armedPrice: string | null;
}

export interface TrailingDto {
  /** TAKE_PROFIT = Trailing Take Profit; STOP = legacy trailing stop saved with an older position. */
  kind: TrailingKind;
  /** WAITING (for activation), ACTIVE, or DONE (Trailing Take Profit closed its quantity). */
  status: string;
  /**
   * Contracts it would close now: Trailing Take Profit manages what no unfinished target
   * reserves; a legacy trailing stop closes the whole remaining position. Null once closed.
   */
  contracts: string | null;
  basis: string;
  distancePct: string;
  activationPrice: string | null;
  activatedAt: string | null;
  watermark: string | null;
  level: string | null;
  updatedAt: string | null;
  /** Allocated contracts ("Position to close (%)" of the opening quantity) and confirmed fills. Null planned = legacy. */
  plannedContracts: string | null;
  filledContracts: string;
}

const toTarget = (t: typeof positionTargets.$inferSelect): TargetDto => ({
  levelId: t.levelId,
  ordinal: t.ordinal,
  movePct: n(t.movePct)!,
  closePct: n(t.closePct)!,
  triggerPrice: n(t.triggerPrice)!,
  basis: t.triggerBasis,
  plannedContracts: n(t.plannedContracts)!,
  requestedContracts: n(t.requestedContracts)!,
  filledContracts: n(t.filledContracts)!,
  status: t.status,
  completedAt: t.completedAt?.toISOString() ?? null,
  triggerRule: t.triggerRule,
  armedAt: t.armedAt?.toISOString() ?? null,
  armedPrice: n(t.armedPrice)
});

async function targetsByPosition(db: Executor, ownerId: string, positionIds: string[]): Promise<Map<string, TargetDto[]>> {
  const m = new Map<string, TargetDto[]>();
  if (!positionIds.length) return m;
  const rows = await db
    .select()
    .from(positionTargets)
    .where(and(eq(positionTargets.ownerId, ownerId), inArray(positionTargets.positionId, positionIds)))
    .orderBy(asc(positionTargets.ordinal));
  for (const t of rows) m.set(t.positionId, [...(m.get(t.positionId) ?? []), toTarget(t)]);
  return m;
}

/** Attaches targets and the quantity the trailing exit manages for an open position. */
function withTargets(pos: PositionDto, targets: TargetDto[]): PositionDto {
  if (!pos.trailing || pos.status !== 'OPEN' || pos.trailing.status === 'DONE') return { ...pos, targets };
  const t = pos.trailing;
  const contracts =
    t.kind !== 'TAKE_PROFIT'
      ? pos.contracts
      : t.plannedContracts !== null
        ? Decimal.max(0, Decimal.min(new Decimal(t.plannedContracts).minus(t.filledContracts), pos.contracts)).toFixed()
        : trailingTakeProfitContracts(pos.contracts, targets);
  return { ...pos, targets, trailing: { ...pos.trailing, contracts } };
}

const positionSelect = (db: Executor) =>
  db
    .select({ p: positions, symbol: instruments.symbol, inst: { exchange: instruments.exchange, exchangeSymbol: instruments.exchangeSymbol, base: instruments.base, quote: instruments.quote, multiplier: instruments.contractMultiplier }, ev: signalEvents })
    .from(positions)
    .innerJoin(instruments, eq(instruments.id, positions.instrumentId))
    .innerJoin(orderIntents, eq(orderIntents.id, positions.openIntentId))
    .leftJoin(signalEvents, eq(signalEvents.id, orderIntents.eventId));

type InstRef = { exchange: string; exchangeSymbol: string; base: string; quote: string; multiplier: string };

function toPosition({ p, symbol, inst, ev }: { p: typeof positions.$inferSelect; symbol: string; inst: InstRef; ev: typeof signalEvents.$inferSelect | null }): PositionDto {
  return {
    id: p.id,
    symbol,
    instrumentId: p.instrumentId,
    exchange: inst.exchange,
    exchangeSymbol: inst.exchangeSymbol || symbol,
    pair: `${inst.base}/${inst.quote}`,
    contractMultiplier: n(inst.multiplier)!,
    mode: p.mode,
    side: p.side,
    status: p.status,
    contracts: n(p.contracts)!,
    quantity: n(p.quantity)!,
    avgEntryPrice: n(p.avgEntryPrice)!,
    leverage: p.leverage,
    marginMode: p.marginMode,
    marginUsdt: n(p.marginUsdt)!,
    liquidationEstimate: n(p.liquidationEstimate)!,
    stop: { price: n(p.stopPrice)!, basis: p.stopBasis, orderRef: p.stopOrderRef, contracts: n(p.stopContracts), protection: p.protectionStatus, verifiedAt: p.protectionVerifiedAt?.toISOString() ?? null },
    takeProfit: p.takeProfitPrice ? { price: n(p.takeProfitPrice)!, basis: p.takeProfitBasis ?? p.stopBasis } : null,
    initialContracts: n(p.initialContracts)!,
    realizedPnlUsdt: n(p.realizedPnlUsdt)!,
    feesUsdt: n(p.feesUsdt)!,
    netRealizedUsdt: new Decimal(p.realizedPnlUsdt).minus(p.feesUsdt).toFixed(),
    closeReason: p.closeReason,
    closedAt: p.closedAt?.toISOString() ?? null,
    openedAt: p.openedAt.toISOString(),
    orderId: p.openIntentId,
    signal: ev ? { eventId: ev.id, action: ev.action, barOpenAt: ev.barOpenAt.toISOString(), barCloseAt: ev.barCloseAt.toISOString() } : null,
    targets: [],
    trailing:
      p.trailingStatus === 'OFF'
        ? null
        : {
            kind: p.trailingKind as TrailingKind,
            status: p.trailingStatus,
            contracts: null,
            basis: p.trailingBasis ?? p.stopBasis,
            distancePct: n(p.trailingDistancePct)!,
            activationPrice: n(p.trailingActivationPrice),
            activatedAt: p.trailingActivatedAt?.toISOString() ?? null,
            watermark: n(p.trailingWatermark),
            level: n(p.trailingStopPrice),
            updatedAt: p.trailingUpdatedAt?.toISOString() ?? null,
            plannedContracts: n(p.trailingPlannedContracts),
            filledContracts: n(p.trailingFilledContracts)!
          }
  };
}

export async function listMyPositions(db: Executor, ownerId: string): Promise<PositionDto[]> {
  const rows = await positionSelect(db).where(eq(positions.ownerId, ownerId)).orderBy(desc(positions.openedAt));
  const targets = await targetsByPosition(db, ownerId, rows.map((r) => r.p.id));
  return rows.map((r) => withTargets(toPosition(r), targets.get(r.p.id) ?? []));
}

export interface FillDto {
  id: string;
  exchangeFillId: string;
  side: string;
  contracts: string;
  price: string;
  feeUsdt: string;
  filledAt: string;
}

const toFill = (f: typeof fills.$inferSelect): FillDto => ({ id: f.id, exchangeFillId: f.exchangeFillId, side: f.side, contracts: n(f.contracts)!, price: n(f.price)!, feeUsdt: n(f.fee)!, filledAt: f.filledAt.toISOString() });

export interface OrderDto {
  id: string;
  clientOrderId: string;
  symbol: string;
  kind: string;
  side: string;
  state: string;
  stateReason: string | null;
  contracts: string;
  quantity: string;
  expectedPrice: string;
  stopPrice: string;
  stopBasis: string;
  leverage: number;
  marginMode: string;
  reservedUsdt: string;
  createdAt: string;
  submittedAt: string | null;
  resolvedAt: string | null;
  fills: FillDto[];
  positionId: string | null;
  signalEventId: string | null;
  exitReason: string | null;
  filledContracts: string;
}

async function hydrateOrders(db: Executor, rows: { i: typeof orderIntents.$inferSelect; symbol: string }[]): Promise<OrderDto[]> {
  const out: OrderDto[] = [];
  for (const { i, symbol } of rows) {
    const fs = await db.select().from(fills).where(eq(fills.intentId, i.id));
    const [pos] = await db.select({ id: positions.id }).from(positions).where(eq(positions.openIntentId, i.id));
    out.push({
      id: i.id,
      clientOrderId: i.clientOrderId,
      symbol,
      kind: i.kind,
      side: i.side,
      state: i.state,
      stateReason: i.stateReason,
      contracts: n(i.contracts)!,
      quantity: n(i.quantity)!,
      expectedPrice: n(i.expectedPrice)!,
      stopPrice: n(i.stopPrice)!,
      stopBasis: i.stopBasis,
      leverage: i.leverage,
      marginMode: i.marginMode,
      reservedUsdt: n(i.reservedUsdt)!,
      createdAt: i.createdAt.toISOString(),
      submittedAt: i.submittedAt?.toISOString() ?? null,
      resolvedAt: i.resolvedAt?.toISOString() ?? null,
      fills: fs.map(toFill),
      positionId: i.kind === 'CLOSE' ? i.positionId : (pos?.id ?? null),
      signalEventId: i.eventId,
      exitReason: i.exitReason,
      filledContracts: n(i.filledContracts)!
    });
  }
  return out;
}

const orderSelect = (db: Executor) => db.select({ i: orderIntents, symbol: instruments.symbol }).from(orderIntents).innerJoin(instruments, eq(instruments.id, orderIntents.instrumentId));

export async function listMyOrders(db: Executor, ownerId: string, limit = 100): Promise<OrderDto[]> {
  return hydrateOrders(db, await orderSelect(db).where(eq(orderIntents.ownerId, ownerId)).orderBy(desc(orderIntents.createdAt)).limit(limit));
}

export async function getMyOrder(db: Executor, ownerId: string, id: string): Promise<OrderDto | undefined> {
  if (!UUID.test(id)) return undefined;
  const [o] = await hydrateOrders(db, await orderSelect(db).where(and(eq(orderIntents.id, id), eq(orderIntents.ownerId, ownerId))));
  return o;
}

export interface LedgerDto {
  id: string;
  kind: string;
  bucket: string;
  amountUsdt: string;
  refType: string;
  refId: string;
  memo: string | null;
  at: string;
}

export async function listMyLedger(db: Executor, ownerId: string, limit = 200): Promise<LedgerDto[]> {
  const rows = await db.select().from(ledgerEntries).where(eq(ledgerEntries.ownerId, ownerId)).orderBy(desc(ledgerEntries.createdAt)).limit(limit);
  return rows.map((l) => ({ id: l.id, kind: l.kind, bucket: l.bucket, amountUsdt: n(l.amount)!, refType: l.refType, refId: l.refId, memo: l.memo, at: l.createdAt.toISOString() }));
}

export interface ExitDto {
  id: string;
  reason: string;
  contracts: string;
  price: string;
  feeUsdt: string;
  realizedPnlUsdt: string;
  marginReleasedUsdt: string;
  remainingContracts: string;
  orderId: string | null;
  exchangeFillId: string;
  filledAt: string;
  /** Signal that caused this exit (signal or reversal close), if any. */
  signalEventId: string | null;
}

/** A TradingView signal linked to this position (its opening signal, or a closing one). */
export interface LinkedSignalDto {
  eventId: string;
  role: 'OPEN' | 'CLOSE';
  action: string;
  interval: string;
  source: string;
  referencePrice: string;
  barCloseAt: string;
  receivedAt: string;
}

export interface ReversalDto {
  /** ENTRY_APPROVED (opposite position opened), SKIPPED (an entry rule blocked it) or PENDING. */
  status: 'ENTRY_APPROVED' | 'SKIPPED' | 'PENDING';
  reason: string | null;
  reasonText: string | null;
  side: string;
  positionId: string | null;
  orderState: string | null;
}

export interface TradeDetailDto extends PositionDto {
  order: OrderDto;
  exits: ExitDto[];
  closeOrders: OrderDto[];
  ledger: LedgerDto[];
  /** STR-06, on a position closed to reverse: what happened to the opening leg. */
  reversal: ReversalDto | null;
  /** On a position opened by a reversal: the position it replaced. */
  reversedFromPositionId: string | null;
  /** Price data the entry was evaluated on. Fills are always simulated (Paper). */
  marketData: { source: MarketSource; label: string; quoteAsOf: string | null; emaSource: string | null; execution: 'PAPER_SIMULATOR' };
  /** REP-02 simulated funding booked to this position, one row per settlement. */
  funding: FundingDto[];
  fundingUsdt: string;
  /** REP-03: gross realized − all fees + booked funding. */
  netRealizedWithFundingUsdt: string;
  /** Signals that opened or closed (part of) this position. */
  signals: LinkedSignalDto[];
}

export interface FundingDto {
  settledAt: string;
  rate: string;
  contracts: string;
  markPrice: string;
  notionalUsdt: string;
  amountUsdt: string;
  source: string;
}

async function reversalOf(db: Executor, ownerId: string, pos: PositionDto): Promise<ReversalDto | null> {
  if (pos.closeReason !== 'REVERSAL_CLOSE') return null;
  const [d] = await db
    .select({ d: signalDecisions, intentState: orderIntents.state, positionId: positions.id })
    .from(signalDecisions)
    .leftJoin(orderIntents, eq(orderIntents.decisionId, signalDecisions.id))
    .leftJoin(positions, eq(positions.openIntentId, orderIntents.id))
    .where(and(eq(signalDecisions.ownerId, ownerId), eq(signalDecisions.step, 'ENTRY_V1'), sql`${signalDecisions.detail}->>'fromPositionId' = ${pos.id}`));
  const side = pos.side === 'LONG' ? 'SHORT' : 'LONG';
  if (!d) return { status: 'PENDING', reason: null, reasonText: 'The opening leg is evaluated after the close is confirmed.', side, positionId: null, orderState: null };
  const detail = d.d.detail as { reasonText?: string | null };
  return { status: d.d.status as 'ENTRY_APPROVED' | 'SKIPPED', reason: d.d.reason, reasonText: detail.reasonText ?? null, side, positionId: d.positionId, orderState: d.intentState };
}

/** UI-04 trade detail: position, its opening order and fills, and the ledger rows it caused. */
export async function getMyTrade(db: Executor, ownerId: string, positionId: string): Promise<TradeDetailDto | undefined> {
  if (!UUID.test(positionId)) return undefined;
  const [row] = await positionSelect(db).where(and(eq(positions.id, positionId), eq(positions.ownerId, ownerId)));
  if (!row) return undefined;
  const pos = toPosition(row);
  const order = (await getMyOrder(db, ownerId, pos.orderId))!;
  const exitRows = await db.select().from(positionExits).where(and(eq(positionExits.positionId, pos.id), eq(positionExits.ownerId, ownerId))).orderBy(positionExits.filledAt);
  const exits = exitRows.map((x) => ({
    id: x.id,
    reason: x.reason,
    contracts: n(x.contracts)!,
    price: n(x.price)!,
    feeUsdt: n(x.fee)!,
    realizedPnlUsdt: n(x.realizedPnl)!,
    marginReleasedUsdt: n(x.marginReleased)!,
    remainingContracts: n(x.remainingContracts)!,
    orderId: x.intentId,
    exchangeFillId: x.exchangeFillId,
    filledAt: x.filledAt.toISOString(),
    signalEventId: null as string | null
  }));
  const closeOrders = await hydrateOrders(db, await orderSelect(db).where(and(eq(orderIntents.positionId, pos.id), eq(orderIntents.ownerId, ownerId))).orderBy(orderIntents.createdAt));
  for (const x of exits) x.signalEventId = closeOrders.find((o) => o.id === x.orderId)?.signalEventId ?? null;
  // Event IDs come from this owner's own orders only, so no other investor's data is reachable.
  const linked = [
    ...(order.signalEventId ? [{ id: order.signalEventId, role: 'OPEN' as const }] : []),
    ...closeOrders.filter((o) => o.signalEventId).map((o) => ({ id: o.signalEventId!, role: 'CLOSE' as const }))
  ];
  const eventRows = linked.length ? await db.select().from(signalEvents).where(inArray(signalEvents.id, [...new Set(linked.map((l) => l.id))])) : [];
  const signals: LinkedSignalDto[] = linked.flatMap((l) => {
    const e = eventRows.find((r) => r.id === l.id);
    return e
      ? [{ eventId: e.id, role: l.role, action: e.action, interval: e.interval, source: `${e.sourceExchange}:${e.sourceSymbol}`, referencePrice: n(e.referencePrice)!, barCloseAt: e.barCloseAt.toISOString(), receivedAt: e.receivedAt.toISOString() }]
      : [];
  });
  const refs = new Set([order.id, ...order.fills.map((f) => f.exchangeFillId), ...exits.map((x) => x.exchangeFillId)]);
  const ledger = (await listMyLedger(db, ownerId)).filter((l) => refs.has(l.refId) || l.refId.startsWith(`funding:${pos.id}:`));
  const targets = (await targetsByPosition(db, ownerId, [pos.id])).get(pos.id) ?? [];
  const [openDecision] = await db
    .select({ detail: signalDecisions.detail })
    .from(orderIntents)
    .innerJoin(signalDecisions, eq(signalDecisions.id, orderIntents.decisionId))
    .where(and(eq(orderIntents.id, pos.orderId), eq(orderIntents.ownerId, ownerId)));
  const openDetail = openDecision?.detail as { fromPositionId?: string; checks?: { quote?: { source?: string; asOf?: string }; ema?: { source?: string | null } } } | undefined;
  const reversedFromPositionId = openDetail?.fromPositionId ?? null;
  // Decisions made before Step 8 carry no source: those were always fixtures.
  const source: MarketSource = openDetail?.checks?.quote?.source === 'MEXC_PUBLIC' ? 'MEXC_PUBLIC' : 'FIXTURE';
  const marketData = { source, label: marketSourceLabel(source), quoteAsOf: openDetail?.checks?.quote?.asOf ?? null, emaSource: openDetail?.checks?.ema?.source ?? null, execution: 'PAPER_SIMULATOR' as const };
  const fundingRows = await db.select().from(paperFunding).where(and(eq(paperFunding.positionId, pos.id), eq(paperFunding.ownerId, ownerId))).orderBy(asc(paperFunding.settledAt));
  const funding = fundingRows.map((f) => ({ settledAt: f.settledAt.toISOString(), rate: n(f.rate)!, contracts: n(f.contracts)!, markPrice: n(f.markPrice)!, notionalUsdt: n(f.notional)!, amountUsdt: n(f.amount)!, source: f.source }));
  const fundingUsdt = fundingRows.reduce((t, f) => t.plus(f.amount), new Decimal(0)).toFixed();
  const netRealizedWithFundingUsdt = new Decimal(pos.netRealizedUsdt).plus(fundingUsdt).toFixed();
  return { ...withTargets(pos, targets), order, exits, closeOrders, ledger, reversal: await reversalOf(db, ownerId, pos), reversedFromPositionId, marketData, funding, fundingUsdt, netRealizedWithFundingUsdt, signals };
}

/** GET /v1/me/commands/{id}: status of a close command the investor submitted (owner-scoped). */
export async function getMyCommand(db: Executor, ownerId: string, id: string) {
  const o = await getMyOrder(db, ownerId, id);
  if (!o || o.kind !== 'CLOSE') return undefined;
  return { id: o.id, kind: 'POSITION_CLOSE', state: o.state, stateReason: o.stateReason, positionId: o.positionId, exitReason: o.exitReason, requestedContracts: o.contracts, filledContracts: o.filledContracts, fills: o.fills, createdAt: o.createdAt, resolvedAt: o.resolvedAt };
}
