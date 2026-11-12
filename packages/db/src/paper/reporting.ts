import { and, eq, gte, inArray, isNull, lt, lte, gt, or, sql } from 'drizzle-orm';
import {
  Decimal,
  FUNDING_STATUS_TEXT,
  fundingSettlementsBetween,
  fundingStatus,
  localDate,
  marketSourceLabel,
  netRealized,
  quoteAgeState,
  reportingDayWindow,
  unrealizedPnl,
  type FundingStatus
} from '@trendpilot/domain';
import type { Executor } from '../client';
import { fills, instruments, ledgerEntries, orderIntents, paperAccounts, paperFunding, positionExits, positions } from '../schema';
import { latestQuote } from './market';
import { getMyPaperAccount, listMyPositions, type PositionDto } from './readModels';

/**
 * UI-01 Dashboard and UI-02 Holdings for one investor (REP-03/04). Every query is constrained to
 * the session owner. Sources of truth: confirmed paper fills (`fills`, `position_exits`), booked
 * funding (`paper_funding`) and the paper ledger. Margin postings, releases and the opening
 * balance are balance movements and never enter trading P&L.
 */

const D = (v: Decimal.Value) => new Decimal(v);
const s = (v: Decimal.Value) => D(v).toDecimalPlaces(8).toFixed();

export type PriceFreshness = 'FRESH' | 'STALE';

export interface HoldingPrice {
  mark: string;
  last: string | null;
  bid: string;
  ask: string;
  asOf: string;
  ageSeconds: number;
  source: string;
  sourceLabel: string;
  freshness: PriceFreshness;
}

export interface HoldingDto extends PositionDto {
  /** Latest stored quote for the contract; null = no price (shown as unavailable). */
  price: HoldingPrice | null;
  /** Mark-price unrealized P&L on the remaining contracts; null = unavailable. */
  unrealizedPnlUsdt: string | null;
  unrealizedBasis: 'MARK';
  notionalUsdt: string | null;
  /** Shown only where the paper simulator supports an estimate (isolated margin). */
  liquidation: { price: string; label: string } | null;
  /** Funding booked to this position so far (sum) and how many settlements. */
  fundingUsdt: string;
  fundingSettlements: number;
}

async function priceFor(db: Executor, instrumentId: string, now: Date): Promise<HoldingPrice | null> {
  const q = await latestQuote(db, instrumentId, now);
  if (!q) return null;
  const [row] = await db.execute<{ last: string }>(sql`SELECT last FROM market_quotes WHERE instrument_id = ${instrumentId} AND as_of = ${q.asOf.toISOString()}::timestamptz`).then((r) => r.rows);
  return {
    mark: D(q.mark).toFixed(),
    last: row ? D(row.last).toFixed() : null,
    bid: D(q.bid).toFixed(),
    ask: D(q.ask).toFixed(),
    asOf: q.asOf.toISOString(),
    ageSeconds: Math.max(0, Math.round((now.getTime() - q.asOf.getTime()) / 1000)),
    source: q.source,
    sourceLabel: marketSourceLabel(q.source),
    freshness: quoteAgeState(q.asOf, now) === 'FRESH' ? 'FRESH' : 'STALE'
  };
}

export type ReportMode = 'PAPER' | 'LIVE';

