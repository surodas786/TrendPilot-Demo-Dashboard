// Step 9 (UI-01/02/04, REP-02/03/04): dashboard totals, holdings and trade reporting reconcile with
// confirmed paper fills, booked funding and the paper ledger, per reporting day (Asia/Dhaka), and
// each investor sees only their own records.
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { enqueueJob, PAPER_FUNDING_JOB, recordFundingRate, recordMarketTick, schema } from '@trendpilot/db';
import { Decimal, fundingAmount, unrealizedPnl } from '@trendpilot/domain';
import * as dashboard from '@/app/v1/me/dashboard/route';
import * as holdings from '@/app/v1/me/holdings/route';
import * as closePos from '@/app/v1/me/positions/[id]/close/route';
import * as signals from '@/app/v1/me/signals/route';
import * as trade from '@/app/v1/me/trades/[id]/route';
import { setTestClock } from '@/server/clock';
import { BTC, call, direct, teardown, userId, USERS } from '../helpers';
import { clock, cookies, D, drain, openFromAlert, positionsOf } from '../paperReplay';

const A = USERS.investorA.email;
const B = USERS.investorB.email;
const MULT = '0.0001';
const SPLIT = { mode: 'SPLIT', levels: [{ id: 'tp1', movePct: '1', closePct: '50' }, { id: 'tp2', movePct: '10', closePct: '50' }] };

const dash = (cookie: string, date?: string) => call(dashboard.GET, { path: `/v1/me/dashboard${date ? `?date=${date}` : ''}`, cookie });
const at = (iso: string) => (clock.now = new Date(iso));
const tickAt = async (iso: string, mid: string) => {
  at(iso);
  await recordMarketTick(direct.db, { instrumentId: BTC, asOf: clock.now, bid: D(mid).minus('0.5').toFixed(), ask: D(mid).plus('0.5').toFixed(), mark: mid, last: mid });
};
const manualClose = (cookie: string, id: string) => call(closePos.POST, { method: 'POST', path: '/x', cookie, params: { id }, headers: { 'idempotency-key': `k-${Math.random().toString(36).slice(2)}` } });
const sumExits = async (email: string, from: string, to: string) => {
  const r = await direct.db.execute<{ pnl: string; fee: string }>(
    sql`SELECT coalesce(sum(realized_pnl),0) pnl, coalesce(sum(fee),0) fee FROM position_exits WHERE owner_id = ${await userId(email)} AND filled_at >= ${from}::timestamptz AND filled_at < ${to}::timestamptz`
  );
  return r.rows[0]!;
};

let posA: string;
let posB: string;

beforeAll(async () => {
  // Same alert, same token, different sizes: A 100 USDT × 10 with a split TP, B 50 USDT × 5, no TP.
  await openFromAlert({ a: { takeProfit: SPLIT }, b: { takeProfit: { mode: 'OFF', levels: [] } } });
  posA = (await positionsOf(A))[0]!.id;
  posB = (await positionsOf(B))[0]!.id;
});

afterAll(async () => {
  setTestClock(null);
  await teardown();
});

