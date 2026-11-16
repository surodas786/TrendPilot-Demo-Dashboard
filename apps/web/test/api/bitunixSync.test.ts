// Bitunix Step 2: read-only account sync through the real routes, reconciliation engine and worker
// supervisor, against a stateful mock of the documented read endpoints. Covers both legs of one
// symbol, sub-account exclusion, incomplete snapshots, manual and partial closes made on Bitunix,
// close confirmation from history, duplicate and out-of-order pushes, pushes during a snapshot,
// reconnect gaps, a triggered TP/SL whose child order has not filled, auth failure, credential
// rotation, and isolation across investors and exchanges.
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  applyBitunixEvent,
  BitunixAccountSupervisor,
  BitunixPrivateError,
  installBitunixTestSeam,
  installLiveTestSeam,
  schema,
  syncBitunixConnection,
  type BitunixPrivateEvent,
  type BitunixPrivateStreamOptions,
  type ConnectionRow
} from '@trendpilot/db';
import * as conn from '@/app/v1/me/exchange-connection/route';
import * as syncRoute from '@/app/v1/me/exchange-connection/sync/route';
import * as adminSync from '@/app/v1/admin/live/connections/[id]/sync/route';
import * as meLive from '@/app/v1/me/live/route';
import { call, direct, resetAndSeed, signIn, teardown, userId, USERS } from '../helpers';
import { MockBitunix } from '../bitunixMock';
import { MockMexc } from '../mexcMock';

const A = USERS.investorA.email;
const B = USERS.investorB.email;
const mocks = new Map<string, MockBitunix>(); // by owner id
const mexc = new MockMexc();
let idA: string;
let idB: string;
const T0 = Date.parse('2026-11-16T10:00:00Z');

const mockOf = (ownerId: string) => {
  let m = mocks.get(ownerId);
  if (!m) mocks.set(ownerId, (m = new MockBitunix()));
  return m;
};
const bxConn = async (ownerId: string): Promise<ConnectionRow> => (await direct.db.select().from(schema.exchangeConnections).where(and(eq(schema.exchangeConnections.ownerId, ownerId), eq(schema.exchangeConnections.exchange, 'BITUNIX'))))[0]!;
const positions = async (ownerId: string) => direct.db.select().from(schema.exchangePositions).where(eq(schema.exchangePositions.ownerId, ownerId)).orderBy(schema.exchangePositions.exchangePositionId);
const pos = async (ownerId: string, pid: string) => (await positions(ownerId)).find((p) => p.exchangePositionId === pid);
const events = async (ownerId: string, kind?: string) =>
  (await direct.db.select().from(schema.exchangeAccountEvents).where(eq(schema.exchangeAccountEvents.ownerId, ownerId))).filter((e) => !kind || e.kind === kind);
const sync = async (ownerId: string) => syncBitunixConnection(direct.db, (await bxConn(ownerId)).id, mockOf(ownerId));
const push = async (ownerId: string, e: Partial<BitunixPrivateEvent> & { channel: BitunixPrivateEvent['channel'] }) =>
  applyBitunixEvent(direct.db, await bxConn(ownerId), { tsMs: null, receivedAt: new Date(), seq: 1, ...e } as BitunixPrivateEvent);

beforeAll(async () => {
  await resetAndSeed();
  idA = await userId(A);
  idB = await userId(B);
  installLiveTestSeam({ requesterFor: () => mexc });
  installBitunixTestSeam({ requesterFor: (c) => mockOf(c.ownerId) });
  mexc.positionMode = 2;
  const ca = await signIn(A);
  expect((await call(conn.PUT, { method: 'PUT', cookie: ca, body: { accountRef: 'uid-1234', apiKey: 'mexc-key-12345678', secretKey: 'mexc-secret-12345678' } })).status).toBe(200);
  expect((await call(conn.PUT, { method: 'PUT', cookie: ca, body: { exchange: 'BITUNIX', accountRef: 'bx-a', apiKey: 'bitunix-key-A-1111', secretKey: 'bitunix-secret-A' } })).body.connection.status).toBe('VERIFIED');
  expect((await call(conn.PUT, { method: 'PUT', cookie: await signIn(B), body: { exchange: 'BITUNIX', accountRef: 'bx-b', apiKey: 'bitunix-key-B-2222', secretKey: 'bitunix-secret-B' } })).body.connection.status).toBe('VERIFIED');
});
beforeEach(() => {
  for (const m of mocks.values()) {
    m.calls = [];
    m.failures.clear();
    m.beforeAnswer = null;
  }
});
afterAll(async () => {
  installBitunixTestSeam(null);
  installLiveTestSeam(null);
  await teardown();
});

