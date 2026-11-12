// Step 11: the MEXC private adapter driven by the REAL execution flow (TradingView alert → durable
// order intents → worker jobs → venue), with the exchange mocked. Covers the attached stop, missing
// and rejected stops, partial fills, duplicate fill records, timeouts where MEXC may have accepted
// the order, reconciliation before any retry, closes that cannot flip, and stop coverage after a
// partial close. Capabilities are marked VERIFIED here as MOCK evidence for the test only; the
// shipped registry verifies nothing, so production would refuse every order (see mexcPrivate.test).
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { mexcVenue, requestExit, schema, type ExecutionVenue } from '@trendpilot/db';
import { Decimal } from '@trendpilot/domain';
import { setTestClock } from '@/server/clock';
import { direct, teardown, userId, USERS } from '../helpers';
import { MockMexc } from '../mexcMock';
import { clock, drain, openFromAlert, plus, positionsOf, reconciled, tick } from '../paperReplay';

const A = USERS.investorA.email;
const B = USERS.investorB.email;
const mexc = new MockMexc();
const MOCK_EVIDENCE = { OPEN_WITH_ATTACHED_STOP: 'VERIFIED', REDUCE_ONLY_CLOSE: 'VERIFIED', STOP_RESIZE_AFTER_PARTIAL_CLOSE: 'VERIFIED' } as const;
const venue = (capabilities: Record<string, 'VERIFIED'> | undefined = MOCK_EVIDENCE): ExecutionVenue =>
  mexcVenue({ requester: mexc, symbolFor: async () => 'BTC_USDT', positionMode: 'HEDGE', capabilities, confirm: { attempts: 2, delayMs: 0 }, sleep: async () => {} });
const hooks = (v = venue()) => ({ venue: v });
const D = (v: Decimal.Value) => new Decimal(v);
const intentsOf = async (email: string) => direct.db.select().from(schema.orderIntents).where(eq(schema.orderIntents.ownerId, await userId(email))).orderBy(schema.orderIntents.createdAt);
const fillsOf = async (email: string) => direct.db.select().from(schema.fills).where(eq(schema.fills.ownerId, await userId(email)));
const feeRows = async (email: string) => direct.db.select().from(schema.ledgerEntries).where(and(eq(schema.ledgerEntries.ownerId, await userId(email)), eq(schema.ledgerEntries.kind, 'TRADING_FEE')));
const mockPos = (side: 1 | 2 = 1) => mexc.positions.get(`BTC_USDT:${side}`);
const activeStops = () => [...mexc.stops.values()].filter((s) => s.state === 1);
const createBodies = () => mexc.creates().map((c) => c.body as Record<string, unknown>);
/** Advances the clock and drains (retried jobs become due after their backoff). */
const later = async (seconds: number, h = hooks()) => {
  clock.now = plus(clock.now, seconds);
  setTestClock(() => clock.now);
  return drain(clock.now, direct.db, h);
};

beforeEach(() => {
  mexc.orders.clear();
  mexc.deals.clear();
  mexc.stops.clear();
  mexc.positions.clear();
  mexc.reset();
});
afterAll(async () => {
  setTestClock(null);
  await teardown();
});

describe('opening with the stop in the same request', () => {
  it('blocks entry when the attached-stop capability is unverified (the shipped default)', async () => {
    await openFromAlert({ b: null, hooks: hooks(venue({})) });
    expect(mexc.creates()).toHaveLength(0);
    const [i] = await intentsOf(A);
    expect(i).toMatchObject({ state: 'REJECTED', stateReason: 'CAPABILITY_UNVERIFIED:OPEN_WITH_ATTACHED_STOP' });
    expect(await positionsOf(A)).toHaveLength(0);
    expect(await reconciled()).toBe(true); // the reservation was released
  });

  it('Long: side 1, market, leverage, isolated, client order ID and the stop (mark basis) in ONE request', async () => {
    await openFromAlert({ hooks: hooks() });
    const [ia] = await intentsOf(A);
    const [ib] = await intentsOf(B);
    // Jobs from one alert may run in either order: match each request by its client order ID.
    const a = createBodies().find((x) => x.externalOid === ia!.clientOrderId);
    const b = createBodies().find((x) => x.externalOid === ib!.clientOrderId);
    expect(a).toMatchObject({ symbol: 'BTC_USDT', side: 1, type: 5, openType: 1, leverage: 10, externalOid: ia!.clientOrderId, stopLossPrice: D(ia!.stopPrice).toFixed(), lossTrend: 2, positionMode: 1, vol: D(ia!.contracts).toFixed() });
    expect(b).toMatchObject({ side: 1, leverage: 5, lossTrend: 1 }); // B: stop on LAST price
    const [pa] = await positionsOf(A);
    expect(pa).toMatchObject({ status: 'OPEN', protectionStatus: 'PROTECTED' });
    expect(pa!.stopOrderRef).toMatch(/^mexc-sl:\d+$/);
    expect(D(pa!.stopContracts!).eq(pa!.contracts)).toBe(true);
    expect((await fillsOf(A)).map((f) => f.exchangeFillId)).toEqual([`mexc:${mexc.orders.get(ia!.clientOrderId)!.orderId}`]);
    expect(await reconciled()).toBe(true);
  });

  it('Short: side 3 with the stop above the entry', async () => {
    await openFromAlert({ side: 'SHORT', b: null, hooks: hooks() });
    const [a] = createBodies();
    expect(a).toMatchObject({ side: 3, type: 5 });
    expect(D(String(a!.stopLossPrice)).gt('65000')).toBe(true);
    expect((await positionsOf(A))[0]).toMatchObject({ side: 'SHORT', protectionStatus: 'PROTECTED' });
  });
});

