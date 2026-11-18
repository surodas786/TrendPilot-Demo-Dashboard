// Lighter Step 4: private adapter and order protection, against a MOCKED Lighter exchange and signer.
// Connection through the investor APIs; orders through the REAL submit / close jobs, Live guard and
// Lighter venue. Lighter Live entry evaluation and the admin approval / activation / allowlist stay
// refused in this build, so the Live gates an order needs are set directly as a test fixture.
import { and, desc, eq, inArray } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  acquireLighterKeyLease,
  enqueueJob,
  installLighterTestSeam,
  installLiveTestSeam,
  lighterScopeOf,
  lighterLiveRefusalFor,
  lighterVenue,
  lockPaperAccount,
  book,
  PAPER_SUBMIT_JOB,
  recordMarketTick,
  requestExit,
  resolveAccountVenue,
  schema,
  setLiveActivation,
  syncLighterConnection,
  lighterMarketOf,
  lighterSignerLoads,
  unavailableLighterSigner,
  lighterConnectionsToSync,
  syncAllLighterConnections,
  lighterTestnetEnabled,
  openLighterOrderTransport,
  runLighterTestnetCheck,
  LighterHttpApi,
  lighterSignerBinding,
  getOperationsStatus,
  type ConnectionRow
} from '@trendpilot/db';
import { startWorker } from '../../../worker/src/worker';
import { Decimal } from '@trendpilot/domain';
import * as blocks from '@/app/v1/me/order-blocks/route';
import * as conn from '@/app/v1/me/exchange-connection/route';
import * as verify from '@/app/v1/me/exchange-connection/verify/route';
import * as syncRoute from '@/app/v1/me/exchange-connection/sync/route';
import * as activate from '@/app/v1/me/live/activate/route';
import * as contracts from '@/app/v1/admin/live/contracts/[id]/route';
import * as approve from '@/app/v1/admin/live/connections/[id]/approve/route';
import * as capabilities from '@/app/v1/admin/live/capabilities/route';
import * as platform from '@/app/v1/admin/live/platform/route';
import * as lighterInstrument from '@/app/v1/admin/instruments/lighter/route';
import { liveStatusFor } from '@/server/live';
import { setTestClock } from '@/server/clock';
import { BTC, blockBody, call, direct, teardown, userId, USERS } from '../helpers';
import { MockLighter, mockSigner } from '../lighterMock';
import { ALL_DAYS, clock, cookies, drain, openFromAlert, plus, publishVersion } from '../paperReplay';

const D = (v: Decimal.Value) => new Decimal(v);
const KEY = 'c3'.repeat(40);
const envBackup = { ...process.env };
let idA: string;
let idB: string;
let adminId: string;
let xau: string;
let blockA: string;
let ex: MockLighter;
let signer: ReturnType<typeof mockSigner>;
let signerEnabled = true;

const ltConn = async (ownerId: string): Promise<ConnectionRow> => (await direct.db.select().from(schema.exchangeConnections).where(and(eq(schema.exchangeConnections.ownerId, ownerId), eq(schema.exchangeConnections.exchange, 'LIGHTER'))))[0]!;
const intentRow = async (id: string) => (await direct.db.select().from(schema.orderIntents).where(eq(schema.orderIntents.id, id)))[0]!;
const positionOf = async (intentId: string) => (await direct.db.select().from(schema.positions).where(eq(schema.positions.openIntentId, intentId)))[0];
const ltAccount = async (ownerId: string) => (await direct.db.select().from(schema.paperAccounts).where(and(eq(schema.paperAccounts.ownerId, ownerId), eq(schema.paperAccounts.mode, 'LIVE'), eq(schema.paperAccounts.exchange, 'LIGHTER'))))[0]!;
const txRows = () => direct.db.select().from(schema.lighterTxs).orderBy(desc(schema.lighterTxs.createdAt));
const putLighter = (cookie: string, body: Record<string, unknown>) => call(conn.PUT, { method: 'PUT', path: '/x', cookie, body: { exchange: 'LIGHTER', environment: 'MAINNET', accountIndex: '4242', apiKeyIndex: '5', apiPrivateKey: KEY, ...body } });

async function quote(bid = '2399.90', ask = '2400.10') {
  await recordMarketTick(direct.db, { instrumentId: xau, asOf: clock.now, bid, ask, mark: '2400', last: '2400', source: 'LIGHTER_PUBLIC' });
}

/** A Live Lighter OPEN intent with its reservation and submit job, as the entry path would create it (that path refuses Lighter Live in this build). */
async function openIntent(side: 'LONG' | 'SHORT', o: { contracts?: string; stop?: string; basis?: string } = {}) {
  const [block] = await direct.db.select().from(schema.orderBlocks).where(eq(schema.orderBlocks.id, blockA));
  const [event] = await direct.db.select().from(schema.signalEvents).orderBy(desc(schema.signalEvents.receivedAt)).limit(1);
  return direct.db.transaction(async (tx) => {
    const acct = await lockPaperAccount(tx, idA, 'LIVE', 'LIGHTER', { lighterLiveLedger: true });
    const [decision] = await tx
      .insert(schema.signalDecisions)
      .values({ eventId: event!.id, ownerId: idA, orderBlockId: blockA, strategyVersionId: block!.strategyVersionId, step: `lighter-test-${Math.random().toString(36).slice(2)}`, status: 'ENTRY_APPROVED', detail: {}, evaluatedAt: clock.now, correlationId: 'lighter-test' })
      .returning();
    const [intent] = await tx
      .insert(schema.orderIntents)
      .values({
        ownerId: idA,
        paperAccountId: acct.id,
        orderBlockId: blockA,
        decisionId: decision!.id,
        eventId: event!.id,
        instrumentId: xau,
        mode: 'LIVE',
        kind: 'OPEN',
        side,
        clientOrderId: `lt${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`,
        contracts: o.contracts ?? '0.0100',
        quantity: o.contracts ?? '0.0100',
        expectedPrice: side === 'LONG' ? '2400.10' : '2399.90',
        stopPrice: o.stop ?? (side === 'LONG' ? '2300' : '2500'),
        stopBasis: o.basis ?? 'MARK',
        leverage: 10,
        marginMode: 'ISOLATED',
        reservedUsdt: '2.5',
        sizing: { liquidationEstimate: side === 'LONG' ? '2170' : '2630' },
        settingsSnapshot: {
          block: { id: blockA, takeProfit: { mode: 'OFF', levels: [] }, trailing: { enabled: false, activationPct: null, distancePct: null, basis: 'MARK' }, weekdays: ALL_DAYS, timezone: 'UTC', tradingWindow: null, leverage: 10, marginMode: 'ISOLATED' },
          strategyVersion: { id: block!.strategyVersionId }
        }
      })
      .returning();
    await book(tx, acct, [{ kind: 'ORDER_RESERVE', bucket: 'ORDER_RESERVE', amount: '2.5', refType: 'order_intent', refId: intent!.id, memo: 'test reservation' }]);
    await enqueueJob(tx, { kind: PAPER_SUBMIT_JOB, dedupeKey: `${PAPER_SUBMIT_JOB}:${intent!.id}`, payload: { intentId: intent!.id }, runAfter: clock.now });
    return intent!;
  });
}

async function verifyCaps(ids: string[], state = 'PILOT_ACCEPTED') {
  for (const c of ids) expect((await call(capabilities.POST, { method: 'POST', path: '/x', cookie: cookies.admin, body: { capability: c, state, evidence: 'test: mocked Lighter' } })).status).toBe(200);
}
const ALL_LIGHTER = ['LIGHTER_SIGNER', 'LIGHTER_KEY_MATCH', 'LIGHTER_ACCOUNT_SETTINGS', 'LIGHTER_OPEN_WITH_LINKED_STOP', 'LIGHTER_REDUCE_ONLY_CLOSE', 'LIGHTER_STOP_RESIZE', 'LIGHTER_ORDER_LOOKUP', 'LIGHTER_FILL_FEES', 'LIGHTER_XAU_EXECUTION'];
const INPUTS = { LIGHTER_ENTRY_WORST_PRICE_PCT: '0.5', LIGHTER_STOP_WORST_PRICE_PCT: '2', LIGHTER_CLOSE_WORST_PRICE_PCT: '1', LIGHTER_TAKER_FEE_RATE: '0.0002' };

/** Live gates for A's Lighter connection (fixture: the admin and investor routes refuse them in this build). */
async function openGatesForA() {
  const c = await ltConn(idA);
  await direct.db
    .update(schema.exchangeConnections)
    .set({ approvedAt: new Date(), approvedBy: adminId, maxOrderContracts: '1', maxOrderNotionalUsdt: '500', maxLeverage: 10, maxExposureUsdt: '1000', liveEnabled: true, entriesHalted: false, haltReason: null })
    .where(eq(schema.exchangeConnections.id, c.id));
  await direct.db.update(schema.instruments).set({ liveAllowed: true }).where(eq(schema.instruments.id, xau));
  inScopeFor(c.id);
}

/** The Lighter Live scope (deployment settings) for one connection on XAU (market 92); reset after each test. */
function inScopeFor(connectionId: string) {
  Object.assign(process.env, { LIGHTER_MAINNET_ORDERS: 'enabled', LIGHTER_LIVE_CONNECTIONS: connectionId, LIGHTER_LIVE_MARKETS: '92' });
}

const settle = async () => {
  clock.now = plus(clock.now, 600);
  setTestClock(() => clock.now);
  await quote();
  return drain(clock.now);
};