describe('snapshot reconciliation', () => {
  it('mirrors the main account only, with both legs of one symbol, exact decimals and string IDs', async () => {
    const m = mockOf(idA);
    m.positions.set('1001', { positionId: '1001', symbol: 'BTCUSDT', side: 'LONG', qty: '0.0010', avgOpenPrice: '64000.5', fee: '0.0384', funding: '0', ctime: T0, mtime: T0 });
    m.positions.set('1002', { positionId: '1002', symbol: 'BTCUSDT', side: 'SHORT', qty: '0.500000000000000001', avgOpenPrice: '64100', ctime: T0, mtime: T0 });
    m.positions.set('9009', { positionId: '9009', symbol: 'ETHUSDT', side: 'LONG', qty: '5', mtime: T0, subAccountId: 7 });
    m.pendingOrders = [{ orderId: '700000000000000001', symbol: 'BTCUSDT', status: 'NEW', qty: '0.001', clientId: 'manual-1', ctime: T0, mtime: T0 }];
    const r = await call(syncRoute.POST, { method: 'POST', cookie: await signIn(A), path: '/v1/me/exchange-connection/sync?exchange=BITUNIX' });
    expect(r.status).toBe(200);
    expect(r.body.sync).toMatchObject({ ok: true, opened: 2, positionsOpen: 2, excludedSubAccountRows: 1 });
    const pendingCall = m.calls.find((c) => c.path.endsWith('get_pending_positions'))!;
    expect(pendingCall.params).toMatchObject({ includeSubAccounts: false });
    const rows = await positions(idA);
    expect(rows.map((p) => [p.exchangePositionId, p.symbol, p.side, p.qty, p.status, p.origin])).toEqual([
      ['1001', 'BTCUSDT', 'LONG', '0.001', 'OPEN', 'EXCHANGE'],
      ['1002', 'BTCUSDT', 'SHORT', '0.500000000000000001', 'OPEN', 'EXCHANGE']
    ]);
    expect(rows[0]).toMatchObject({ reportedFee: '0.0384', settledFee: null, connectionId: (await bxConn(idA)).id });
    expect(r.body.account.accountState).toMatchObject({ positionMode: 'HEDGE', balance: { available: '100', source: 'REST' }, pendingOrders: [{ orderId: '700000000000000001', origin: 'EXCHANGE' }] });
    expect(r.body.account.positions).toHaveLength(2);
    expect((await events(idA, 'POSITION_OPENED')).map((e) => e.exchangePositionId).sort()).toEqual(['1001', '1002']);
    // The MEXC connection and the Live (MEXC) account are untouched by a Bitunix sync.
    const mexcConn = (await direct.db.select().from(schema.exchangeConnections).where(and(eq(schema.exchangeConnections.ownerId, idA), eq(schema.exchangeConnections.exchange, 'MEXC'))))[0]!;
    expect(mexcConn.accountState).toEqual({});
    expect(await direct.db.select().from(schema.exchangePositions).where(eq(schema.exchangePositions.connectionId, mexcConn.id))).toHaveLength(0);
  });

  it('an incomplete or failed snapshot changes nothing and never makes a position look closed', async () => {
    const m = mockOf(idA);
    const saved = m.positions.get('1002')!;
    m.positions.delete('1002'); // would look closed…
    m.failOn('/api/v1/futures/tpsl/get_pending_orders', new BitunixPrivateError('tpsl: more than 10000 rows; the read is incomplete', 'INCOMPLETE'));
    const before = await bxConn(idA);
    const r = await sync(idA);
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/^INCOMPLETE/) });
    expect(await pos(idA, '1002')).toMatchObject({ status: 'OPEN', closeCheck: 'NONE' });
    const after = await bxConn(idA);
    expect(after.lastSyncError).toMatch(/incomplete/);
    expect(after.lastSyncOkAt).toEqual(before.lastSyncOkAt);
    m.failures.clear();
    m.failOn('/api/v1/futures/trade/get_pending_orders', new BitunixPrivateError('GET …: HTTP 502', 'HTTP', 502), true);
    expect((await sync(idA)).ok).toBe(false);
    expect(await pos(idA, '1002')).toMatchObject({ status: 'OPEN', closeCheck: 'NONE' });
    m.positions.set('1002', saved);
  });
});