describe('rejected or missing stops: emergency close, never left unprotected', () => {
  for (const fault of ['missing', 'failed'] as const) {
    it(`stop ${fault} after the fill → UNPROTECTED, then an immediate reduce-only close`, async () => {
      mexc.faults.attachStop = fault;
      await openFromAlert({ b: null, hooks: hooks() });
      const [open, close] = await intentsOf(A);
      expect(open).toMatchObject({ state: 'FILLED', stateReason: 'PROTECTION_UNVERIFIED' });
      expect(close).toMatchObject({ kind: 'CLOSE', exitReason: 'PROTECTION_FAILURE', state: 'FILLED' });
      const [p] = await positionsOf(A);
      expect(p).toMatchObject({ status: 'CLOSED', closeReason: 'PROTECTION_FAILURE' });
      const closeBody = createBodies()[1]!;
      expect(closeBody).toMatchObject({ side: 4, type: 5 });
      expect(D(mockPos(1)!.holdVol).isZero()).toBe(true);
      expect(mockPos(2)).toBeUndefined(); // no Short was opened by the close
    });
  }

  it('an exchange rejection of the opening order releases the reservation and opens nothing', async () => {
    mexc.faults.rejectCode = 2005; // Balance insufficient
    await openFromAlert({ b: null, hooks: hooks() });
    expect((await intentsOf(A))[0]).toMatchObject({ state: 'REJECTED', stateReason: 'MEXC_2005' });
    expect(await positionsOf(A)).toHaveLength(0);
    expect(await reconciled()).toBe(true);
  });
});

describe('partial fills and duplicate fill records', () => {
  it('a partially filled open books only the filled contracts; the stop must cover exactly them', async () => {
    mexc.faults.fillRatio = 0.6;
    await openFromAlert({ b: null, hooks: hooks() });
    const [i] = await intentsOf(A);
    const [p] = await positionsOf(A);
    const filled = D(i!.contracts).times('0.6').floor();
    expect(D(p!.contracts).eq(filled)).toBe(true);
    expect(D(p!.stopContracts!).eq(filled)).toBe(true);
    expect(p!.protectionStatus).toBe('PROTECTED');
    expect(await reconciled()).toBe(true);
  });

  it('a deal listed twice by the exchange is booked once', async () => {
    mexc.faults.duplicateDeals = true;
    await openFromAlert({ b: null, hooks: hooks() });
    const [i] = await intentsOf(A);
    const [p] = await positionsOf(A);
    expect(D(p!.contracts).eq(i!.contracts)).toBe(true); // not doubled
    expect(await fillsOf(A)).toHaveLength(1);
    expect(await feeRows(A)).toHaveLength(1);
    const deal = mexc.deals.get(mexc.orders.get(i!.clientOrderId)!.orderId)![0]!;
    expect(D(p!.feesUsdt).eq(deal.fee)).toBe(true);
  });
});