/** Open positions of the owner, priced from the newest quote at `now`. `mode` limits to Paper or Live. */
export async function listMyHoldings(db: Executor, ownerId: string, now: Date, mode?: ReportMode): Promise<HoldingDto[]> {
  const open = (await listMyPositions(db, ownerId)).filter((p) => p.status === 'OPEN' && (!mode || p.mode === mode));
  if (!open.length) return [];
  const ids = open.map((p) => p.id);
  const meta = await db
    .select({ id: positions.id, instrumentId: positions.instrumentId, multiplier: instruments.contractMultiplier })
    .from(positions)
    .innerJoin(instruments, eq(instruments.id, positions.instrumentId))
    .where(and(eq(positions.ownerId, ownerId), inArray(positions.id, ids)));
  const funding = await db
    .select({ positionId: paperFunding.positionId, total: sql<string>`sum(${paperFunding.amount})`, n: sql<number>`count(*)`.mapWith(Number) })
    .from(paperFunding)
    .where(and(eq(paperFunding.ownerId, ownerId), inArray(paperFunding.positionId, ids)))
    .groupBy(paperFunding.positionId);
  const prices = new Map<string, HoldingPrice | null>();
  const out: HoldingDto[] = [];
  for (const p of open) {
    const m = meta.find((x) => x.id === p.id)!;
    if (!prices.has(m.instrumentId)) prices.set(m.instrumentId, await priceFor(db, m.instrumentId, now));
    const price = prices.get(m.instrumentId)!;
    const f = funding.find((x) => x.positionId === p.id);
    out.push({
      ...p,
      price,
      unrealizedPnlUsdt: price ? unrealizedPnl(p.side as 'LONG' | 'SHORT', p.avgEntryPrice, price.mark, p.contracts, m.multiplier) : null,
      unrealizedBasis: 'MARK',
      notionalUsdt: price ? s(D(p.contracts).times(m.multiplier).times(price.mark)) : null,
      liquidation:
        p.mode === 'LIVE'
          ? p.venueSync?.liquidationPrice
            ? { price: p.venueSync.liquidationPrice, label: 'MEXC liquidation price (last sync)' }
            : null
          : p.marginMode === 'ISOLATED' && p.liquidationEstimate
            ? { price: p.liquidationEstimate, label: 'Estimated (isolated margin, paper simulator)' }
            : null,
      fundingUsdt: p.mode === 'LIVE' ? (p.venueSync?.fundingUsdt ?? '0') : f ? s(f.total) : '0',
      fundingSettlements: p.mode === 'LIVE' ? 0 : (f?.n ?? 0)
    });
  }
  return out;
}

export interface DashboardDto {
  mode: ReportMode;
  label: string;
  timezone: string;
  day: { date: string; from: string; to: string; isToday: boolean };
  asOf: string;
  account: {
    walletUsdt: string;
    availableUsdt: string;
    usedMarginUsdt: string;
    orderReserveUsdt: string;
    /** Wallet + unrealized. Null when an open position has no price. */
    equityUsdt: string | null;
    equityStatus: 'OK' | 'STALE' | 'UNAVAILABLE';
  } | null;
  daily: {
    grossRealizedUsdt: string;
    feesUsdt: string;
    entryFeesUsdt: string;
    exitFeesUsdt: string;
    funding: { amountUsdt: string | null; status: FundingStatus; statusText: string; settlementsDue: number; settlementsBooked: number };
    /** Gross − fees + booked funding. Read together with funding.status. */
    netRealizedUsdt: string;
    entryFills: number;
    exitFills: number;
    partialExits: number;
    positionsClosed: number;
  };
  unrealized: { amountUsdt: string | null; status: 'NONE' | 'OK' | 'STALE' | 'UNAVAILABLE'; positionsPriced: number; positionsUnpriced: number };
  positions: { open: number };
  freshness: { lastPriceUpdate: string | null; stale: boolean; contracts: { symbol: string; asOf: string | null; source: string | null; sourceLabel: string | null; freshness: PriceFreshness | 'UNAVAILABLE' }[] };
  reconciliation: Reconciliation;
}

export interface Reconciliation {
  ok: boolean;
  walletUsdt: string;
  ledgerWalletUsdt: string;
  lifetime: { openingBalanceUsdt: string; realizedUsdt: string; feesUsdt: string; fundingUsdt: string; otherWalletUsdt: string };
  checks: { name: string; ok: boolean; expected: string; actual: string }[];
}