describe('closes made on Bitunix', () => {
  it('a partial close is recorded with the exact remaining size (exchange-originated)', async () => {
    const m = mockOf(idA);
    m.positions.set('1002', { ...m.positions.get('1002')!, qty: '0.2', mtime: T0 + 60_000 });
    expect((await sync(idA)).reduced).toBe(1);
    expect(await pos(idA, '1002')).toMatchObject({ qty: '0.2', status: 'OPEN' });
    const [e] = await events(idA, 'POSITION_REDUCED');
    expect(e).toMatchObject({ exchangePositionId: '1002', qtyBefore: '0.500000000000000001', qtyAfter: '0.2', origin: 'EXCHANGE', source: 'REST' });
    expect(e!.detail).toMatchObject({ closedQty: '0.300000000000000001', partial: true });
  });

  it('a manual full close of the LONG leg: pending until history confirms; the SHORT leg stays open', async () => {
    const m = mockOf(idA);
    m.positions.delete('1001'); // gone from the open list, history not visible yet
    let r = await sync(idA);
    expect(r).toMatchObject({ ok: true, closed: 0, closePending: 1 });
    expect(await pos(idA, '1001')).toMatchObject({ status: 'OPEN', closeCheck: 'PENDING' });
    expect(await pos(idA, '1002')).toMatchObject({ status: 'OPEN', closeCheck: 'NONE', qty: '0.2' });
    // History now shows it: closed with Bitunix's own close price and funding; fee not reported → unknown.
    m.positions.set('1001', { positionId: '1001', symbol: 'BTCUSDT', side: 'LONG', qty: '0.001', avgOpenPrice: '64000.5', ctime: T0, mtime: T0 });
    m.closeOnExchange('1001', { closePrice: '64500.1', mtime: T0 + 120_000, fee: null, funding: '-0.0021', realizedPNL: '0.4996' });
    r = await sync(idA);
    expect(r).toMatchObject({ ok: true, closed: 1, closePending: 0, positionsOpen: 1 });
    expect(await pos(idA, '1001')).toMatchObject({ status: 'CLOSED', qty: '0', closePrice: '64500.1', settledFee: null, settledFunding: '-0.0021', settledRealizedPnl: '0.4996', lastSource: 'HISTORY' });
    expect((await pos(idA, '1001'))!.closedAt!.getTime()).toBe(T0 + 120_000);
    expect(await pos(idA, '1002')).toMatchObject({ status: 'OPEN', side: 'SHORT' });
    expect(await events(idA, 'POSITION_CLOSED')).toHaveLength(1);
    await sync(idA); // repeated reconciliation records nothing new
    expect(await events(idA, 'POSITION_CLOSED')).toHaveLength(1);
  });
});