describe('timeouts where MEXC may have accepted the order', () => {
  it('accepted but the response timed out: reconciled by client order ID, never resent', async () => {
    mexc.faults.timeoutAfterAccept = 1;
    await openFromAlert({ b: null, hooks: hooks() });
    expect(mexc.creates()).toHaveLength(1);
    expect((await positionsOf(A))[0]).toMatchObject({ status: 'OPEN', protectionStatus: 'PROTECTED' });
  });

  it('accepted, timed out, and not yet visible: the intent waits and reconciles; still one order', async () => {
    mexc.faults.timeoutAfterAccept = 1;
    mexc.faults.invisibleLookups = 3; // the order shows up only on the 4th lookup
    await openFromAlert({ b: null, hooks: hooks() });
    expect((await intentsOf(A))[0]!.state).toBe('SUBMITTING'); // uncertain: no fill booked, no resend
    expect(await positionsOf(A)).toHaveLength(0);
    for (let i = 0; i < 6 && (await positionsOf(A)).length === 0; i++) await later(5);
    expect(mexc.creates()).toHaveLength(1);
    expect(mexc.orders.size).toBe(1);
    expect((await intentsOf(A))[0]!.state).toBe('FILLED');
    expect((await positionsOf(A))[0]!.protectionStatus).toBe('PROTECTED');
  });

  it('timed out before MEXC received it: no resend inside the grace period; one resend with the SAME client ID after it', async () => {
    mexc.faults.timeoutBeforeAccept = 1;
    await openFromAlert({ b: null, hooks: hooks() });
    const [i] = await intentsOf(A);
    expect(i!.state).toBe('SUBMITTING');
    await later(5);
    await later(5);
    expect(mexc.creates()).toHaveLength(1); // only the lost attempt; nothing resent while uncertain
    await later(31);
    expect(mexc.creates()).toHaveLength(2);
    expect(createBodies().map((b) => b.externalOid)).toEqual([i!.clientOrderId, i!.clientOrderId]);
    expect(mexc.orders.size).toBe(1);
    expect((await positionsOf(A))[0]).toMatchObject({ status: 'OPEN', protectionStatus: 'PROTECTED' });
  });

  it('a lookup that cannot reach MEXC is never treated as "absent": no first send, and no resend', async () => {
    mexc.faults.lookupNetworkError = true;
    await openFromAlert({ b: null, hooks: hooks() });
    expect(mexc.creates()).toHaveLength(0); // absence could not be confirmed, so nothing was sent
    expect((await intentsOf(A))[0]!.state).toBe('SUBMITTING');
  });

  it('when the lookup fails after MEXC accepted the order, the state stays unknown and nothing is resent', async () => {
    mexc.faults.timeoutAfterAccept = 1;
    mexc.faults.lookupFailsAfterAccept = true;
    await openFromAlert({ b: null, hooks: hooks() });
    await later(5);
    await later(40); // even past the grace period: a failed lookup is not "absent"
    expect(mexc.creates()).toHaveLength(1);
    expect((await intentsOf(A))[0]!.state).toBe('SUBMITTING');
    expect(await positionsOf(A)).toHaveLength(0);
    mexc.faults.lookupNetworkError = false;
    for (let i = 0; i < 6 && (await positionsOf(A)).length === 0; i++) await later(65);
    expect(mexc.creates()).toHaveLength(1);
    expect((await positionsOf(A))[0]!.status).toBe('OPEN');
  });
});