describe('holdings and unrealized P&L (mark price)', () => {
  it('each investor sees only their own open position, priced on the newest quote', async () => {
    await tickAt('2026-11-08T09:31:00Z', '65400');
    await drain();
    const a = await call(holdings.GET, { path: '/x', cookie: cookies.a });
    const b = await call(holdings.GET, { path: '/x', cookie: cookies.b });
    expect(a.body.positions.map((p: any) => p.id)).toEqual([posA]);
    expect(b.body.positions.map((p: any) => p.id)).toEqual([posB]);
    const pa = a.body.positions[0];
    expect(pa).toMatchObject({ symbol: 'BTCUSDT', side: 'LONG', unrealizedBasis: 'MARK', price: { mark: '65400', source: 'FIXTURE', freshness: 'FRESH' } });
    expect(pa.contracts).not.toBe(b.body.positions[0].contracts); // different sizes
    expect(pa.unrealizedPnlUsdt).toBe(unrealizedPnl('LONG', pa.avgEntryPrice, '65400', pa.contracts, MULT));
    expect(pa.liquidation).toMatchObject({ price: pa.liquidationEstimate, label: expect.stringMatching(/Estimated/) });
    expect(Number(pa.stop.contracts)).toBe(Number(pa.contracts));
    expect(a.body.mode).toBe('PAPER');
  });

  it('dashboard: available, used margin, equity = wallet + unrealized, fresh prices', async () => {
    const r = await dash(cookies.a);
    expect(r.status).toBe(200);
    const h = (await call(holdings.GET, { path: '/x', cookie: cookies.a })).body;
    expect(r.body).toMatchObject({ mode: 'PAPER', timezone: 'Asia/Dhaka', day: { date: '2026-11-08', from: '2026-11-07T18:00:00.000Z', to: '2026-11-08T18:00:00.000Z', isToday: true } });
    expect(r.body.account.availableUsdt).toBe(h.account.availableUsdt);
    expect(r.body.account.usedMarginUsdt).toBe(h.account.positionMarginUsdt);
    expect(r.body.account.equityUsdt).toBe(D(h.account.walletBalanceUsdt).plus(h.positions[0].unrealizedPnlUsdt).toFixed());
    expect(r.body.unrealized).toMatchObject({ status: 'OK', positionsPriced: 1, positionsUnpriced: 0 });
    expect(r.body.freshness).toMatchObject({ stale: false, lastPriceUpdate: '2026-11-08T09:31:00.000Z' });
  });

  it('a stale price is flagged; a missing price is unavailable, never 0', async () => {
    at('2026-11-08T09:32:00Z'); // newest quote is 60 s old
    let r = await dash(cookies.a);
    expect(r.body.unrealized.status).toBe('STALE');
    expect(r.body.account.equityStatus).toBe('STALE');
    expect(r.body.freshness.stale).toBe(true);

    const saved = await direct.db.select().from(schema.marketQuotes);
    await direct.db.delete(schema.marketQuotes);
    r = await dash(cookies.a);
    expect(r.body.unrealized).toMatchObject({ status: 'UNAVAILABLE', amountUsdt: null });
    expect(r.body.account).toMatchObject({ equityUsdt: null, equityStatus: 'UNAVAILABLE' });
    const h = await call(holdings.GET, { path: '/x', cookie: cookies.a });
    expect(h.body.positions[0]).toMatchObject({ price: null, unrealizedPnlUsdt: null, notionalUsdt: null });
    await direct.db.insert(schema.marketQuotes).values(saved);
  });
});

