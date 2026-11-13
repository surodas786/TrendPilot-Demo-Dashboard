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
const venue = (capabilities: Record<string, 'VERIFIED'> | undefined = MOCK_EVIDENCE, positionMode: 'ONE_WAY' | 'HEDGE' = 'ONE_WAY'): ExecutionVenue =>
  mexcVenue({ requester: mexc, symbolFor: async () => 'BTC_USDT', positionMode, capabilities, confirm: { attempts: 2, delayMs: 0 }, sleep: async () => {} });
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
  mexc.positionMode = 2; // One-way: required for Live entries
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
    expect(a).toMatchObject({ symbol: 'BTC_USDT', side: 1, type: 5, openType: 1, leverage: 10, externalOid: ia!.clientOrderId, stopLossPrice: D(ia!.stopPrice).toFixed(), lossTrend: 2, positionMode: 2, vol: D(ia!.contracts).toFixed() });
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

describe('Hedge position mode: no new entries; existing positions still close without adding exposure', () => {
  const opens = () => createBodies().filter((b) => b.side === 1 || b.side === 3);

  it('a connection verified in Hedge mode cannot open: refused before any order is sent', async () => {
    mexc.positionMode = 1;
    await openFromAlert({ b: null, hooks: hooks(venue(MOCK_EVIDENCE, 'HEDGE')) });
    expect(mexc.creates()).toHaveLength(0);
    expect(mexc.calls).toHaveLength(0); // not even a lookup
    const [i] = await intentsOf(A);
    expect(i).toMatchObject({ state: 'REJECTED', stateReason: 'POSITION_MODE_ONE_WAY_REQUIRED' });
    expect(await positionsOf(A)).toHaveLength(0);
    expect(await reconciled()).toBe(true); // reservation released
  });

  it('an account switched to Hedge at MEXC after it was verified: re-read right before sending, refused', async () => {
    mexc.positionMode = 1; // the stored connection still says One-way
    await openFromAlert({ b: null, hooks: hooks() });
    expect(mexc.calls.some((c) => c.method === 'GET' && c.path === '/api/v1/private/position/position_mode')).toBe(true);
    expect(mexc.creates()).toHaveLength(0);
    expect((await intentsOf(A))[0]).toMatchObject({ state: 'REJECTED', stateReason: 'POSITION_MODE_ONE_WAY_REQUIRED' });
    expect(await positionsOf(A)).toHaveLength(0);
  });

  it('an existing Long on a Hedge account closes with the close-long side only, capped at what MEXC holds; no Short is opened', async () => {
    await openFromAlert({ b: null, hooks: hooks() }); // opened while One-way
    mexc.positionMode = 1; // then the account is switched to Hedge
    mockPos(1)!.holdVol = '100'; // MEXC holds less than the platform expects
    const [p] = await positionsOf(A);
    await direct.db.transaction((tx) => requestExit(tx, { position: p!, reason: 'MANUAL_CLOSE', now: clock.now }));
    await drain(clock.now, direct.db, hooks(venue(MOCK_EVIDENCE, 'HEDGE')));
    const close = createBodies()[1]!;
    expect(close).toMatchObject({ side: 4, type: 5, vol: '100', positionMode: 1 }); // 4 = close long; never 1/3 (open)
    expect(close.reduceOnly).toBeUndefined(); // MEXC: reduceOnly applies only in One-way mode
    expect(close.positionId).toBe(Number(mockPos(1)!.positionId));
    expect(opens()).toHaveLength(1); // only the original entry
    expect(mockPos(2)).toBeUndefined(); // no Short
    expect(D(mockPos(1)!.holdVol).isZero()).toBe(true);
  });

  it('a close when MEXC holds nothing on that side sends no order at all (cannot open the opposite side)', async () => {
    await openFromAlert({ b: null, hooks: hooks() });
    mexc.positionMode = 1;
    mexc.positions.delete('BTC_USDT:1'); // closed elsewhere
    const [p] = await positionsOf(A);
    await direct.db.transaction((tx) => requestExit(tx, { position: p!, reason: 'SIGNAL_CLOSE', now: clock.now }));
    await drain(clock.now, direct.db, hooks(venue(MOCK_EVIDENCE, 'HEDGE')));
    expect(createBodies()).toHaveLength(1); // the entry only; no close order was sent
    expect(mockPos(1)).toBeUndefined();
    expect(mockPos(2)).toBeUndefined();
  });
});