describe('closes: TP, signal, manual — reduce only, never flipping, stop kept for the remainder', () => {
  it('a manual full close sends side 4 for the held contracts and clears the stop', async () => {
    await openFromAlert({ b: null, hooks: hooks() });
    const [p] = await positionsOf(A);
    await direct.db.transaction((tx) => requestExit(tx, { position: p!, reason: 'MANUAL_CLOSE', now: clock.now }));
    await drain(clock.now, direct.db, hooks());
    const close = createBodies()[1]!;
    expect(close).toMatchObject({ side: 4, type: 5, vol: D(p!.contracts).toFixed() });
    expect(close.reduceOnly).toBeUndefined(); // hedge mode: close side; reduceOnly applies only in one-way mode
    expect((await positionsOf(A))[0]).toMatchObject({ status: 'CLOSED', closeReason: 'MANUAL_CLOSE' });
    expect(activeStops()).toHaveLength(0);
    expect(mockPos(2)).toBeUndefined();
    expect(await reconciled()).toBe(true);
  });

  it('a close larger than the venue position is capped: it can never open the opposite side', async () => {
    await openFromAlert({ b: null, hooks: hooks() });
    mockPos(1)!.holdVol = '100'; // the venue holds less than the platform expects
    const [p] = await positionsOf(A);
    await direct.db.transaction((tx) => requestExit(tx, { position: p!, reason: 'SIGNAL_CLOSE', now: clock.now }));
    await drain(clock.now, direct.db, hooks());
    expect(createBodies()[1]).toMatchObject({ side: 4, vol: '100' });
    expect(mockPos(2)).toBeUndefined();
    expect(D(mockPos(1)!.holdVol).isZero()).toBe(true);
  });

  it('a split take-profit partial close keeps the stop equal to the remaining contracts (explicit resize)', async () => {
    const SPLIT = { mode: 'SPLIT', levels: [{ id: 'tp1', movePct: '1', closePct: '50' }, { id: 'tp2', movePct: '10', closePct: '50' }] };
    await openFromAlert({ a: { takeProfit: SPLIT }, b: null, hooks: hooks() });
    const before = (await positionsOf(A))[0]!;
    await tick('65700'); // arms tp1 (reaching a target never closes)
    await drain(clock.now, direct.db, hooks());
    await tick('65600'); // the pullback through tp1 closes its share
    await drain(clock.now, direct.db, hooks());
    const p = (await positionsOf(A))[0]!;
    expect(D(p.contracts).lt(before.contracts)).toBe(true);
    expect(p).toMatchObject({ status: 'OPEN', protectionStatus: 'PROTECTED' });
    expect(D(p.stopContracts!).eq(p.contracts)).toBe(true);
    expect(p.stopOrderRef).not.toBe(before.stopOrderRef); // MEXC replaced the stop order
    expect(activeStops().map((s) => s.vol)).toEqual([D(p.contracts).toFixed()]);
    expect(activeStops()[0]!.stopLossPrice).toBe(String(createBodies()[0]!.stopLossPrice)); // same trigger, never widened
    expect(mexc.calls.filter((c) => c.path === '/api/v1/private/stoporder/cancel')).toHaveLength(1);
  });

  it('when the exchange shrinks the stop itself, nothing is re-placed', async () => {
    mexc.faults.stopAutoShrink = true;
    const SPLIT = { mode: 'SPLIT', levels: [{ id: 'tp1', movePct: '1', closePct: '50' }, { id: 'tp2', movePct: '10', closePct: '50' }] };
    await openFromAlert({ a: { takeProfit: SPLIT }, b: null, hooks: hooks() });
    const ref = (await positionsOf(A))[0]!.stopOrderRef;
    await tick('65700'); // arms tp1 (reaching a target never closes)
    await drain(clock.now, direct.db, hooks());
    await tick('65600'); // the pullback through tp1 closes its share
    await drain(clock.now, direct.db, hooks());
    const p = (await positionsOf(A))[0]!;
    expect(p).toMatchObject({ stopOrderRef: ref, protectionStatus: 'PROTECTED' });
    expect(mexc.calls.filter((c) => c.path === '/api/v1/private/stoporder/cancel' || c.path === '/api/v1/private/stoporder/place')).toHaveLength(0);
    expect(activeStops().map((x) => x.vol)).toEqual([D(p.contracts).toFixed()]);
  });

  it('if the stop cannot be resized (capability unverified), the remainder is flagged UNPROTECTED, not silently left', async () => {
    const SPLIT = { mode: 'SPLIT', levels: [{ id: 'tp1', movePct: '1', closePct: '50' }, { id: 'tp2', movePct: '10', closePct: '50' }] };
    const noResize = venue({ OPEN_WITH_ATTACHED_STOP: 'VERIFIED', REDUCE_ONLY_CLOSE: 'VERIFIED' });
    await openFromAlert({ a: { takeProfit: SPLIT }, b: null, hooks: hooks(noResize) });
    await tick('65700'); // arms tp1 (reaching a target never closes)
    await drain(clock.now, direct.db, hooks(noResize));
    await tick('65600'); // the pullback through tp1 closes its share
    await drain(clock.now, direct.db, hooks(noResize));
    expect((await positionsOf(A))[0]).toMatchObject({ status: 'OPEN', protectionStatus: 'UNPROTECTED' });
  });

  it('a rejected close (e.g. 2008) leaves the position open and protected', async () => {
    await openFromAlert({ b: null, hooks: hooks() });
    const [p] = await positionsOf(A);
    mexc.faults.rejectCode = 2008;
    await direct.db.transaction((tx) => requestExit(tx, { position: p!, reason: 'MANUAL_CLOSE', now: clock.now }));
    await drain(clock.now, direct.db, hooks());
    expect((await intentsOf(A)).at(-1)).toMatchObject({ kind: 'CLOSE', state: 'REJECTED', stateReason: 'MEXC_2008' });
    expect((await positionsOf(A))[0]).toMatchObject({ status: 'OPEN', protectionStatus: 'PROTECTED' });
  });
});

describe('isolation of the two investors through the adapter', () => {
  it('one alert opens one position per investor with its own client order ID and stop', async () => {
    await openFromAlert({ hooks: hooks() });
    const ids = createBodies().map((b) => b.externalOid);
    expect(new Set(ids).size).toBe(2);
    expect(await positionsOf(A)).toHaveLength(1);
    expect(await positionsOf(B)).toHaveLength(1);
  });
});