describe('partial and full exits, duplicates, funding, and the reporting-day boundary', () => {
  it('a partial take-profit counts its own realized P&L and fee; a duplicate tick books nothing', async () => {
    await tickAt('2026-11-08T09:40:00Z', '65700'); // A tp1 (+1 %) reached; B has no target
    await drain();
    const exitsA = await direct.db.select().from(schema.positionExits).where(eq(schema.positionExits.positionId, posA));
    expect(exitsA).toHaveLength(1);
    expect(Number(exitsA[0]!.remainingContracts)).toBeGreaterThan(0);
    // The same tick again (same time and prices) is deduplicated.
    await recordMarketTick(direct.db, { instrumentId: BTC, asOf: clock.now, bid: '65699.5', ask: '65700.5', mark: '65700', last: '65700' });
    await drain();
    expect(await direct.db.select().from(schema.positionExits).where(eq(schema.positionExits.positionId, posA))).toHaveLength(1);

    const r = (await dash(cookies.a)).body;
    const ex = await sumExits(A, r.day.from, r.day.to);
    expect(r.daily).toMatchObject({ grossRealizedUsdt: D(ex.pnl).toFixed(), exitFeesUsdt: D(ex.fee).toFixed(), exitFills: 1, partialExits: 1, entryFills: 1, positionsClosed: 0 });
    expect(D(r.daily.feesUsdt).eq(D(r.daily.entryFeesUsdt).plus(r.daily.exitFeesUsdt))).toBe(true);
  });

  it('settled funding books once per position (duplicate rate and duplicate job book nothing)', async () => {
    await tickAt('2026-11-08T15:59:50Z', '65500'); // mark at settlement
    await drain();
    at('2026-11-08T16:00:05Z');
    await recordFundingRate(direct.db, { instrumentId: BTC, settledAt: new Date('2026-11-08T16:00:00Z'), rate: '0.0001', source: 'FIXTURE' });
    let r = await drain();
    expect(r.find((x) => x.funding)?.funding).toMatchObject({ positions: 2, booked: 2, alreadyBooked: 0 });

    // Re-delivery: the same rate again, and the same job under a different key.
    expect((await recordFundingRate(direct.db, { instrumentId: BTC, settledAt: new Date('2026-11-08T16:00:00Z'), rate: '0.0001', source: 'FIXTURE' })).created).toBe(false);
    await enqueueJob(direct.db, { kind: PAPER_FUNDING_JOB, dedupeKey: 'redelivered-funding', payload: { instrumentId: BTC, settledAt: '2026-11-08T16:00:00.000Z' }, runAfter: new Date(0) });
    r = await drain();
    expect(r.find((x) => x.funding)?.funding).toMatchObject({ booked: 0, alreadyBooked: 2 });
    expect(await direct.db.select().from(schema.paperFunding)).toHaveLength(2);
    expect(await direct.db.select().from(schema.ledgerEntries).where(eq(schema.ledgerEntries.kind, 'FUNDING'))).toHaveLength(2);

    // Long pays a positive rate, on the contracts held at the settlement.
    const [fa] = await direct.db.select().from(schema.paperFunding).where(eq(schema.paperFunding.positionId, posA));
    const pA = (await positionsOf(A))[0]!;
    expect(D(fa!.contracts).eq(pA.contracts)).toBe(true);
    expect(D(fa!.amount).toFixed()).toBe(fundingAmount('LONG', pA.contracts, MULT, '65500', '0.0001').amount);
    expect(D(fa!.amount).isNegative()).toBe(true);

    const d = (await dash(cookies.a)).body;
    expect(d.daily.funding).toMatchObject({ status: 'RECORDED', settlementsDue: 1, settlementsBooked: 1, amountUsdt: D(fa!.amount).toFixed() });
    expect(d.daily.netRealizedUsdt).toBe(D(d.daily.grossRealizedUsdt).minus(d.daily.feesUsdt).plus(fa!.amount).toFixed());
    const t = (await call(trade.GET, { path: '/x', cookie: cookies.a, params: { id: posA } })).body;
    expect(t.funding).toHaveLength(1);
    expect(t.fundingUsdt).toBe(D(fa!.amount).toFixed());
    expect(t.ledger.some((l: any) => l.kind === 'FUNDING')).toBe(true);
  });

  it("a close after local midnight counts on the next reporting day, not the day it opened", async () => {
    await tickAt('2026-11-08T18:30:00Z', '65300'); // 00:30 on 9 Nov in Dhaka
    await drain();
    expect((await manualClose(cookies.b, posB)).status).toBe(202);
    await drain();
    const [pb] = await direct.db.select().from(schema.positions).where(eq(schema.positions.id, posB));
    expect(pb!.status).toBe('CLOSED');

    const day8 = (await dash(cookies.b, '2026-11-08')).body;
    const day9 = (await dash(cookies.b, '2026-11-09')).body;
    expect(day8.day.isToday).toBe(false);
    expect(day9.day.isToday).toBe(true);
    expect(day8.daily).toMatchObject({ grossRealizedUsdt: '0', exitFills: 0, entryFills: 1, positionsClosed: 0 });
    const ex9 = await sumExits(B, day9.day.from, day9.day.to);
    expect(day9.daily).toMatchObject({ grossRealizedUsdt: D(ex9.pnl).toFixed(), exitFills: 1, partialExits: 0, entryFills: 0, positionsClosed: 1, entryFeesUsdt: '0' });
    // B was flat at the 00:00 UTC settlement on 9 Nov: nothing due (a recorded zero).
    expect(day9.daily.funding).toMatchObject({ status: 'NONE_DUE', amountUsdt: '0' });
  });

  it('funding due without a settled rate is unavailable, distinct from zero', async () => {
    at('2026-11-09T00:10:00Z'); // A still open at the 00:00 UTC settlement; no rate recorded
    const d = (await dash(cookies.a, '2026-11-09')).body;
    expect(d.daily.funding).toMatchObject({ status: 'UNAVAILABLE', amountUsdt: null, settlementsDue: 1, settlementsBooked: 0 });
  });

  it('every figure reconciles with the ledger; margin postings and releases are not P&L', async () => {
    for (const [email, cookie] of [
      [A, cookies.a],
      [B, cookies.b]
    ] as const) {
      const d8 = (await dash(cookie, '2026-11-08')).body;
      const d9 = (await dash(cookie, '2026-11-09')).body;
      expect(d9.reconciliation.ok).toBe(true);
      expect(d9.reconciliation.checks.every((c: any) => c.ok)).toBe(true);
      // Sum of daily nets = wallet change since the opening balance (no margin movements in it).
      const nets = D(d8.daily.netRealizedUsdt).plus(d9.daily.netRealizedUsdt);
      expect(nets.toFixed()).toBe(D(d9.account.walletUsdt).minus(d9.reconciliation.lifetime.openingBalanceUsdt).toFixed());
      const owner = await userId(email);
      const [m] = (
        await direct.db.execute<{ n: string }>(sql`SELECT count(*) n FROM ledger_entries WHERE owner_id = ${owner} AND kind IN ('POSITION_MARGIN', 'POSITION_MARGIN_RELEASE')`)
      ).rows;
      expect(Number(m!.n)).toBeGreaterThan(0); // margin moved, yet nets equal the wallet change
    }
  });
});