describe('private pushes', () => {
  it('duplicates collapse and an older push never overwrites newer state', async () => {
    const newer = { channel: 'position' as const, event: 'UPDATE', positionId: '1002', symbol: 'BTCUSDT', side: 'SHORT' as const, qty: '0.15', tsMs: T0 + 300_000 };
    expect(await push(idA, newer)).toMatchObject({ applied: true, needsSync: true });
    expect(await push(idA, newer)).toMatchObject({ applied: false });
    expect(await push(idA, { ...newer, qty: '0.4', tsMs: T0 + 200_000 })).toMatchObject({ applied: false, stale: true });
    expect(await pos(idA, '1002')).toMatchObject({ qty: '0.15' });
    expect((await events(idA, 'POSITION_REDUCED')).filter((e) => e.qtyAfter === '0.15')).toHaveLength(1);
    // A REST snapshot older than the push does not roll it back either.
    expect((await sync(idA)).ok).toBe(true);
    expect(await pos(idA, '1002')).toMatchObject({ qty: '0.15' });
    // Balance: a newer push wins over the stored snapshot; an older one is ignored.
    expect(await push(idA, { channel: 'balance', coin: 'USDT', available: '99.5', frozen: '0', margin: '1', tsMs: Date.now() + 60_000 })).toMatchObject({ applied: true });
    expect(await push(idA, { channel: 'balance', coin: 'USDT', available: '1', frozen: '0', margin: '0', tsMs: Date.now() - 60_000 })).toMatchObject({ applied: false, stale: true });
    expect(((await bxConn(idA)).accountState as { balance: { available: string; source: string } }).balance).toMatchObject({ available: '99.5', source: 'WS' });
  });

  it('a position CLOSE push only marks the leg pending; the close is recorded after history confirms it', async () => {
    const m = mockOf(idA);
    expect(await push(idA, { channel: 'position', event: 'CLOSE', positionId: '1002', symbol: 'BTCUSDT', side: 'SHORT', qty: '0', tsMs: T0 + 400_000 })).toMatchObject({ needsSync: true });
    expect(await pos(idA, '1002')).toMatchObject({ status: 'OPEN', closeCheck: 'PENDING' });
    m.positions.set('1002', { ...m.positions.get('1002')!, qty: '0.15' });
    m.closeOnExchange('1002', { closePrice: '64010', mtime: T0 + 400_000, fee: '0.01', funding: null });
    expect((await sync(idA)).closed).toBe(1);
    expect(await pos(idA, '1002')).toMatchObject({ status: 'CLOSED', settledFee: '0.01', settledFunding: null });
  });

  it('tpsl CLOSE+FILLED means the child order was placed: execution waits for fills', async () => {
    const m = mockOf(idA);
    m.positions.set('2001', { positionId: '2001', symbol: 'XAUUSDT', side: 'LONG', qty: '0.010', avgOpenPrice: '3866.2', ctime: T0 + 500_000, mtime: T0 + 500_000 });
    await sync(idA);
    const trigger = { channel: 'tpsl' as const, event: 'CLOSE', status: 'FILLED', orderId: '555', positionId: '2001', symbol: 'XAUUSDT', side: 'SELL', slPrice: '3850', slQty: '0.010', tpPrice: null, tpQty: null, ctimeMs: T0 + 600_000, tsMs: T0 + 600_001 };
    expect(await push(idA, trigger)).toMatchObject({ applied: true, needsSync: true });
    expect(await push(idA, trigger)).toMatchObject({ applied: false }); // duplicate push
    const [t] = await events(idA, 'TPSL_TRIGGERED');
    expect(t!.detail).toMatchObject({ execution: 'PENDING', childOrder: expect.stringMatching(/execution not confirmed/) });
    // No fill yet, position unchanged: still pending, nothing recorded as executed.
    expect((await sync(idA)).tpslConfirmed).toBe(0);
    expect((await events(idA, 'TPSL_TRIGGERED'))[0]!.detail).toMatchObject({ execution: 'PENDING', childOrder: 'placed by Bitunix; no fill yet' });
    expect(await pos(idA, '2001')).toMatchObject({ status: 'OPEN', qty: '0.01' });
    expect(await events(idA, 'TPSL_EXECUTED')).toHaveLength(0);
    // The child order fills partly (0.004): fills + remaining size confirm it.
    m.trades.push({ tradeId: '880000000000000001', orderId: '666', positionId: '2001', symbol: 'XAUUSDT', side: 'SELL', qty: '0.004', price: '3849.9', fee: '0.0092', reduceOnly: true, ctime: Date.now() });
    m.positions.set('2001', { ...m.positions.get('2001')!, qty: '0.006', mtime: T0 + 600_500 });
    const r = await sync(idA);
    expect(r).toMatchObject({ ok: true, tpslConfirmed: 1, reduced: 1 });
    expect((await events(idA, 'TPSL_TRIGGERED'))[0]!.detail).toMatchObject({ execution: 'FILLED', filledQty: '0.004', tradeIds: ['880000000000000001'] });
    expect((await events(idA, 'TPSL_EXECUTED'))[0]).toMatchObject({ exchangePositionId: '2001', qtyAfter: '0.006', origin: 'EXCHANGE' });
    expect((await events(idA, 'FILL')).map((f) => (f.detail as { tradeId: string }).tradeId)).toContain('880000000000000001');
  });

  it('orders and fills keep their origin: TrendPilot client IDs vs exchange-originated', async () => {
    await push(idA, { channel: 'order', event: 'UPDATE', orderId: '901', clientId: 'tp-123', origin: 'TRENDPILOT', symbol: 'BTCUSDT', side: 'BUY', type: 'MARKET', status: 'FILLED', qty: '0.001', dealAmount: '0.001', averagePrice: '64000', fee: '0.03', ctimeMs: T0, mtimeMs: T0 + 1 });
    await push(idA, { channel: 'order', event: 'UPDATE', orderId: '902', clientId: null, origin: 'EXCHANGE', symbol: 'BTCUSDT', side: 'SELL', type: 'LIMIT', status: 'CANCELED', qty: '0.001', dealAmount: '0', averagePrice: null, fee: null, ctimeMs: T0, mtimeMs: T0 + 2 });
    const orders = await events(idA, 'ORDER');
    expect(orders.find((o) => o.exchangeOrderId === '901')).toMatchObject({ origin: 'TRENDPILOT', source: 'WS' });
    expect(orders.find((o) => o.exchangeOrderId === '902')).toMatchObject({ origin: 'EXCHANGE' });
  });
});