/**
 * Lifetime identity checks for one account (Paper or Live): account columns vs ledger, and ledger
 * vs fills, exits and funding. Live wallet adjustments to the MEXC balance appear as "other".
 */
export async function reconcileMyAccount(db: Executor, ownerId: string, mode: ReportMode = 'PAPER'): Promise<Reconciliation | null> {
  const [a] = await db.select().from(paperAccounts).where(and(eq(paperAccounts.ownerId, ownerId), eq(paperAccounts.mode, mode)));
  if (!a) return null;
  const kinds = await db
    .select({ kind: ledgerEntries.kind, bucket: ledgerEntries.bucket, total: sql<string>`sum(${ledgerEntries.amount})` })
    .from(ledgerEntries)
    .where(eq(ledgerEntries.paperAccountId, a.id))
    .groupBy(ledgerEntries.kind, ledgerEntries.bucket);
  const k = (kind: string) => D(kinds.find((x) => x.kind === kind && x.bucket === 'WALLET')?.total ?? 0);
  const bucket = (b: string) => kinds.filter((x) => x.bucket === b).reduce((t, x) => t.plus(x.total), D(0));
  const known = ['OPENING_BALANCE', 'REALIZED_PNL', 'TRADING_FEE', 'FUNDING'];
  const other = kinds.filter((x) => x.bucket === 'WALLET' && !known.includes(x.kind)).reduce((t, x) => t.plus(x.total), D(0));
  const [ex] = await db.select({ pnl: sql<string>`coalesce(sum(${positionExits.realizedPnl}), 0)`, fee: sql<string>`coalesce(sum(${positionExits.fee}), 0)` }).from(positionExits).where(eq(positionExits.paperAccountId, a.id));
  // Closing fills are also in `fills`; their fees are counted once, from position_exits.
  const [en] = await db
    .select({ fee: sql<string>`coalesce(sum(${fills.fee}), 0)` })
    .from(fills)
    .innerJoin(orderIntents, eq(orderIntents.id, fills.intentId))
    .where(and(eq(fills.paperAccountId, a.id), eq(orderIntents.kind, 'OPEN')));
  const [fu] = await db.select({ amt: sql<string>`coalesce(sum(${paperFunding.amount}), 0)` }).from(paperFunding).where(eq(paperFunding.paperAccountId, a.id));
  const checks = [
    { name: 'wallet balance = wallet ledger', expected: bucket('WALLET'), actual: D(a.walletBalance) },
    { name: 'position margin = margin ledger', expected: bucket('POSITION_MARGIN'), actual: D(a.positionMargin) },
    { name: 'order reserve = reserve ledger', expected: bucket('ORDER_RESERVE'), actual: D(a.orderReserve) },
    { name: 'realized P&L ledger = confirmed exit fills', expected: D(ex!.pnl), actual: k('REALIZED_PNL') },
    { name: 'fee ledger = entry + exit fill fees', expected: D(ex!.fee).plus(en!.fee).neg(), actual: k('TRADING_FEE') },
    { name: 'funding ledger = booked funding', expected: D(fu!.amt), actual: k('FUNDING') }
  ].map((c) => ({ name: c.name, ok: c.expected.eq(c.actual), expected: s(c.expected), actual: s(c.actual) }));
  return {
    ok: checks.every((c) => c.ok),
    walletUsdt: s(a.walletBalance),
    ledgerWalletUsdt: s(bucket('WALLET')),
    lifetime: { openingBalanceUsdt: s(k('OPENING_BALANCE')), realizedUsdt: s(k('REALIZED_PNL')), feesUsdt: s(k('TRADING_FEE').neg()), fundingUsdt: s(k('FUNDING')), otherWalletUsdt: s(other) },
    checks
  };
}