beforeAll(async () => {
  await openFromAlert({ a: null, b: null });
  idA = await userId(USERS.investorA.email);
  idB = await userId(USERS.investorB.email);
  adminId = await userId(USERS.admin.email);
  ex = new MockLighter();
  signer = mockSigner();
  installLighterTestSeam({ apiFor: () => ex, signerFor: () => (signerEnabled ? signer : (undefined as never)) });
  installLiveTestSeam({ requesterFor: () => { throw new Error('no MEXC in this test'); }, transportEnabled: true, confirm: { attempts: 2, delayMs: 0 } });
  const added = await call(lighterInstrument.POST, { method: 'POST', path: '/x', cookie: cookies.admin, body: { market: 'XAU' } });
  expect(added.status, JSON.stringify(added.body)).toBe(200);
  xau = added.body.instrument.id;
  await direct.db.update(schema.instruments).set({ status: 'PUBLISHED', isFixture: false }).where(eq(schema.instruments.id, xau));
  const versionId = await publishVersion({ instrumentIds: [BTC, xau] });
  const created = await call(blocks.POST, { method: 'POST', path: '/x', cookie: cookies.a, body: blockBody({ instrumentId: xau, strategyVersionId: versionId, mode: 'LIVE', leverage: 10, weekdays: ALL_DAYS }) });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  blockA = created.body.id;
}, 120_000);

afterEach(() => {
  process.env = { ...envBackup };
});

afterAll(async () => {
  installLighterTestSeam(null);
  installLiveTestSeam(null);
  setTestClock(null);
  await teardown();
});

/* ───────────────────────── 1. Connection ───────────────────────── */

describe('Lighter connection (investor-owned, verify only)', () => {
  it('a Lighter-only investor connects and verifies; the key never leaves the server; permission to trade is shown separately and is off', async () => {
    expect(await direct.db.select().from(schema.exchangeConnections).where(eq(schema.exchangeConnections.ownerId, idA))).toHaveLength(0);
    const r = await putLighter(cookies.a, {});
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.connection).toMatchObject({ exchange: 'LIGHTER', status: 'VERIFIED', positionMode: 'ONE_WAY', venue: { environment: 'MAINNET', accountIndex: 4242, apiKeyIndex: 5 }, keyFingerprint: 'API key 5', liveEnabled: false });
    expect(r.body.connection.verification).toMatchObject({ apiKey: { registered: true, keyMatch: 'MATCH' }, account: { found: true }, tradePermission: { allowed: false } });
    expect(JSON.stringify(r.body)).not.toContain(KEY);
    const row = await ltConn(idA);
    expect(row.apiKeySealed).not.toContain(KEY);
    const audits = await direct.db.select().from(schema.auditEvents).where(eq(schema.auditEvents.targetId, row.id));
    expect(JSON.stringify(audits)).not.toContain(KEY);
    const status = await liveStatusFor(idA);
    expect(status.lighter).toMatchObject({ status: 'VERIFIED' });
    expect(status.lighterTrade.allowed).toBe(false);
    expect(status.lighterTrade.reasons.join(' ')).toMatch(/disabled on this deployment \(LIGHTER_MAINNET_ORDERS/);
    expect(status.connection).toBeNull(); // no MEXC needed
  });

  it('outside the Lighter Live scope (the default) activation, approval and the Live allowlist are refused', async () => {
    const limits = { maxOrderContracts: '1', maxOrderNotionalUsdt: '500', maxLeverage: 10, maxExposureUsdt: '1000' };
    const a = await call(activate.POST, { method: 'POST', path: '/v1/me/live/activate?exchange=LIGHTER', cookie: cookies.a });
    expect(a.status).toBe(409);
    expect(a.body.message).toMatch(/LIGHTER_MAINNET_ORDERS is not enabled/);
    await expect(setLiveActivation(direct.db, idA, true, 't', 'LIGHTER')).rejects.toMatchObject({ status: 409 });
    const ap = await call(approve.POST, { method: 'POST', path: '/x', cookie: cookies.admin, params: { id: (await ltConn(idA)).id }, body: limits });
    expect(ap.status).toBe(409);
    const allow = await call(contracts.POST, { method: 'POST', path: '/x', cookie: cookies.admin, params: { id: xau }, body: { allowed: true } });
    expect(allow.status).toBe(409);
    // Orders switched on, but this connection is not listed: still refused.
    Object.assign(process.env, { LIGHTER_MAINNET_ORDERS: 'enabled', LIGHTER_LIVE_MARKETS: '92', LIGHTER_LIVE_CONNECTIONS: '00000000-0000-4000-8000-000000000000' });
    const ap2 = await call(approve.POST, { method: 'POST', path: '/x', cookie: cookies.admin, params: { id: (await ltConn(idA)).id }, body: limits });
    expect(ap2.status).toBe(409);
    expect(ap2.body.message).toMatch(/LIGHTER_LIVE_CONNECTIONS/);
    // Listed, but no capability recorded: still refused.
    process.env.LIGHTER_LIVE_CONNECTIONS = (await ltConn(idA)).id;
    const ap3 = await call(approve.POST, { method: 'POST', path: '/x', cookie: cookies.admin, params: { id: (await ltConn(idA)).id }, body: limits });
    expect(ap3.body.message).toMatch(/capability LIGHTER_SIGNER is not recorded/);
    // Another market: the allowlist refuses it.
    process.env.LIGHTER_LIVE_MARKETS = '1';
    expect((await call(contracts.POST, { method: 'POST', path: '/x', cookie: cookies.admin, params: { id: xau }, body: { allowed: true } })).body.message).toMatch(/LIGHTER_LIVE_MARKETS/);
    expect((await ltConn(idA)).approvedAt).toBeNull();
    expect((await ltConn(idA)).liveEnabled).toBe(false);
  });

  it('refuses invalid input (reserved key index, a seed phrase) without storing anything or echoing it', async () => {
    const before = await ltConn(idA);
    const seed = 'abandon ability able about above absent absorb abstract absurd abuse access accident';
    for (const body of [{ apiKeyIndex: '2' }, { apiPrivateKey: seed }, { accountIndex: 'x' }]) {
      const r = await putLighter(cookies.a, body);
      expect(r.status).toBe(400);
      expect(JSON.stringify(r.body)).not.toContain('abandon');
    }
    expect((await ltConn(idA)).revision).toBe(before.revision);
  });

  it('a wrong key, an unregistered key index and an unknown account fail the check', async () => {
    const other = mockSigner('ff'.repeat(40));
    installLighterTestSeam({ apiFor: () => ex, signerFor: () => other });
    expect((await putLighter(cookies.b, { accountIndex: '4242' })).body.connection).toMatchObject({ status: 'FAILED', verification: { apiKey: { keyMatch: 'MISMATCH' } } });
    installLighterTestSeam({ apiFor: () => ex, signerFor: () => signer });
    expect((await putLighter(cookies.b, { apiKeyIndex: '9' })).body.connection.verification.error).toMatch(/not registered/);
    expect((await putLighter(cookies.b, { accountIndex: '777' })).body.connection.verification.error).toMatch(/no account 777/);
  });

  it('one Lighter account belongs to one investor: B cannot verify A’s account, and sees only their own connection', async () => {
    const r = await putLighter(cookies.b, {});
    expect(r.body.connection).toMatchObject({ status: 'FAILED' });
    expect(r.body.connection.verification.error).toMatch(/already connected to another TrendPilot investor/);
    const g = await call(conn.GET, { path: '/x?exchange=LIGHTER', cookie: cookies.b });
    expect(g.body.connection.id).not.toBe((await ltConn(idA)).id);
    expect((await ltConn(idA)).status).toBe('VERIFIED');
    // Admin is not an investor: the investor connection API refuses.
    expect((await call(conn.GET, { path: '/x?exchange=LIGHTER', cookie: cookies.admin })).status).toBe(403);
  });

  it('production signer (pinned WASM, Step 4A): proves the registered key, refuses a mismatch; Paper work never loads it', async () => {
    // THROWAWAY test key (public test seed "ab"x32), registered only in the mocked exchange.
    const testKey = { prv: '213f363b0f4e5391fa190f50cfb616abaac317675b928f949c4c215a5718bb48c2d34d23a4f06571', pk: 'eb6764ee89c7be4545860c16cc8c47b7a55642cfa6817b7b8b99486824fc9ba13130f4147e5be3a4' };
    const exB = new MockLighter(5151, 5);
    installLighterTestSeam({ apiFor: (c) => (c.ownerId === idB ? exB : ex) }); // no signer override: the real WASM signer
    exB.registeredPublicKey = testKey.pk;
    const ok = await putLighter(cookies.b, { accountIndex: '5151', apiPrivateKey: `0x${testKey.prv}` });
    expect(ok.body.connection, JSON.stringify(ok.body)).toMatchObject({ status: 'VERIFIED', verification: { apiKey: { registered: true, keyMatch: 'MATCH' } } });
    expect(JSON.stringify(ok.body)).not.toContain(testKey.prv);
    exB.registeredPublicKey = 'ff'.repeat(40);
    const bad = await call(verify.POST, { method: 'POST', path: '/x?exchange=LIGHTER', cookie: cookies.b });
    expect(bad.body.connection).toMatchObject({ status: 'FAILED', verification: { apiKey: { keyMatch: 'MISMATCH' } } });
    // A signer that cannot run leaves the key unproven: PENDING, and Sync stays refused.
    installLighterTestSeam({ apiFor: (c) => (c.ownerId === idB ? exB : ex), signerFor: () => unavailableLighterSigner() });
    exB.registeredPublicKey = testKey.pk;
    const pend = await call(verify.POST, { method: 'POST', path: '/x?exchange=LIGHTER', cookie: cookies.b });
    expect(pend.body.connection).toMatchObject({ status: 'PENDING', verification: { apiKey: { keyMatch: 'UNPROVEN_NO_SIGNER' }, note: expect.stringMatching(/signer is not available/) } });
    expect((await call(syncRoute.POST, { method: 'POST', path: '/x?exchange=LIGHTER', cookie: cookies.b })).status).toBe(409);
    installLighterTestSeam({ apiFor: () => ex, signerFor: () => (signerEnabled ? signer : (undefined as never)) });
  });
});