describe('worker supervisor (private WebSocket sessions)', () => {
  interface FakeStream {
    o: BitunixPrivateStreamOptions;
    state: Record<string, unknown>;
    started: boolean;
    stopped: boolean;
  }
  let streams: FakeStream[];
  const supervisor = () =>
    new BitunixAccountSupervisor(direct.db, {
      syncEveryMs: 3_600_000,
      requesterFor: (c) => mockOf(c.ownerId),
      streamFactory: (o) => {
        const f: FakeStream = { o, state: { state: 'CONNECTING', auth: 'DISCONNECTED' }, started: false, stopped: false };
        streams.push(f);
        return { start: () => void (f.started = true), stop: () => void (f.stopped = true), status: () => f.state as never };
      }
    });
  /** A session's investor, from the key it unseals (sessions start in database order). */
  const keyOf = (s: FakeStream) => s.o.credentials().apiKey;
  const live = (key: string) => streams.find((s) => !s.stopped && keyOf(s) === key)!;
  beforeEach(() => {
    streams = [];
  });

  it('one session per verified Bitunix connection; each login reconciles; pushes during the snapshot apply after it', async () => {
    const sup = supervisor();
    await sup.tick();
    expect(streams).toHaveLength(2); // A and B, one key each; MEXC is not a Bitunix session
    expect(streams.every((s) => s.started)).toBe(true);
    const cA = await bxConn(idA);
    // Each session unseals its own connection's key.
    expect(streams.map(keyOf).sort()).toEqual(['bitunix-key-A-1111', 'bitunix-key-B-2222']);
    const streamA = live('bitunix-key-A-1111');
    expect(streamA.o.credentials()).toEqual({ apiKey: 'bitunix-key-A-1111', secretKey: 'bitunix-secret-A' });
    const m = mockOf(idA);
    m.positions.set('3001', { positionId: '3001', symbol: 'BTCUSDT', side: 'LONG', qty: '0.002', ctime: Date.now(), mtime: Date.now() - 5_000 });
    // While the snapshot is being read, Bitunix pushes a newer size for 3001.
    m.beforeAnswer = (path) => {
      if (path.endsWith('get_pending_positions') && !m.calls.some((c, i) => i < m.calls.length - 1 && c.path.endsWith('get_pending_positions'))) {
        streamA.o.onEvent({ channel: 'position', event: 'UPDATE', positionId: '3001', symbol: 'BTCUSDT', side: 'LONG', qty: '0.003', tsMs: Date.now(), receivedAt: new Date(), seq: 1, positionMode: null, marginMode: null, leverage: null, margin: null, realizedPNL: null, unrealizedPNL: null, fee: null, funding: null, ctimeMs: null });
      }
    };
    streamA.state = { state: 'OPEN', auth: 'AUTHENTICATED', readyAt: new Date().toISOString() };
    streamA.o.onReady?.(new Date());
    await sup.idle();
    expect(await pos(idA, '3001')).toMatchObject({ qty: '0.003', lastSource: 'WS' }); // the push won: it is newer than the snapshot row
    expect(((await bxConn(idA)).streamState as { auth: string }).auth).toBe('AUTHENTICATED');
    expect((await bxConn(idA)).lastSyncOkAt!.getTime()).toBeGreaterThan(cA.lastSyncOkAt!.getTime());
    // Reconnect gap: the position was closed on Bitunix while disconnected; the next login reconciles it.
    m.beforeAnswer = null;
    m.positions.set('3001', { ...m.positions.get('3001')!, qty: '0.003' });
    m.closeOnExchange('3001', { closePrice: '64100', mtime: Date.now() + 1_000 });
    streamA.o.onReady?.(new Date());
    await sup.idle();
    expect(await pos(idA, '3001')).toMatchObject({ status: 'CLOSED', closePrice: '64100' });
    await sup.stop();
    expect(streams.every((s) => s.stopped)).toBe(true);
    expect(((await bxConn(idA)).streamState as { state: string }).state).toBe('STOPPED');
  });

  it('a rejected login stops that session only; a replaced key starts a new session and detaches the old mirror', async () => {
    const sup = supervisor();
    await sup.tick();
    const streamB = live('bitunix-key-B-2222');
    streamB.state = { state: 'STOPPED', auth: 'AUTH_FAILED', authError: 'invalid params，Authorize: Token invalid' };
    streamB.o.onAuthFailed?.('invalid params，Authorize: Token invalid');
    await sup.idle();
    await new Promise((r) => setTimeout(r, 20));
    expect(((await bxConn(idB)).streamState as { auth: string; authError: string }).auth).toBe('AUTH_FAILED');
    await sup.tick();
    expect(streams).toHaveLength(2); // no restart loop with the same key
    // B's mirror before rotation
    mockOf(idB).positions.set('7001', { positionId: '7001', symbol: 'XAUUSDT', side: 'SHORT', qty: '0.1', mtime: Date.now() });
    expect((await sync(idB)).opened).toBe(1);
    // B replaces the key (possibly another Bitunix account).
    expect((await call(conn.PUT, { method: 'PUT', cookie: await signIn(B), body: { exchange: 'BITUNIX', accountRef: 'bx-b2', apiKey: 'bitunix-key-B-3333', secretKey: 'bitunix-secret-B2' } })).status).toBe(200);
    expect(await pos(idB, '7001')).toMatchObject({ status: 'DETACHED', closeCheck: 'NONE' });
    await sup.tick();
    expect(streamB.stopped).toBe(true);
    expect(streams).toHaveLength(3);
    expect(live('bitunix-key-B-3333').o.credentials()).toEqual({ apiKey: 'bitunix-key-B-3333', secretKey: 'bitunix-secret-B2' });
    await sup.stop();
  });
});