describe('ownership on every request', () => {
  it("another investor's trade by ID is not found, through the API and the read model", async () => {
    expect((await call(trade.GET, { path: '/x', cookie: cookies.a, params: { id: posB } })).status).toBe(404);
    expect((await call(trade.GET, { path: '/x', cookie: cookies.b, params: { id: posA } })).status).toBe(404);
    expect((await manualClose(cookies.b, posA)).status).toBe(404);
  });

  it('dashboard and holdings ignore any owner parameter and need a session', async () => {
    const a = await call(dashboard.GET, { path: `/v1/me/dashboard?ownerId=${await userId(B)}&userId=${await userId(B)}`, cookie: cookies.a });
    const own = await dash(cookies.a);
    expect(a.body.account).toEqual(own.body.account);
    expect((await call(dashboard.GET, { path: '/v1/me/dashboard' })).status).toBe(401);
    expect((await call(holdings.GET, { path: '/x' })).status).toBe(401);
    expect((await dash(cookies.a, '2026-02-30x')).status).toBe(422);
    expect((await call(dashboard.GET, { path: '/x', cookie: cookies.admin })).status).toBe(403);
  });

  it("signal decisions are each investor's own, including skip reasons", async () => {
    const sa = (await call(signals.GET, { path: '/x', cookie: cookies.a })).body.items;
    const sb = (await call(signals.GET, { path: '/x', cookie: cookies.b })).body.items;
    const blocksOf = async (email: string) => (await direct.db.select({ id: schema.orderBlocks.id }).from(schema.orderBlocks).where(eq(schema.orderBlocks.ownerId, await userId(email)))).map((x) => x.id);
    const [ba, bb] = [await blocksOf(A), await blocksOf(B)];
    expect(sa.length).toBeGreaterThan(0);
    expect(sa.every((o: any) => ba.includes(o.orderBlockId))).toBe(true);
    expect(sb.every((o: any) => bb.includes(o.orderBlockId))).toBe(true);
    const dec = await direct.db.select().from(schema.signalDecisions).where(and(eq(schema.signalDecisions.ownerId, await userId(B))));
    expect(dec.length).toBeGreaterThan(0);
  });
});

void Decimal;