/** Funding due in [from, to) up to `now`: one per (owner position open at settlement, settlement). */
async function fundingDue(db: Executor, ownerId: string, from: Date, to: Date, now: Date): Promise<{ due: number; booked: number; amount: Decimal }> {
  const until = new Date(Math.min(to.getTime(), now.getTime() + 1));
  const settlements = fundingSettlementsBetween(from, until);
  const booked = await db
    .select({ positionId: paperFunding.positionId, settledAt: paperFunding.settledAt, amount: paperFunding.amount })
    .from(paperFunding)
    .where(and(eq(paperFunding.ownerId, ownerId), gte(paperFunding.settledAt, from), lt(paperFunding.settledAt, to)));
  if (!settlements.length) return { due: 0, booked: booked.length, amount: booked.reduce((t, b) => t.plus(b.amount), D(0)) };
  const candidates = await db
    .select({ id: positions.id, openedAt: positions.openedAt, closedAt: positions.closedAt })
    .from(positions)
    .where(and(eq(positions.ownerId, ownerId), lte(positions.openedAt, settlements.at(-1)!), or(isNull(positions.closedAt), gt(positions.closedAt, settlements[0]!))));
  let due = 0;
  let got = 0;
  for (const t of settlements) {
    for (const p of candidates) {
      if (p.openedAt > t || (p.closedAt && p.closedAt <= t)) continue;
      due += 1;
      if (booked.some((b) => b.positionId === p.id && b.settledAt.getTime() === t.getTime())) got += 1;
    }
  }
  return { due, booked: got, amount: booked.reduce((t, b) => t.plus(b.amount), D(0)) };
}