/* ───────────────────────── 2. Orders ───────────────────────── */

describe('gated order adapter (mocked Lighter)', () => {
  beforeAll(async () => {
    await verifyCaps(['OPEN_WITH_ATTACHED_STOP', 'REDUCE_ONLY_CLOSE', 'STOP_RESIZE_AFTER_PARTIAL_CLOSE', 'CANCEL_STOP']);
    expect((await call(platform.POST, { method: 'POST', path: '/x', cookie: cookies.admin, body: { enabled: true, note: 'test' } })).status).toBe(200);
  });
  beforeEach(async () => {
    ex = new MockLighter();
    signer = mockSigner();
    signerEnabled = true;
    installLighterTestSeam({ apiFor: () => ex, signerFor: () => signer });
    await direct.db.delete(schema.lighterNonces);
    await direct.db.delete(schema.lighterTxs);
    await direct.db.update(schema.positions).set({ status: 'CLOSED', closedAt: clock.now }).where(and(eq(schema.positions.instrumentId, xau), eq(schema.positions.status, 'OPEN')));
    Object.assign(process.env, INPUTS);
    await openGatesForA();
    expect((await syncLighterConnection(direct.db, (await ltConn(idA)).id, clock.now)).ok).toBe(true); // USDC balance → Lighter Live account
    await quote();
  });

  it('every capability unverified: the Lighter Live scope refuses before the venue; nothing is signed or sent', async () => {
    const i = await openIntent('LONG');
    await drain(clock.now);
    expect(await intentRow(i.id)).toMatchObject({ state: 'REJECTED', stateReason: 'LIVE_REFUSED:LIGHTER_SCOPE' });
    expect(ex.sent).toHaveLength(0);
    expect(signer.signed).toBe(0);
    expect((await ltAccount(idA)).orderReserve).toBe('0.00000000');
  });

  it('unresolved live inputs and a LAST-price stop are refused before signing', async () => {
    await verifyCaps(ALL_LIGHTER);
    delete process.env.LIGHTER_TAKER_FEE_RATE;
    const i = await openIntent('LONG');
    await drain(clock.now);
    expect((await intentRow(i.id)).stateReason).toBe('LIVE_REFUSED:LIGHTER_SCOPE'); // the scope requires every input
    Object.assign(process.env, INPUTS);
    const j = await openIntent('LONG', { basis: 'LAST' });
    await drain(clock.now);
    expect((await intentRow(j.id)).stateReason).toMatch(/^STOP_BASIS_UNSUPPORTED:LAST/);
    expect(ex.sent).toHaveLength(0);
  });

  it('Lighter Live scope: the configured account can be approved and activated on the configured market; another account, market or route cannot use the path', async () => {
    await verifyCaps(ALL_LIGHTER);
    const a = await ltConn(idA);
    await direct.db.update(schema.exchangeConnections).set({ approvedAt: null, approvedBy: null, liveEnabled: false }).where(eq(schema.exchangeConnections.id, a.id));
    const limits = { maxOrderContracts: '1', maxOrderNotionalUsdt: '500', maxLeverage: 10, maxExposureUsdt: '1000' };
    expect((await call(approve.POST, { method: 'POST', path: '/x', cookie: cookies.admin, params: { id: a.id }, body: limits })).status).toBe(200);
    expect((await call(activate.POST, { method: 'POST', path: '/v1/me/live/activate?exchange=LIGHTER', cookie: cookies.a })).status).toBe(200);
    expect((await call(contracts.POST, { method: 'POST', path: '/x', cookie: cookies.admin, params: { id: xau }, body: { allowed: true } })).status).toBe(200);
    expect(await lighterLiveRefusalFor(direct.db, { ownerId: idA, instrumentId: xau }, 'SEND')).toBeNull();
    // Route scope: only listed TradingView routes may open Lighter positions.
    const route = '11111111-1111-4111-8111-111111111111';
    expect(await lighterLiveRefusalFor(direct.db, { ownerId: idA, instrumentId: xau, routeId: route }, 'ENTRY')).toMatch(/LIGHTER_LIVE_ROUTES/);
    process.env.LIGHTER_LIVE_ROUTES = route;
    expect(await lighterLiveRefusalFor(direct.db, { ownerId: idA, instrumentId: xau, routeId: route }, 'ENTRY')).toBeNull();
    expect(await lighterLiveRefusalFor(direct.db, { ownerId: idA, instrumentId: xau, routeId: '22222222-2222-4222-8222-222222222222' }, 'ENTRY')).toMatch(/LIGHTER_LIVE_ROUTES/);
    expect(await lighterLiveRefusalFor(direct.db, { ownerId: idA, instrumentId: xau, routeId: null }, 'ENTRY')).toMatch(/LIGHTER_LIVE_ROUTES/);
    // Another investor (no connection in the scope) is refused at every level.
    expect(await lighterLiveRefusalFor(direct.db, { ownerId: idB, instrumentId: xau, routeId: route }, 'ENTRY')).not.toBeNull();
    expect(await lighterLiveRefusalFor(direct.db, { ownerId: idB }, 'ACCOUNT')).not.toBeNull();
    // Another market: refused before sending, even for the configured account.
    process.env.LIGHTER_LIVE_MARKETS = '1';
    expect(await lighterLiveRefusalFor(direct.db, { ownerId: idA, instrumentId: xau }, 'SEND')).toMatch(/LIGHTER_LIVE_MARKETS/);
    const i = await openIntent('LONG');
    await drain(clock.now);
    expect(await intentRow(i.id)).toMatchObject({ state: 'REJECTED', stateReason: 'LIVE_REFUSED:LIGHTER_SCOPE' });
    expect(ex.sent).toHaveLength(0);
    // Orders switched off for the deployment: refused again.
    process.env.LIGHTER_LIVE_MARKETS = '92';
    delete process.env.LIGHTER_MAINNET_ORDERS;
    expect(await lighterLiveRefusalFor(direct.db, { ownerId: idA, instrumentId: xau }, 'SEND')).toMatch(/LIGHTER_MAINNET_ORDERS/);
  });

  it('a Lighter capability is VERIFIED only by a Lighter mainnet transaction TrendPilot recorded as EXECUTED, of the matching kind', async () => {
    const post = (capability: string, evidence: string) => call(capabilities.POST, { method: 'POST', path: '/x', cookie: cookies.admin, body: { capability, state: 'VERIFIED', evidence } });
    expect((await post('LIGHTER_OPEN_WITH_LINKED_STOP', 'operator says it works')).status).toBe(400);
    const hash = 'ab'.repeat(32);
    expect((await post('LIGHTER_OPEN_WITH_LINKED_STOP', `lighter-tx:${hash}`)).status).toBe(400); // not recorded
    const a = await ltConn(idA);
    const base = { ownerId: idA, connectionId: a.id, accountIndex: 4242, apiKeyIndex: 5, marketId: 92, txType: 28, request: {}, txHash: hash };
    await direct.db.insert(schema.lighterTxs).values({ ...base, environment: 'TESTNET', clientOrderId: 'ev-testnet', purpose: 'OPEN_WITH_STOP', clientOrderIndex: 900001, state: 'EXECUTED' });
    expect((await post('LIGHTER_OPEN_WITH_LINKED_STOP', `lighter-tx:${hash}`)).status).toBe(400); // testnet is not mainnet evidence
    const hash2 = 'cd'.repeat(32);
    await direct.db.insert(schema.lighterTxs).values({ ...base, txHash: hash2, environment: 'MAINNET', clientOrderId: 'ev-open', purpose: 'OPEN_WITH_STOP', clientOrderIndex: 900002, state: 'ACCEPTED' });
    expect((await post('LIGHTER_OPEN_WITH_LINKED_STOP', `lighter-tx:${hash2}`)).status).toBe(400); // accepted is not executed
    await direct.db.update(schema.lighterTxs).set({ state: 'EXECUTED' }).where(eq(schema.lighterTxs.txHash, hash2));
    expect((await post('LIGHTER_OPEN_WITH_LINKED_STOP', `lighter-tx:${hash2}`)).status).toBe(200);
    expect((await post('LIGHTER_REDUCE_ONLY_CLOSE', `lighter-tx:${hash2}`)).status).toBe(400); // an open is not close evidence
  });

  it.each(['LONG', 'SHORT'] as const)('%s: one linked OTO transaction; the native reduce-only stop covers the confirmed fill; fees from Lighter fills', async (side) => {
    await verifyCaps(ALL_LIGHTER);
    const i = await openIntent(side);
    await drain(clock.now);
    expect(await intentRow(i.id), JSON.stringify(await txRows())).toMatchObject({ state: 'FILLED', filledContracts: '0.010000000000' });
    const p = (await positionOf(i.id))!;
    expect(p).toMatchObject({ mode: 'LIVE', side, protectionStatus: 'PROTECTED', stopBasis: 'MARK', stopOrderRef: expect.stringMatching(/^lighter-sl:92:\d+$/) });
    expect(D(p.feesUsdt).eq(ex.takerFee)).toBe(true);
    expect(ex.sent).toHaveLength(1);
    const [g] = ex.sent as { body: { groupingType: number; orders: { IsAsk: number; ReduceOnly: number; Type: number; TriggerPrice: string }[] } }[];
    expect(g!.body.groupingType).toBe(1);
    expect(g!.body.orders.map((o) => [o.IsAsk, o.ReduceOnly, o.Type])).toEqual(side === 'LONG' ? [[0, 0, 1], [1, 1, 2]] : [[1, 0, 1], [0, 1, 2]]);
    expect(g!.body.orders[1]!.TriggerPrice).toBe(side === 'LONG' ? '230000' : '250000');
    expect((await ltAccount(idA)).orderReserve).toBe('0.00000000'); // reservation converted on fill
    expect((await txRows())[0]).toMatchObject({ state: 'EXECUTED', purpose: 'OPEN_WITH_STOP', nonce: 7 });
    expect(JSON.stringify(await txRows())).not.toContain('txInfo');
  });

  it('refuses to net or add: opposite or same-direction Lighter position, or orders resting on the market', async () => {
    await verifyCaps(ALL_LIGHTER);
    const first = await openIntent('LONG');
    await drain(clock.now);
    expect((await intentRow(first.id)).state).toBe('FILLED');
    for (const [side, re] of [['SHORT', /^NETTING_REFUSED/], ['LONG', /^POSITION_EXISTS/]] as const) {
      const i = await openIntent(side);
      await drain(clock.now);
      expect((await intentRow(i.id)).stateReason).toMatch(re);
    }
    ex.closeOnLighter(92, '0.0100'); // flat, but suppose a stale order rests on the market
    ex.orders.set(99_999, { ...ex.orders.values().next().value!, clientOrderIndex: 99_999, status: 'pending', triggerStatus: 'mark-price' });
    const k = await openIntent('LONG');
    await drain(clock.now);
    expect((await intentRow(k.id)).stateReason).toMatch(/^CONFLICTING_ORDERS/);
    expect(ex.sent).toHaveLength(1);
  });

  it('partial fill: the stop is resized to the filled size (verified ModifyOrder) and protection is verified', async () => {
    await verifyCaps(ALL_LIGHTER);
    ex.next = { fillFraction: '0.5', childKeepsParentSize: true };
    const i = await openIntent('LONG', { contracts: '0.0200' });
    await drain(clock.now);
    const p = (await positionOf(i.id))!;
    expect(p).toMatchObject({ contracts: '0.010000000000', protectionStatus: 'PROTECTED', stopContracts: '0.010000000000' });
    expect(ex.sent.map((s) => s.txType)).toEqual([28, 17]); // grouped entry, then the stop resize
  });

  it('partial fill with stop resize UNVERIFIED: coverage mismatch → entries halted and the emergency reduce-only close runs', async () => {
    await verifyCaps(ALL_LIGHTER);
    await verifyCaps(['LIGHTER_STOP_RESIZE'], 'PENDING');
    ex.next = { fillFraction: '0.5', childKeepsParentSize: true };
    const i = await openIntent('LONG', { contracts: '0.0200' });
    await drain(clock.now);
    expect((await intentRow(i.id))).toMatchObject({ state: 'FILLED', stateReason: 'PROTECTION_UNVERIFIED' });
    expect((await ltConn(idA))).toMatchObject({ entriesHalted: true, haltReason: expect.stringMatching(/^PROTECTION_FAILURE/) });
    await settle();
    const p = (await positionOf(i.id))!;
    expect(p).toMatchObject({ status: 'CLOSED', closeReason: 'PROTECTION_FAILURE' });
    expect(ex.positions.get(92)!.size.isZero()).toBe(true);
    expect(ex.sent.map((s) => s.txType)).toEqual([28, 14]); // entry, then the reduce-only close (no resize)
    const close = ex.sent[1]!.body as { ReduceOnly: number; IsAsk: number };
    expect([close.ReduceOnly, close.IsAsk]).toEqual([1, 1]);
  });

  it('an unarmed child stop is not protection (acknowledgement is not evidence): recovery runs', async () => {
    await verifyCaps(ALL_LIGHTER);
    ex.next = { childNotArmed: true };
    const i = await openIntent('SHORT');
    await drain(clock.now);
    await settle();
    expect(await intentRow(i.id)).toMatchObject({ state: 'FILLED', stateReason: 'PROTECTION_UNVERIFIED' });
    expect((await positionOf(i.id))!).toMatchObject({ status: 'CLOSED', closeReason: 'PROTECTION_FAILURE' });
    expect((await ltConn(idA)).haltReason).toMatch(/^PROTECTION_FAILURE/);
    expect(ex.positions.get(92)!.size.isZero()).toBe(true);
  });

  it('lost acknowledgement (applied at Lighter): reconciled by tx hash and nonce — one order, never re-signed with a new nonce', async () => {
    await verifyCaps(ALL_LIGHTER);
    ex.next = { timeoutAfterApply: true };
    const i = await openIntent('LONG');
    await drain(clock.now);
    expect((await intentRow(i.id)).state).toBe('SUBMITTING');
    expect((await txRows())[0]).toMatchObject({ state: 'UNKNOWN', nonce: 7 });
    expect((await ltConn(idA)).haltReason).toMatch(/^UNCERTAIN_ORDER/);
    const signedBefore = signer.signed;
    await settle();
    expect((await intentRow(i.id)).state).toBe('FILLED');
    expect(ex.sent).toHaveLength(1);
    expect(signer.signed).toBe(signedBefore); // reconciled, nothing signed again
    expect((await txRows())[0]).toMatchObject({ state: 'EXECUTED', response: { reconcile: { decision: 'EXECUTED' } } });
  });

  it('lost request (never reached Lighter) and worker restart: a NEW worker resends with the SAME nonce and client index', async () => {
    await verifyCaps(ALL_LIGHTER);
    ex.next = { timeoutBeforeApply: true };
    const i = await openIntent('LONG');
    await drain(clock.now);
    const [lost] = await txRows();
    expect(lost).toMatchObject({ state: 'UNKNOWN', nonce: 7 });
    // "Restart": a different venue instance (new lease owner) picks the intent up.
    await settle();
    expect((await intentRow(i.id)).state).toBe('FILLED');
    expect(ex.sent).toHaveLength(1);
    expect(ex.sent[0]!.nonce).toBe(7);
    const [after] = await txRows();
    expect(after).toMatchObject({ id: lost!.id, clientOrderIndex: lost!.clientOrderIndex, nonce: 7, response: { reconcile: { decision: 'RESEND_SAME_NONCE' } } });
  });

  it('nonce conflict (another client used the key): rejected without consuming, refreshed, sent once', async () => {
    await verifyCaps(ALL_LIGHTER);
    ex.next = { nonceStolen: true };
    const i = await openIntent('LONG');
    await drain(clock.now);
    expect((await intentRow(i.id)).state).toBe('FILLED');
    expect(ex.sent).toHaveLength(1);
    expect(ex.sent[0]!.nonce).toBe(8);
    expect((await direct.db.select().from(schema.lighterNonces))[0]!.nextNonce).toBe(9);
  });

  it('a definitive API rejection frees the nonce; the next order uses it', async () => {
    await verifyCaps(ALL_LIGHTER);
    ex.next = { apiError: 21_701 };
    const i = await openIntent('LONG');
    await drain(clock.now);
    expect(await intentRow(i.id)).toMatchObject({ state: 'REJECTED', stateReason: 'LIGHTER_21701' });
    const j = await openIntent('LONG');
    await drain(clock.now);
    expect((await intentRow(j.id)).state).toBe('FILLED');
    expect(ex.sent[0]!.nonce).toBe(7);
  });

  it('the nonce lease serialises workers on one API key; an expired lease of a dead worker is taken over', async () => {
    const scope = lighterScopeOf(await ltConn(idA));
    expect(await acquireLighterKeyLease(direct.db, scope, 'worker-1', 60_000)).toBe(true);
    expect(await acquireLighterKeyLease(direct.db, scope, 'worker-2', 60_000)).toBe(false);
    await direct.db.update(schema.lighterNonces).set({ leaseUntil: new Date(Date.now() - 1000) });
    expect(await acquireLighterKeyLease(direct.db, scope, 'worker-2', 60_000)).toBe(true);
    await direct.db.update(schema.lighterNonces).set({ leaseOwner: null, leaseUntil: null });
  });

  it('manual close and a concurrent exit trigger: reduce-only, capped at the confirmed position, never reversing', async () => {
    await verifyCaps(ALL_LIGHTER);
    const i = await openIntent('LONG');
    await drain(clock.now);
    const p = (await positionOf(i.id))!;
    const [inst] = await direct.db.select().from(schema.instruments).where(eq(schema.instruments.id, xau));
    const venue = lighterVenue({ db: direct.db, scope: lighterScopeOf(await ltConn(idA)), api: ex, signer, inputs: { entryWorstPricePct: '0.5', stopWorstPricePct: '2', closeWorstPricePct: '1', takerFeeRate: '0.0002' }, capabilities: Object.fromEntries(ALL_LIGHTER.map((c) => [c, 'VERIFIED'])), marketFor: async () => lighterMarketOf(inst!), confirm: { attempts: 2, delayMs: 0 } });
    const req = (id: string) => ({ paperAccountId: p.paperAccountId, clientOrderId: id, instrumentId: xau, positionSide: 'LONG' as const, contracts: '0.0100', contract: { multiplier: '1', qtyStep: '0.0001', takerFeeRate: '0' }, quote: { bid: '2399.9', ask: '2400.1', mark: '2400', last: '2400' }, now: clock.now });
    const [a, b] = await Promise.all([venue.placeReduceOnlyClose(req('manual-1')), venue.placeReduceOnlyClose(req('tp-1'))]);
    // Exactly one fill; the other is either not sent (no position left) or cancelled by Lighter's
    // reduce-only rule. The position never crosses zero.
    const filled = [a, b].filter((r) => r.status === 'FILLED');
    expect(filled).toHaveLength(1);
    expect([a, b].find((r) => r.status === 'REJECTED')).toMatchObject({ reason: expect.stringMatching(/^(REDUCE_ONLY_NO_POSITION|LIGHTER_ORDER_CANCELED-REDUCE-ONLY)$/) });
    expect(ex.positions.get(92)!.size.toFixed()).toBe('0');
    expect(ex.sent.filter((s) => s.txType === 14).every((s) => (s.body as { ReduceOnly: number }).ReduceOnly === 1)).toBe(true);
    expect(new Set(ex.sent.map((s) => s.nonce)).size).toBe(ex.sent.length); // serialised: distinct nonces, in order
  });

  it('Close on Signal / manual close through the close job: position closed from Lighter fills; the stop cannot outlive it', async () => {
    await verifyCaps(ALL_LIGHTER);
    const i = await openIntent('SHORT');
    await drain(clock.now);
    const p = (await positionOf(i.id))!;
    await direct.db.transaction((tx) => requestExit(tx, { position: p, reason: 'MANUAL_CLOSE', now: clock.now }));
    await settle();
    const closed = (await positionOf(i.id))!;
    expect(closed).toMatchObject({ status: 'CLOSED', closeReason: 'MANUAL_CLOSE', contracts: '0.000000000000' });
    expect(ex.positions.get(92)!.size.isZero()).toBe(true);
    expect(ex.stopOf(92)).toBeUndefined();
  });

  it('production wiring: without the test seam the Lighter venue is unavailable (mainnet submission disabled); the intent is rejected cleanly', async () => {
    await verifyCaps(ALL_LIGHTER);
    installLighterTestSeam(null);
    installLiveTestSeam(null);
    const i = await openIntent('LONG');
    await drain(clock.now);
    expect(await intentRow(i.id)).toMatchObject({ state: 'REJECTED', stateReason: expect.stringMatching(/^VENUE_UNAVAILABLE: .*(LIVE_ORDER_TRANSPORT|mainnet)/) });
    expect(ex.sent).toHaveLength(0);
    installLiveTestSeam({ requesterFor: () => { throw new Error('no MEXC in this test'); }, transportEnabled: true, confirm: { attempts: 2, delayMs: 0 } });
  });

  it('Paper never reaches the Lighter transport', async () => {
    const paper = await direct.db.transaction((tx) => lockPaperAccount(tx, idA, 'PAPER', 'LIGHTER'));
    const loads = lighterSignerLoads();
    const v = await resolveAccountVenue(direct.db, { mode: 'PAPER', paperAccountId: paper.id, ownerId: idA });
    expect(v.kind).toBe('PAPER_SIMULATOR');
    expect(lighterSignerLoads()).toBe(loads); // resolving a Paper venue never touches the signer
  });
});