describe('isolation', () => {
  it('each investor sees and syncs only their own Bitunix account', async () => {
    const vb = await call(conn.GET, { cookie: await signIn(B), path: '/v1/me/exchange-connection?exchange=BITUNIX' });
    const ids = (vb.body.account.positions as { positionId: string }[]).map((p) => p.positionId);
    expect(ids.some((i) => ['1001', '1002', '2001', '3001'].includes(i))).toBe(false);
    const live = (await call(meLive.GET, { cookie: await signIn(A) })).body;
    expect(live.connection).toMatchObject({ exchange: 'MEXC' });
    expect((live.bitunixAccount.positions as { positionId: string }[]).every((p) => !p.positionId.startsWith('7'))).toBe(true);
    const callsBefore = mockOf(idA).calls.length;
    await call(syncRoute.POST, { method: 'POST', cookie: await signIn(B), path: '/v1/me/exchange-connection/sync?exchange=BITUNIX' });
    expect(mockOf(idA).calls.length).toBe(callsBefore); // B's sync never used A's key
    expect((await call(syncRoute.POST, { method: 'POST', cookie: await signIn(A), path: '/v1/me/exchange-connection/sync?exchange=MEXC' })).status).toBe(400);
  });

  it('an administrator can run the read-only Bitunix sync for one connection', async () => {
    const admin = await signIn(USERS.admin.email);
    const r = await call(adminSync.POST, { method: 'POST', cookie: admin, params: { id: (await bxConn(idA)).id } });
    expect(r.status).toBe(200);
    expect(r.body.sync).toMatchObject({ ok: true, ownerId: idA });
  });
});