/** Dashboard for one mode. Paper and Live are reported separately and never summed. */
export async function getMyDashboard(db: Executor, user: { id: string; timezone: string }, o: { now: Date; date?: string; mode?: ReportMode }): Promise<DashboardDto> {
  const tz = user.timezone || 'Asia/Dhaka';
  const today = localDate(o.now, tz);
  const w = reportingDayWindow(o.date ?? today, tz);
  const ownerId = user.id;
  const mode: ReportMode = o.mode ?? 'PAPER';
  const [acct] = await db.select({ id: paperAccounts.id }).from(paperAccounts).where(and(eq(paperAccounts.ownerId, ownerId), eq(paperAccounts.mode, mode)));
  // No account for this mode yet: every figure below is zero (an impossible ID matches nothing).
  const acctId = acct?.id ?? '00000000-0000-0000-0000-000000000000';

  const [account, holdings, reconciliation] = await Promise.all([getMyPaperAccount(db, ownerId, mode), listMyHoldings(db, ownerId, o.now, mode), reconcileMyAccount(db, ownerId, mode)]);

  const [ex] = await db
    .select({
      pnl: sql<string>`coalesce(sum(${positionExits.realizedPnl}), 0)`,
      fee: sql<string>`coalesce(sum(${positionExits.fee}), 0)`,
      n: sql<number>`count(*)`.mapWith(Number),
      partial: sql<number>`count(*) filter (where ${positionExits.remainingContracts} > 0)`.mapWith(Number)
    })
    .from(positionExits)
    .where(and(eq(positionExits.paperAccountId, acctId), gte(positionExits.filledAt, w.from), lt(positionExits.filledAt, w.to)));
  const [en] = await db
    .select({ fee: sql<string>`coalesce(sum(${fills.fee}), 0)`, n: sql<number>`count(*)`.mapWith(Number) })
    .from(fills)
    .innerJoin(orderIntents, eq(orderIntents.id, fills.intentId))
    .where(and(eq(fills.paperAccountId, acctId), eq(orderIntents.kind, 'OPEN'), gte(fills.filledAt, w.from), lt(fills.filledAt, w.to)));
  const [closed] = await db
    .select({ n: sql<number>`count(*)`.mapWith(Number) })
    .from(positions)
    .where(and(eq(positions.paperAccountId, acctId), gte(positions.closedAt, w.from), lt(positions.closedAt, w.to)));
  // Paper books simulated funding per settlement. Live funding is charged by MEXC and already in the
  // synced wallet; it is shown per position (cumulative, from MEXC) and not added to net realized.
  const f = mode === 'PAPER' ? await fundingDue(db, ownerId, w.from, w.to, o.now) : { due: 0, booked: 0, amount: D(0) };
  const status = fundingStatus(f.due, f.booked);
  const fees = D(ex!.fee).plus(en!.fee);

  const priced = holdings.filter((h) => h.unrealizedPnlUsdt !== null);
  const unpriced = holdings.length - priced.length;
  const anyStale = priced.some((h) => h.price!.freshness === 'STALE');
  const unrealizedTotal = priced.reduce((t, h) => t.plus(h.unrealizedPnlUsdt!), D(0));
  const unrealizedStatus = holdings.length === 0 ? 'NONE' : unpriced > 0 ? 'UNAVAILABLE' : anyStale ? 'STALE' : 'OK';

  // Freshness for every contract the investor holds.
  const contracts = holdings
    .filter((h, i, arr) => arr.findIndex((x) => x.symbol === h.symbol) === i)
    .map((h) => ({ symbol: h.symbol, asOf: h.price?.asOf ?? null, source: h.price?.source ?? null, sourceLabel: h.price?.sourceLabel ?? null, freshness: h.price ? h.price.freshness : ('UNAVAILABLE' as const) }));
  const newest = contracts.map((c) => c.asOf).filter((x): x is string => !!x).sort().at(-1) ?? null;

  return {
    mode,
    label: mode === 'LIVE' ? 'Live — your MEXC Futures account: real fills, fees and balance (synced from MEXC).' : 'Paper — simulated balance and fills.',
    timezone: tz,
    day: { date: w.date, from: w.from.toISOString(), to: w.to.toISOString(), isToday: w.date === today },
    asOf: o.now.toISOString(),
    account: account
      ? {
          walletUsdt: account.walletBalanceUsdt,
          availableUsdt: account.availableUsdt,
          usedMarginUsdt: account.positionMarginUsdt,
          orderReserveUsdt: account.orderReserveUsdt,
          equityUsdt: unrealizedStatus === 'UNAVAILABLE' ? null : s(D(account.walletBalanceUsdt).plus(unrealizedTotal)),
          equityStatus: unrealizedStatus === 'UNAVAILABLE' ? 'UNAVAILABLE' : unrealizedStatus === 'STALE' ? 'STALE' : 'OK'
        }
      : null,
    daily: {
      grossRealizedUsdt: s(ex!.pnl),
      feesUsdt: s(fees),
      entryFeesUsdt: s(en!.fee),
      exitFeesUsdt: s(ex!.fee),
      funding: {
        amountUsdt: status === 'UNAVAILABLE' ? null : s(f.amount),
        status,
        statusText: mode === 'LIVE' ? 'Live funding is charged by MEXC and included in the synced balance; see each position for its cumulative funding.' : FUNDING_STATUS_TEXT[status],
        settlementsDue: f.due,
        settlementsBooked: f.booked
      },
      netRealizedUsdt: netRealized(ex!.pnl, fees.toFixed(), f.amount.toFixed()),
      entryFills: en!.n,
      exitFills: ex!.n,
      partialExits: ex!.partial,
      positionsClosed: closed!.n
    },
    unrealized: { amountUsdt: unrealizedStatus === 'UNAVAILABLE' ? null : s(unrealizedTotal), status: unrealizedStatus, positionsPriced: priced.length, positionsUnpriced: unpriced },
    positions: { open: holdings.length },
    freshness: { lastPriceUpdate: newest, stale: contracts.some((c) => c.freshness !== 'FRESH'), contracts },
    reconciliation: reconciliation ?? { ok: true, walletUsdt: '0', ledgerWalletUsdt: '0', lifetime: { openingBalanceUsdt: '0', realizedUsdt: '0', feesUsdt: '0', fundingUsdt: '0', otherWalletUsdt: '0' }, checks: [] }
  };
}