/* ───────────────────────── 3. Reconciliation ───────────────────────── */

describe('reconciliation (manual Sync = automatic run)', () => {
  beforeEach(async () => {
    ex = new MockLighter();
    signer = mockSigner();
    installLighterTestSeam({ apiFor: () => ex, signerFor: () => signer });
    installLiveTestSeam({ requesterFor: () => { throw new Error('no MEXC in this test'); }, transportEnabled: true, confirm: { attempts: 2, delayMs: 0 } });
    await direct.db.delete(schema.lighterNonces);
    await direct.db.delete(schema.lighterTxs);
    await direct.db.update(schema.positions).set({ status: 'CLOSED', closedAt: clock.now }).where(and(eq(schema.positions.instrumentId, xau), eq(schema.positions.status, 'OPEN')));
    Object.assign(process.env, INPUTS);
    await verifyCaps(ALL_LIGHTER);
    await openGatesForA();
    await syncLighterConnection(direct.db, (await ltConn(idA)).id, clock.now);
    await quote();
  });

  const sync = () => call(syncRoute.POST, { method: 'POST', path: '/x?exchange=LIGHTER', cookie: cookies.a });

  it('the native stop fired on Lighter: its actual fill is booked once (STOP_LOSS), margin released, Holdings closed', async () => {
    const marginBefore = (await ltAccount(idA)).positionMargin;
    const i = await openIntent('LONG');
    await drain(clock.now);
    const p = (await positionOf(i.id))!;
    ex.triggerStop(Number(p.stopOrderRef!.split(':')[2]));
    const r = await sync();
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.sync).toMatchObject({ ok: true, stopFillsBooked: 1 });
    expect((await positionOf(i.id))!).toMatchObject({ status: 'CLOSED', closeReason: 'STOP_LOSS' });
    expect((await ltAccount(idA)).positionMargin).toBe(marginBefore);
    const again = await sync();
    expect(again.body.sync.stopFillsBooked).toBe(0);
    expect((await direct.db.select().from(schema.positionExits).where(eq(schema.positionExits.positionId, p.id)))).toHaveLength(1);
  });

  it('closed directly on Lighter (no fills readable): Closed with fill details pending; reservations and targets released', async () => {
    const marginBefore = (await ltAccount(idA)).positionMargin;
    const i = await openIntent('SHORT');
    await drain(clock.now);
    ex.closeOnLighter(92, '0.0100');
    const r = await sync();
    expect(r.body.sync.closedOnLighter).toEqual([expect.objectContaining({ result: 'FLAT_FILLS_PENDING' })]);
    expect((await positionOf(i.id))!).toMatchObject({ status: 'CLOSED', closeReason: 'EXTERNAL_CLOSE', exchangeCloseState: 'FILLS_PENDING' });
    expect((await ltAccount(idA)).positionMargin).toBe(marginBefore);
    expect((await ltAccount(idA)).orderReserve).toBe('0.00000000');
  });

  it('reduced on Lighter: remainder recorded, the stop resized to it, drift reported and entries halted', async () => {
    const i = await openIntent('LONG', { contracts: '0.0200' });
    await drain(clock.now);
    ex.closeOnLighter(92, '0.0080');
    const r = await sync();
    expect(r.body.sync.closedOnLighter).toEqual([expect.objectContaining({ result: 'REDUCED_FILLS_PENDING', lighterSize: '0.012' })]);
    expect(r.body.sync.protection).toEqual([expect.objectContaining({ status: 'PROTECTED' })]);
    expect((await positionOf(i.id))!).toMatchObject({ status: 'OPEN', exchangeContracts: '0.012000000000', stopContracts: '0.012000000000' });
    expect((await ltConn(idA))).toMatchObject({ entriesHalted: true, drift: [expect.objectContaining({ kind: 'SIZE_MISMATCH' })] });
  });

  it('exposure TrendPilot did not open is reported, never touched; USDC balance stays in the Lighter account', async () => {
    ex.markets.set(1, { sizeDecimals: 4, priceDecimals: 2, bid: '3000', ask: '3001', marginMode: 'CROSS', leverage: 5 });
    ex.positions.set(1, { sign: -1, size: D('0.5'), entry: D('3000') });
    ex.collateral = '1234.5';
    const r = await sync();
    expect(r.body.sync.drift).toEqual([expect.objectContaining({ kind: 'UNKNOWN_EXPOSURE' })]);
    expect(ex.sent).toHaveLength(0);
    const acct = await ltAccount(idA);
    expect(acct).toMatchObject({ currency: 'USDC', exchange: 'LIGHTER', mode: 'LIVE' });
    const usdt = await direct.db.select().from(schema.paperAccounts).where(and(eq(schema.paperAccounts.ownerId, idA), inArray(schema.paperAccounts.exchange, ['MEXC', 'BITUNIX'])));
    expect(usdt.every((a) => a.currency === 'USDT')).toBe(true);
    expect(r.body.account).toMatchObject({ currency: 'USDC', balance: { collateral: '1234.5' } });
  });

  it('rotation and disconnect cannot strand managed positions or an unconfirmed send', async () => {
    const i = await openIntent('LONG');
    await drain(clock.now);
    expect((await positionOf(i.id))!.status).toBe('OPEN');
    expect((await putLighter(cookies.a, { accountIndex: '5151' })).status).toBe(409);
    expect((await call(conn.DELETE, { method: 'DELETE', path: '/x?exchange=LIGHTER', cookie: cookies.a })).status).toBe(409);
    // Same account, another key: allowed (positions stay manageable on that account).
    ex.apiKeyIndex = 6;
    expect((await putLighter(cookies.a, { apiKeyIndex: '6' })).body.connection).toMatchObject({ status: 'VERIFIED', venue: { apiKeyIndex: 6 } });
    await direct.db.update(schema.lighterTxs).set({ state: 'UNKNOWN' });
    expect((await putLighter(cookies.a, { apiKeyIndex: '6' })).status).toBe(409);
    await direct.db.update(schema.lighterTxs).set({ state: 'EXECUTED' });
    await direct.db.update(schema.positions).set({ status: 'CLOSED', closedAt: clock.now }).where(eq(schema.positions.openIntentId, i.id));
    expect((await call(conn.DELETE, { method: 'DELETE', path: '/x?exchange=LIGHTER', cookie: cookies.a })).body.connection.status).toBe('REVOKED');
  });
});