describe('closes: TP, signal, manual — reduce only, never flipping, stop kept for the remainder', () => {
  it('a manual full close sends side 4 for the held contracts and clears the stop', async () => {
    await openFromAlert({ b: null, hooks: hooks() });
    const [p] = await positionsOf(A);
    await direct.db.transaction((tx) => requestExit(tx, { position: p!, reason: 'MANUAL_CLOSE', now: clock.now }));
    await drain(clock.now, direct.db, hooks());
    const close = createBodies()[1]!;
    expect(close).toMatchObject({ side: 4, type: 5, vol: D(p!.contracts).toFixed(), reduceOnly: true, positionMode: 2 }); // One-way: close side AND reduceOnly
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

describe('MEXC externalOid: at most 32 characters, stored once, reused everywhere (error 2030)', () => {
  const OID = /^[0-9a-f]{32}$/;
  const lookupsOf = (id: string) => mexc.calls.filter((c) => c.method === 'GET' && c.path === `/api/v1/private/order/external/BTC_USDT/${id}`);

  it('entry: the stored client order ID is 32 hex characters and is the one sent and looked up', async () => {
    await openFromAlert({ b: null, hooks: hooks() });
    const [i] = await intentsOf(A);
    expect(i!.clientOrderId).toMatch(OID);
    expect(createBodies().map((b) => b.externalOid)).toEqual([i!.clientOrderId]);
    expect(lookupsOf(i!.clientOrderId).length).toBeGreaterThan(0);
    expect(mexc.calls.filter((c) => c.path.startsWith('/api/v1/private/order/external/')).every((c) => c.path.endsWith(`/${i!.clientOrderId}`))).toBe(true);
    expect(i).toMatchObject({ state: 'FILLED' });
  });

  it('entry retry after a lost submission resends the SAME stored 32-character ID', async () => {
    mexc.faults.timeoutBeforeAccept = 1;
    await openFromAlert({ b: null, hooks: hooks() });
    const [before] = await intentsOf(A);
    await later(41);
    const [after] = await intentsOf(A);
    expect(after!.clientOrderId).toBe(before!.clientOrderId);
    expect(createBodies().map((b) => b.externalOid)).toEqual([before!.clientOrderId, before!.clientOrderId]);
    expect(after!.clientOrderId).toMatch(OID);
  });

  it('exit: the close intent gets its own 32-character ID, used for the submission and lookups', async () => {
    await openFromAlert({ b: null, hooks: hooks() });
    const [p] = await positionsOf(A);
    await direct.db.transaction((tx) => requestExit(tx, { position: p!, reason: 'MANUAL_CLOSE', now: clock.now }));
    await drain(clock.now, direct.db, hooks());
    const [open, close] = await intentsOf(A);
    expect(close).toMatchObject({ kind: 'CLOSE', state: 'FILLED' });
    expect(close!.clientOrderId).toMatch(OID);
    expect(close!.clientOrderId).not.toBe(open!.clientOrderId);
    expect(createBodies().map((b) => b.externalOid)).toEqual([open!.clientOrderId, close!.clientOrderId]);
    expect(lookupsOf(close!.clientOrderId).length).toBeGreaterThan(0);
  });

  it('exit retry after a lost submission resends the SAME stored 32-character ID', async () => {
    await openFromAlert({ b: null, hooks: hooks() });
    const [p] = await positionsOf(A);
    mexc.faults.timeoutBeforeAccept = 1;
    await direct.db.transaction((tx) => requestExit(tx, { position: p!, reason: 'MANUAL_CLOSE', now: clock.now }));
    await drain(clock.now, direct.db, hooks());
    for (let i = 0; i < 6 && (await positionsOf(A))[0]!.status === 'OPEN'; i++) await later(15);
    const close = (await intentsOf(A)).at(-1)!;
    expect(close.clientOrderId).toMatch(OID);
    expect(createBodies().slice(1).map((b) => b.externalOid)).toEqual([close.clientOrderId, close.clientOrderId]);
    expect((await positionsOf(A))[0]).toMatchObject({ status: 'CLOSED' });
  });

  it('a historical 39/40-character ID is kept and still looked up, but never sent to MEXC', async () => {
    const v = venue();
    const old = 'tp-310c38b4-d4e1-4183-84ef-9a59bb904355';
    const oldExit = 'tpx-0f1f90f5-768d-462d-8422-436378c92bdf';
    const open = await v.placeOpeningOrderWithStop({ paperAccountId: 'a', clientOrderId: old, instrumentId: 'i', side: 'LONG', contracts: '10', contract: { multiplier: '0.0001', qtyStep: '1', minQty: '1', takerFeeRate: '0.0004' }, quote: { bid: '65000', ask: '65001' }, stop: { price: '64000', basis: 'MARK' }, now: new Date(), leverage: 5 } as never);
    expect(open).toMatchObject({ status: 'REJECTED', clientOrderId: old, reason: 'CLIENT_ORDER_ID_TOO_LONG' });
    mexc.positions.set('BTC_USDT:1', { positionId: 1, symbol: 'BTC_USDT', positionType: 1, holdVol: '10', holdAvgPrice: '65000' } as never);
    const close = await v.placeReduceOnlyClose({ paperAccountId: 'a', clientOrderId: oldExit, instrumentId: 'i', positionSide: 'LONG', contracts: '10', contract: { multiplier: '0.0001', qtyStep: '1', takerFeeRate: '0.0004' }, quote: { bid: '65000', ask: '65001', mark: '65000', last: '65000' }, now: new Date() } as never);
    expect(close).toMatchObject({ status: 'REJECTED', clientOrderId: oldExit, reason: 'CLIENT_ORDER_ID_TOO_LONG' });
    expect(mexc.creates()).toHaveLength(0);
    expect(lookupsOf(old)).toHaveLength(1);
    expect(lookupsOf(oldExit)).toHaveLength(1);
    expect(await v.lookupOrder(old, 'i')).toBeNull();
  });

  it('the mock answers an over-long externalOid like production MEXC: code 2030', async () => {
    await expect(mexc.request('POST', '/api/v1/private/order/create', { symbol: 'BTC_USDT', side: 1, vol: '1', externalOid: 'tp-310c38b4-d4e1-4183-84ef-9a59bb904355' })).rejects.toMatchObject({ code: 2030 });
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