/* ───────────────────────── 4. Scheduled reconciliation (Step 4C) ───────────────────────── */

describe('scheduled Lighter reconciliation through the worker', () => {
  const workerEnv = (extra: Record<string, string> = {}) => ({
    ...process.env,
    DATABASE_URL: process.env.DATABASE_URL!,
    LIVE_ORDER_TRANSPORT: 'disabled',
    SIGNAL_TEST_CLOCK: '',
    ALLOW_SIGNAL_TEST_CLOCK: '',
    LIVE_SYNC_MS: '3600000',
    BITUNIX_PRIVATE_SYNC: 'off',
    WORKER_POLL_MS: '3600000',
    LIGHTER_SYNC_MS: '150',
    ...extra
  });
  const until = async (f: () => Promise<boolean>, ms = 15_000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await f()) return true;
      await new Promise((r) => setTimeout(r, 100));
    }
    return false;
  };

  beforeEach(async () => {
    ex = new MockLighter();
    signer = mockSigner();
    installLighterTestSeam({ apiFor: () => ex, signerFor: () => signer });
    installLiveTestSeam({ requesterFor: () => { throw new Error('no MEXC in this test'); }, transportEnabled: true, confirm: { attempts: 2, delayMs: 0 } });
    await direct.db.delete(schema.lighterNonces);
    await direct.db.delete(schema.lighterTxs);
    await direct.db.update(schema.positions).set({ status: 'CLOSED', closedAt: clock.now }).where(and(eq(schema.positions.instrumentId, xau), eq(schema.positions.status, 'OPEN')));
    await direct.db.update(schema.exchangeConnections).set({ syncLeaseUntil: null, lastSyncError: null }).where(eq(schema.exchangeConnections.exchange, 'LIGHTER'));
    Object.assign(process.env, INPUTS);
    await verifyCaps(ALL_LIGHTER);
    // A re-verified, approved Lighter connection for A (the rotation test left it revoked).
    expect((await putLighter(cookies.a, {})).body.connection.status).toBe('VERIFIED');
    await openGatesForA();
    await syncLighterConnection(direct.db, (await ltConn(idA)).id, clock.now);
    await quote();
  });

  it('eligibility: only verified mainnet connections with Live on or managed exposure', async () => {
    const a = await ltConn(idA);
    await direct.db.update(schema.exchangeConnections).set({ liveEnabled: false, approvedAt: null, approvedBy: null }).where(eq(schema.exchangeConnections.id, a.id));
    expect(await lighterConnectionsToSync(direct.db)).not.toContain(a.id); // verified, but nothing to manage
    await openGatesForA();
    const i = await openIntent('LONG');
    await drain(clock.now);
    expect((await positionOf(i.id))!.status).toBe('OPEN');
    await direct.db.update(schema.exchangeConnections).set({ liveEnabled: false, approvedAt: null, approvedBy: null }).where(eq(schema.exchangeConnections.id, a.id));
    expect(await lighterConnectionsToSync(direct.db)).toContain(a.id); // managed exposure keeps it scheduled
    const others = await direct.db.select().from(schema.exchangeConnections).where(and(eq(schema.exchangeConnections.exchange, 'LIGHTER'), eq(schema.exchangeConnections.ownerId, idB)));
    for (const c of others) expect(await lighterConnectionsToSync(direct.db)).not.toContain(c.id); // B: not verified / no exposure
  });

  it('the normal worker entry point reconciles an exchange-side stop fill and a reduction (Holdings, fills, stop, margin)', async () => {
    const marginBefore = (await ltAccount(idA)).positionMargin;
    const i = await openIntent('LONG');
    await drain(clock.now);
    const p = (await positionOf(i.id))!;
    const logs: string[] = [];
    const w = await startWorker({ env: workerEnv(), heartbeatMs: 60_000, log: (m) => logs.push(m) });
    try {
      expect(logs.join('\n')).toMatch(/Lighter account sync: on/);
      ex.triggerStop(Number(p.stopOrderRef!.split(':')[2])); // the native stop fires on Lighter
      expect(await until(async () => (await positionOf(i.id))!.status === 'CLOSED')).toBe(true);
    } finally {
      await w.stop();
    }
    expect((await positionOf(i.id))!).toMatchObject({ status: 'CLOSED', closeReason: 'STOP_LOSS' });
    const exits = await direct.db.select().from(schema.positionExits).where(eq(schema.positionExits.positionId, p.id));
    expect(exits).toHaveLength(1);
    expect(exits[0]!.exchangeFillId).toMatch(/^lighter:4242:\d+$/);
    expect((await ltAccount(idA)).positionMargin).toBe(marginBefore);
    expect(logs.some((l) => /lighter sync .*stopFillsBooked=1/.test(l))).toBe(true);

    // A reduction made on Lighter, picked up by a restarted worker.
    const k = await openIntent('LONG', { contracts: '0.0200' });
    await drain(clock.now);
    ex.closeOnLighter(92, '0.0080');
    const w2 = await startWorker({ env: workerEnv(), heartbeatMs: 60_000, log: () => {} });
    try {
      expect(await until(async () => (await positionOf(k.id))!.exchangeCloseState === 'FILLS_PENDING')).toBe(true);
    } finally {
      await w2.stop();
    }
    expect((await positionOf(k.id))!).toMatchObject({ status: 'OPEN', exchangeContracts: '0.012000000000', stopContracts: '0.012000000000', protectionStatus: 'PROTECTED' });
    expect((await ltConn(idA)).drift).toEqual([expect.objectContaining({ kind: 'SIZE_MISMATCH' })]);
  });

  it('manual and scheduled runs never reconcile one account at once, and never book a fill twice', async () => {
    const i = await openIntent('LONG');
    await drain(clock.now);
    const p = (await positionOf(i.id))!;
    ex.triggerStop(Number(p.stopOrderRef!.split(':')[2]));
    const [manual, scheduled] = await Promise.all([call(syncRoute.POST, { method: 'POST', path: '/x?exchange=LIGHTER', cookie: cookies.a }), syncAllLighterConnections(direct.db, clock.now)]);
    const outcomes = [manual.status === 409 ? 'busy' : manual.body.sync.stopFillsBooked, ...scheduled.map((s) => (s.busy ? 'busy' : s.stopFillsBooked))];
    expect(outcomes.filter((o) => o === 1)).toHaveLength(1);
    // Duplicate runs (a duplicate stop-fill event) book nothing again.
    for (let n = 0; n < 3; n++) await syncLighterConnection(direct.db, (await ltConn(idA)).id, clock.now);
    expect(await direct.db.select().from(schema.positionExits).where(eq(schema.positionExits.positionId, p.id))).toHaveLength(1);
  });

  it('a crashed run holding the lease blocks until it expires; then the next tick proceeds (restart)', async () => {
    const a = await ltConn(idA);
    await direct.db.update(schema.exchangeConnections).set({ syncLeaseUntil: new Date(Date.now() + 60_000) }).where(eq(schema.exchangeConnections.id, a.id));
    expect((await syncAllLighterConnections(direct.db, clock.now)).find((s) => s.connectionId === a.id)).toMatchObject({ busy: true });
    await direct.db.update(schema.exchangeConnections).set({ syncLeaseUntil: new Date(Date.now() - 1000) }).where(eq(schema.exchangeConnections.id, a.id));
    expect((await syncAllLighterConnections(direct.db, clock.now)).find((s) => s.connectionId === a.id)).toMatchObject({ ok: true });
  });

  it('private API failure: recorded, nothing touched, recovered on the next run; another account is unaffected (isolation)', async () => {
    const i = await openIntent('LONG');
    await drain(clock.now);
    // B: its own verified mainnet Lighter account with Live on (fixture), served by its own mock.
    const exB = new MockLighter(5151, 5);
    exB.collateral = '777';
    installLighterTestSeam({ apiFor: (c) => (c.ownerId === idB ? exB : ex), signerFor: () => signer });
    expect((await putLighter(cookies.b, { accountIndex: '5151' })).body.connection.status).toBe('VERIFIED');
    const b = await ltConn(idB);
    await direct.db.update(schema.exchangeConnections).set({ approvedAt: new Date(), approvedBy: adminId, maxOrderContracts: '1', maxOrderNotionalUsdt: '500', maxLeverage: 10, maxExposureUsdt: '1000', liveEnabled: true }).where(eq(schema.exchangeConnections.id, b.id));
    ex.failReads = true;
    ex.closeOnLighter(92, '0.0100'); // happened on Lighter, but A's reads fail
    const out = await syncAllLighterConnections(direct.db, clock.now);
    const aId = (await ltConn(idA)).id;
    expect(out.find((s) => s.connectionId === aId)).toMatchObject({ ok: false, error: expect.stringMatching(/503/) });
    expect(out.find((s) => s.connectionId === b.id)).toMatchObject({ ok: true });
    expect((await positionOf(i.id))!.status).toBe('OPEN'); // unconfirmed: untouched
    expect((await ltConn(idA)).lastSyncError).toMatch(/503/);
    expect(((await ltConn(idB)).accountState as { balance: { collateral: string } }).balance.collateral).toBe('777');
    ex.failReads = false;
    await syncAllLighterConnections(direct.db, clock.now);
    expect((await positionOf(i.id))!).toMatchObject({ status: 'CLOSED', exchangeCloseState: 'FILLS_PENDING' });
    await direct.db.update(schema.exchangeConnections).set({ liveEnabled: false, approvedAt: null, approvedBy: null }).where(eq(schema.exchangeConnections.id, b.id));
  });

  it('a stop resize found by scheduled sync stays behind the execution gate (no request leaves; protection reported)', async () => {
    const i = await openIntent('LONG', { contracts: '0.0200' });
    await drain(clock.now);
    let posted = 0;
    const gated = new LighterHttpApi({ environment: 'MAINNET', fetch: (async () => { posted += 1; throw new Error('must not be called'); }) as typeof fetch, env: { LIVE_ORDER_TRANSPORT: 'disabled', NODE_ENV: 'test' } });
    const prodLike = Object.assign(Object.create(Object.getPrototypeOf(ex)), ex, { sendTx: (t: number, info: string) => gated.sendTx(t, info) }) as MockLighter;
    ex.closeOnLighter(92, '0.0080');
    const r = await syncLighterConnection(direct.db, (await ltConn(idA)).id, clock.now, { api: prodLike, signer });
    expect(posted).toBe(0);
    expect(r.protection).toEqual([expect.objectContaining({ status: 'UNPROTECTED' })]);
    expect(r.drift.map((d) => d.kind)).toEqual(expect.arrayContaining(['SIZE_MISMATCH', 'STOP_MISSING']));
    expect((await positionOf(i.id))!).toMatchObject({ status: 'OPEN', protectionStatus: 'UNPROTECTED' });
  });
});

/* ───────────────────────── 5. Isolated official-testnet path (Step 4C, mocked) ───────────────────────── */

describe('isolated testnet path (mocked exchange)', () => {
  const tnCatalog = (m: MockLighter) => ({
    environment: async () => m.identity(),
    markets: async () =>
      [{ marketId: 4095, symbol: 'ETH', marketType: 'perp', status: 'active', quoteAssetId: 0, sizeDecimals: 4, priceDecimals: 2, minBaseAmount: '0.005', minQuoteAmount: '10', orderQuoteLimit: null, takerFee: '0', makerFee: '0', minInitialMarginFraction: 200, defaultInitialMarginFraction: 200, maintenanceMarginFraction: 120, isFrozen: false, deployer: '', endTimestamp: 0, settlementType: 0, outcome: 0, hidden: false }]
  });
  const MAINNET_CONTRACT = '0x3B4D794a66304F130a4Db8F2551B0070dfCf5ca7';

  afterEach(() => {
    delete process.env.LIGHTER_TESTNET;
  });

  it('the testnet switch is refused in production and outside an isolated *_test database; it can never open mainnet', () => {
    expect(lighterTestnetEnabled({})).toBe(false);
    expect(() => lighterTestnetEnabled({ LIGHTER_TESTNET: 'yes' })).toThrow(/must be "enabled" or "off"/);
    expect(() => lighterTestnetEnabled({ LIGHTER_TESTNET: 'enabled', NODE_ENV: 'production', DATABASE_URL: 'postgres://u:p@h/x_test' })).toThrow(/refused in production/);
    expect(() => lighterTestnetEnabled({ LIGHTER_TESTNET: 'enabled', DATABASE_URL: 'postgres://u:p@h/trendpilot' })).toThrow(/isolated local database/);
    const tn = { LIGHTER_TESTNET: 'enabled', DATABASE_URL: 'postgres://u:p@h/trendpilot_test', NODE_ENV: 'test' };
    expect(lighterTestnetEnabled(tn)).toBe(true);
    expect(openLighterOrderTransport('TESTNET', tn)).toEqual({ granted: true });
    expect(() => openLighterOrderTransport('MAINNET', tn)).toThrow(/LIVE_ORDER_TRANSPORT|mainnet/);
    expect(() => openLighterOrderTransport('MAINNET', { ...tn, LIVE_ORDER_TRANSPORT: 'enabled' })).toThrow();
    expect(() => openLighterOrderTransport('TESTNET', { DATABASE_URL: tn.DATABASE_URL })).toThrow(/LIGHTER_TESTNET=enabled/);
  });

  it('the worker refuses to start with LIGHTER_TESTNET=enabled in production (before touching the database)', async () => {
    await expect(startWorker({ env: { LIVE_ORDER_TRANSPORT: 'disabled', NODE_ENV: 'production', LIGHTER_TESTNET: 'enabled', DATABASE_URL: 'postgres://nobody:nothing@127.0.0.1:1/none_test' }, log: () => {} })).rejects.toThrow(/refused in production/);
  });

  it('a testnet connection is refused unless the switch is on, and a mainnet API cannot pass as testnet', async () => {
    const exT = MockLighter.testnet(6161, 7);
    installLighterTestSeam({ apiFor: () => exT, signerFor: () => signer });
    expect((await putLighter(cookies.b, { environment: 'TESTNET', accountIndex: '6161', apiKeyIndex: '7' })).status).toBe(400);
    process.env.LIGHTER_TESTNET = 'enabled';
    exT.contractAddress = MAINNET_CONTRACT;
    const wrong = await putLighter(cookies.b, { environment: 'TESTNET', accountIndex: '6161', apiKeyIndex: '7' });
    expect(wrong.body.connection).toMatchObject({ status: 'FAILED', verification: { error: expect.stringMatching(/not TESTNET/) } });
  });

  it('end to end on a testnet-shaped mock: verified testnet connection, Long and Short with the linked size-0 stop, close and flat; separate from mainnet', async () => {
    process.env.LIGHTER_TESTNET = 'enabled';
    Object.assign(process.env, INPUTS);
    const exT = MockLighter.testnet(6161, 7);
    installLighterTestSeam({ apiFor: () => exT, signerFor: () => signer });
    const ledgerBefore = await direct.db.select().from(schema.paperAccounts).where(eq(schema.paperAccounts.ownerId, idB));
    const report = await runLighterTestnetCheck(
      direct.db,
      { ownerId: idB, accountIndex: 6161, apiKeyIndex: 7, apiPrivateKey: KEY, symbol: 'ETH', stopDistancePct: '5' },
      { catalog: tnCatalog(exT), sleep: async () => {}, confirm: { attempts: 2, delayMs: 0 } }
    );
    expect(report).toMatchObject({ environment: 'TESTNET', xau: 'NOT_ON_TESTNET', market: { symbol: 'ETH', marketId: 4095 }, connection: { status: 'VERIFIED', keyMatch: 'MATCH' } });
    expect(report.market.marketId).not.toBe(92);
    expect(report.steps.map((s) => [s.side, s.entry.status, s.stopAfterFill?.coversFill, s.close?.status, s.positionAfter])).toEqual([
      ['LONG', 'FILLED', true, 'FILLED', '0'],
      ['SHORT', 'FILLED', true, 'FILLED', '0']
    ]);
    // Smallest valid size: 10 USDC x 1.02 / 3000.50 -> 0.0034, below min_base 0.005 -> 0.005.
    expect(report.steps[0]!.size).toBe('0.0050');
    const grouped = exT.sent.filter((s) => s.txType === 28).map((s) => (s.body as { orders: { BaseAmount: string; ReduceOnly: number; MarketIndex: number }[] }).orders);
    expect(grouped).toHaveLength(2);
    for (const o of grouped) expect([o[1]!.BaseAmount, o[1]!.ReduceOnly, o[0]!.MarketIndex]).toEqual(['0', 1, 4095]);
    expect(JSON.stringify(report)).not.toContain(KEY);
    // Separate from mainnet: environment-keyed sends; no Live ledger row; never the Live execution path.
    const txs = await direct.db.select().from(schema.lighterTxs).where(eq(schema.lighterTxs.accountIndex, 6161));
    expect(txs.length).toBeGreaterThan(0);
    expect(txs.every((t) => t.environment === 'TESTNET')).toBe(true);
    expect(await direct.db.select().from(schema.paperAccounts).where(eq(schema.paperAccounts.ownerId, idB))).toHaveLength(ledgerBefore.length);
    const tnConn = await ltConn(idB);
    expect(tnConn.venueEnvironment).toBe('TESTNET');
    expect(await lighterConnectionsToSync(direct.db)).not.toContain(tnConn.id);
    const acct = await direct.db.transaction((tx) => lockPaperAccount(tx, idB, 'LIVE', 'LIGHTER', { lighterLiveLedger: true }));
    await expect(resolveAccountVenue(direct.db, { mode: 'LIVE', paperAccountId: acct.id, ownerId: idB })).rejects.toThrow(/testnet connection never reaches the Live execution path/);
  });

  it('refuses to run without the switch, against an API that is not testnet, or for a market testnet does not list (XAU)', async () => {
    const exT = MockLighter.testnet(6161, 7);
    const input = { ownerId: idB, accountIndex: 6161, apiKeyIndex: 7, apiPrivateKey: KEY, symbol: 'XAU', stopDistancePct: '5' };
    await expect(runLighterTestnetCheck(direct.db, input, { catalog: tnCatalog(exT) })).rejects.toThrow(/LIGHTER_TESTNET=enabled/);
    process.env.LIGHTER_TESTNET = 'enabled';
    exT.contractAddress = MAINNET_CONTRACT;
    await expect(runLighterTestnetCheck(direct.db, input, { catalog: tnCatalog(exT) })).rejects.toThrow(/not Lighter testnet/);
    exT.contractAddress = '0x5236A61b4796BF57B78328c4D752414c4b26e863';
    await expect(runLighterTestnetCheck(direct.db, input, { catalog: tnCatalog(exT) })).rejects.toThrow(/Testnet has no perp "XAU"/);
  });
});

/* ───────────────────────── 6. Release gaps checked locally (Step 5) ───────────────────────── */

describe('release gaps: stop expiry, key lifecycle, halt, Operations', () => {
  beforeEach(async () => {
    delete process.env.LIGHTER_TESTNET;
    ex = new MockLighter();
    signer = mockSigner();
    installLighterTestSeam({ apiFor: () => ex, signerFor: () => signer });
    installLiveTestSeam({ requesterFor: () => { throw new Error('no MEXC in this test'); }, transportEnabled: true, confirm: { attempts: 2, delayMs: 0 } });
    await direct.db.delete(schema.lighterNonces);
    await direct.db.delete(schema.lighterTxs);
    await direct.db.update(schema.positions).set({ status: 'CLOSED', closedAt: clock.now }).where(and(eq(schema.positions.instrumentId, xau), eq(schema.positions.status, 'OPEN')));
    await direct.db.update(schema.exchangeConnections).set({ syncLeaseUntil: null, lastSyncError: null, drift: [] }).where(eq(schema.exchangeConnections.exchange, 'LIGHTER'));
    Object.assign(process.env, INPUTS);
    await verifyCaps(ALL_LIGHTER);
    expect((await putLighter(cookies.a, {})).body.connection.status).toBe('VERIFIED');
    await openGatesForA();
    await syncLighterConnection(direct.db, (await ltConn(idA)).id, clock.now);
    await quote();
  });

  const stopOrderOf = (p: { stopOrderRef: string | null }) => ex.orders.get(Number(p.stopOrderRef!.split(':')[2]))!;

  it('a stop inside the renewal lead time is alerted (drift, entries halted); nothing is sent — renewal stays disabled even if recorded as verified', async () => {
    const i = await openIntent('LONG');
    await drain(clock.now);
    const p = (await positionOf(i.id))!;
    const sentBefore = ex.sent.length;
    // No lead configured: nothing is assumed.
    stopOrderOf(p).orderExpiryMs = Date.now() + 10 * 3600_000;
    let r = await syncLighterConnection(direct.db, (await ltConn(idA)).id, clock.now);
    expect(r.protection).toEqual([expect.objectContaining({ status: 'PROTECTED', stopExpiresAt: expect.any(String) })]);
    expect(r.drift).toEqual([]);
    // Lead 72 h (the proposal): due → alert + halt.
    process.env.LIGHTER_STOP_RENEW_LEAD_HOURS = '72';
    r = await syncLighterConnection(direct.db, (await ltConn(idA)).id, clock.now);
    expect(r.protection).toEqual([expect.objectContaining({ status: 'PROTECTED', renewal: expect.stringMatching(/STOP_EXPIRING/) })]);
    expect(r.drift).toEqual([expect.objectContaining({ kind: 'STOP_EXPIRING' })]);
    expect((await ltConn(idA))).toMatchObject({ entriesHalted: true, haltReason: expect.stringMatching(/STOP_EXPIRING/) });
    await verifyCaps(['LIGHTER_STOP_RENEW']);
    r = await syncLighterConnection(direct.db, (await ltConn(idA)).id, clock.now);
    expect(r.protection[0]!.renewal).toMatch(/not implemented in this build/);
    expect(ex.sent.length).toBe(sentBefore);
    await verifyCaps(['LIGHTER_STOP_RENEW'], 'PENDING');
    delete process.env.LIGHTER_STOP_RENEW_LEAD_HOURS;
  });

  it('an expired stop is not protection', async () => {
    const i = await openIntent('SHORT');
    await drain(clock.now);
    stopOrderOf((await positionOf(i.id))!).orderExpiryMs = Date.now() - 1000;
    const r = await syncLighterConnection(direct.db, (await ltConn(idA)).id, clock.now);
    expect(r.protection).toEqual([expect.objectContaining({ status: 'UNPROTECTED', detail: expect.stringMatching(/EXPIRED/) })]);
    expect(r.drift.map((d) => d.kind)).toContain('STOP_MISSING');
  });

  it('leaving the Lighter Live scope stops new entries only: protection, the reduce-only close and sync keep running', async () => {
    const i = await openIntent('LONG');
    await drain(clock.now);
    expect((await positionOf(i.id))!).toMatchObject({ status: 'OPEN', protectionStatus: 'PROTECTED' });
    delete process.env.LIGHTER_LIVE_CONNECTIONS; // the account leaves the scope (orders stay switched on)
    const j = await openIntent('LONG');
    await drain(clock.now);
    expect(await intentRow(j.id)).toMatchObject({ state: 'REJECTED', stateReason: 'LIVE_REFUSED:LIGHTER_SCOPE' });
    expect(await lighterConnectionsToSync(direct.db)).toContain((await ltConn(idA)).id);
    const s = await syncLighterConnection(direct.db, (await ltConn(idA)).id, clock.now);
    expect(s.ok).toBe(true);
    const p = (await positionOf(i.id))!;
    expect(s.protection.find((x) => x.positionId === p.id)?.status).toBe('PROTECTED');
    await direct.db.transaction((tx) => requestExit(tx, { position: p, reason: 'MANUAL_CLOSE', now: clock.now }));
    await drain(clock.now);
    expect((await positionOf(i.id))!.status).toBe('CLOSED');
    expect((await txRows()).filter((t) => t.purpose === 'CLOSE')).toHaveLength(1);
  });

  it('halting new entries keeps reconciliation and closes running', async () => {
    const i = await openIntent('LONG');
    await drain(clock.now);
    await direct.db.update(schema.exchangeConnections).set({ entriesHalted: true, haltReason: 'operator test', liveEnabled: false }).where(eq(schema.exchangeConnections.id, (await ltConn(idA)).id));
    expect(await lighterConnectionsToSync(direct.db)).toContain((await ltConn(idA)).id); // still scheduled (managed exposure)
    const j = await openIntent('LONG');
    await drain(clock.now);
    expect((await intentRow(j.id)).state).toBe('REJECTED'); // no new entry
    const p = (await positionOf(i.id))!;
    await direct.db.transaction((tx) => requestExit(tx, { position: p, reason: 'MANUAL_CLOSE', now: clock.now }));
    await drain(clock.now);
    expect((await positionOf(i.id))!.status).toBe('CLOSED'); // close still works
    expect((await syncLighterConnection(direct.db, (await ltConn(idA)).id, clock.now)).ok).toBe(true);
  });

  it('a failed or stale scheduled Lighter sync appears in Operations even with Live off', async () => {
    const i = await openIntent('LONG');
    await drain(clock.now);
    expect((await positionOf(i.id))!.status).toBe('OPEN');
    const a = await ltConn(idA);
    await direct.db.update(schema.exchangeConnections).set({ liveEnabled: false, lastSyncOkAt: new Date(Date.now() - 3600_000), lastSyncAt: new Date(), lastSyncError: 'GET /api/v1/account: HTTP 503' }).where(eq(schema.exchangeConnections.id, a.id));
    const ops = await getOperationsStatus(direct.db, new Date());
    const msgs = ops.alerts.map((x) => x.message).join('\n');
    expect(msgs).toMatch(/Lighter account .*: sync failed \(GET \/api\/v1\/account: HTTP 503\)/);
    expect(msgs).toMatch(/Lighter account .*: no successful sync for \d+ s/);
    expect(ops.live.connections.find((c) => c.exchange === 'LIGHTER' && c.ownerEmail === USERS.investorA.email)).toMatchObject({ scheduledSync: true });
  });

  it('key lifecycle with the REAL signer: the module binding is scrubbed after verify, sync, rotation and revoke', async () => {
    // THROWAWAY test keys (public test seeds), registered only in the mocked exchange.
    const k1 = { prv: '213f363b0f4e5391fa190f50cfb616abaac317675b928f949c4c215a5718bb48c2d34d23a4f06571', pk: 'eb6764ee89c7be4545860c16cc8c47b7a55642cfa6817b7b8b99486824fc9ba13130f4147e5be3a4' };
    const k2 = { prv: '36b47d9563c941f59823c9be0432d158021f10c719771e1edfa3df20f55c47b0dcaec80e327e3837', pk: '5a22e05737046117a760f8ba03cfb9102a22934712c58b7c82f32df5b68a7a5536cd4402e90c210f' };
    const exK = new MockLighter(8181, 9);
    exK.registeredPublicKey = k1.pk;
    installLighterTestSeam({ apiFor: (c) => (c.ownerId === idB ? exK : ex) }); // real WASM signer for B
    const v = await putLighter(cookies.b, { accountIndex: '8181', apiKeyIndex: '9', apiPrivateKey: k1.prv });
    expect(v.body.connection.status).toBe('VERIFIED');
    expect(lighterSignerBinding(8181)).toBe('SCRUBBED');
    await syncLighterConnection(direct.db, (await ltConn(idB)).id, clock.now);
    expect(lighterSignerBinding(8181)).toBe('SCRUBBED');
    // Rotation to another key of the same account.
    exK.registeredPublicKey = k2.pk;
    expect((await putLighter(cookies.b, { accountIndex: '8181', apiKeyIndex: '9', apiPrivateKey: k2.prv })).body.connection.status).toBe('VERIFIED');
    expect(lighterSignerBinding(8181)).toBe('SCRUBBED');
    expect((await call(conn.DELETE, { method: 'DELETE', path: '/x?exchange=LIGHTER', cookie: cookies.b })).body.connection.status).toBe('REVOKED');
    expect(lighterSignerBinding(8181)).toBe('SCRUBBED');
  });
});
