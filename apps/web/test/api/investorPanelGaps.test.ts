// Investor Panel gap analysis (19 Nov 2026), three issues, through the investor's own API routes
// against mocked exchanges (no real order, no real exchange call):
//   1. "Sync with <exchange>" refreshes the connection of the SELECTED exchange only, for the
//      signed-in investor only, through that exchange's own sync path (MEXC private sync, Bitunix
//      read-only mirror); Lighter and a missing connection answer with the reason.
//   2. Live eligibility is reported per exchange, connection verification separately from entry
//      permission, from the same gates order submission uses (liveEntryEligibility), with next actions.
//   3. Order blocks can be removed one by one or in bulk ("Remove unused tokens"): the preview lists
//      exactly what is removed and why others stay; the server rechecks ownership and eligibility;
//      a block with history is archived (history kept, reversible), the instrument catalog is untouched.
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { installBitunixTestSeam, installLiveSyncSeam, installLiveTestSeam, liveEntryEligibility, requestExit, schema } from '@trendpilot/db';
import * as blocks from '@/app/v1/me/order-blocks/route';
import * as blockById from '@/app/v1/me/order-blocks/[id]/route';
import * as pause from '@/app/v1/me/order-blocks/[id]/pause/route';
import * as resume from '@/app/v1/me/order-blocks/[id]/resume/route';
import * as removal from '@/app/v1/me/order-blocks/removal/route';
import * as conn from '@/app/v1/me/exchange-connection/route';
import * as meLive from '@/app/v1/me/live/route';
import * as meSync from '@/app/v1/me/live/sync/route';
import * as activate from '@/app/v1/me/live/activate/route';
import * as bitunixInstrument from '@/app/v1/admin/instruments/bitunix/route';
import * as approve from '@/app/v1/admin/live/connections/[id]/approve/route';
import * as capabilities from '@/app/v1/admin/live/capabilities/route';
import * as contracts from '@/app/v1/admin/live/contracts/[id]/route';
import * as platform from '@/app/v1/admin/live/platform/route';
import { setTestClock } from '@/server/clock';
import { BTC, blockBody, call, direct, teardown, userId, USERS } from '../helpers';
import { MockBitunixExchange } from '../bitunixOrderMock';
import { MockMexc } from '../mexcMock';
import { ALL_DAYS, clock, cookies, deliver, drain, openFromAlert, plus, publishVersion } from '../paperReplay';

const LIMITS = { maxOrderContracts: '1', maxOrderNotionalUsdt: '5000', maxLeverage: 10, maxExposureUsdt: '10000' };
const bx = Object.assign(new MockBitunixExchange(), { nowMs: () => clock.now.getTime() });
const mexc = Object.assign(new MockMexc(), { positionMode: 2 });
let idA: string;
let bxBtc: string;
let paperBlock: string;
let liveBxBlock: string;
let bxVersion: string;

const connOf = async (ownerId: string, exchange: string) => (await direct.db.select().from(schema.exchangeConnections).where(and(eq(schema.exchangeConnections.ownerId, ownerId), eq(schema.exchangeConnections.exchange, exchange))))[0];
const sync = (exchange: string | null, cookie = cookies.a) => call(meSync.POST, { method: 'POST', path: exchange ? `/v1/me/live/sync?exchange=${exchange}` : '/v1/me/live/sync', cookie });
const preview = async (cookie = cookies.a) => (await call(removal.GET, { path: '/x', cookie })).body as { removable: { id: string; symbol: string; exchange: string; mode: string; action: string }[]; excluded: { id: string; reasons: { code: string }[] }[] };
const blockRow = async (id: string) => (await direct.db.select().from(schema.orderBlocks).where(eq(schema.orderBlocks.id, id)))[0];

beforeAll(async () => {
  // A: an ACTIVE Paper BTC block with an open paper position from one shared alert.
  const out = await openFromAlert({ b: null });
  paperBlock = out.a.id;
  idA = await userId(USERS.investorA.email);
  mexc.now = () => clock.now.getTime();
  installLiveTestSeam({ requesterFor: () => mexc, bitunixRequesterFor: () => bx, transportEnabled: true, confirm: { attempts: 2, delayMs: 0 } });
  installBitunixTestSeam({ requesterFor: () => bx });
  installLiveSyncSeam(() => mexc); // the MEXC private sync reads through the mock, never the network
  const added = await call(bitunixInstrument.POST, { method: 'POST', path: '/x', cookie: cookies.admin, body: { symbol: 'BTCUSDT' } });
  bxBtc = added.body.instrument.id;
  await direct.db.update(schema.instruments).set({ status: 'PUBLISHED', isFixture: false }).where(eq(schema.instruments.id, bxBtc));
  bxVersion = await publishVersion({ instrumentIds: [BTC, bxBtc] });
  for (const c of ['OPEN_WITH_ATTACHED_STOP', 'REDUCE_ONLY_CLOSE', 'STOP_RESIZE_AFTER_PARTIAL_CLOSE', 'CANCEL_STOP', 'BITUNIX_OPEN_WITH_ATTACHED_STOP', 'BITUNIX_HEDGE_CLOSE_BY_POSITION'])
    expect((await call(capabilities.POST, { method: 'POST', path: '/x', cookie: cookies.admin, body: { capability: c, state: 'PILOT_ACCEPTED', evidence: 'test: mocked exchange' } })).status).toBe(200);
  expect((await call(platform.POST, { method: 'POST', path: '/x', cookie: cookies.admin, body: { enabled: true, note: 'test' } })).status).toBe(200);
  // A connects BOTH exchanges: MEXC (One-way) and Bitunix (Hedge). Both verified, neither approved yet.
  bx.usdt.available = '5000';
  bx.setSettings('BTCUSDT', { longLeverage: 10, shortLeverage: 10 });
  expect((await call(conn.PUT, { method: 'PUT', cookie: cookies.a, body: { accountRef: 'UID …4821', apiKey: 'mx0vglTESTKEYAAAAAAA1234', secretKey: 'TESTSECRETaaaaaaaaaaaaaaaaaaaaaa' } })).body.connection).toMatchObject({ status: 'VERIFIED' });
  expect((await call(conn.PUT, { method: 'PUT', cookie: cookies.a, body: { exchange: 'BITUNIX', accountRef: 'bx-a', apiKey: 'bitunix-key-a-1111', secretKey: 'bitunix-secret-a' } })).body.connection).toMatchObject({ status: 'VERIFIED', positionMode: 'HEDGE' });
}, 120_000);

afterAll(async () => {
  installLiveTestSeam(null);
  installBitunixTestSeam(null);
  installLiveSyncSeam(null);
  setTestClock(null);
  await teardown();
});

describe('1. My Trades sync is exchange-aware', () => {
  it('?exchange=BITUNIX syncs A’s Bitunix connection through the Bitunix path; MEXC is not called or touched', async () => {
    const mexcBefore = await connOf(idA, 'MEXC');
    mexc.calls = [];
    bx.calls = [];
    const r = await sync('BITUNIX');
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.result).toMatchObject({ exchange: 'BITUNIX', connectionId: (await connOf(idA, 'BITUNIX'))!.id, ok: true, lines: [] });
    expect(r.body.result.lastSyncOkAt).not.toBeNull();
    expect(bx.calls.length).toBeGreaterThan(0);
    expect(mexc.calls).toEqual([]);
    expect((await connOf(idA, 'MEXC'))!.lastSyncAt).toEqual(mexcBefore!.lastSyncAt);
  });

  it('?exchange=MEXC (and no parameter, for older clients) syncs MEXC only', async () => {
    const bxBefore = await connOf(idA, 'BITUNIX');
    bx.calls = [];
    for (const ex of ['MEXC', null]) {
      const r = await sync(ex);
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(r.body.result, JSON.stringify(r.body.result)).toMatchObject({ exchange: 'MEXC', connectionId: (await connOf(idA, 'MEXC'))!.id, ok: true });
      expect(r.body.sync.ownerId).toBe(idA);
    }
    expect(bx.calls).toEqual([]);
    expect((await connOf(idA, 'BITUNIX'))!.lastSyncAt).toEqual(bxBefore!.lastSyncAt);
  });

  it('an exchange without a connection, Lighter, another investor and a bad value are refused with the reason', async () => {
    const lighter = await sync('LIGHTER');
    expect(lighter.status).toBe(404);
    expect(lighter.body.message).toBe('No Lighter connection is set up.');
    const b = await sync('BITUNIX', cookies.b); // B has no Bitunix connection; A's is never used for B
    expect(b.status).toBe(404);
    expect(b.body.message).toBe('No Bitunix connection is set up.');
    expect((await sync('KRAKEN')).status).toBe(400);
    expect((await call(meSync.POST, { method: 'POST', path: '/v1/me/live/sync?exchange=BITUNIX' })).status).toBe(401);
  });
});

describe('2. Live eligibility per exchange', () => {
  const status = async () => (await call(meLive.GET, { path: '/x', cookie: cookies.a })).body;

  it('each exchange shows its own verification and its own blockers with next actions', async () => {
    const s = await status();
    const mx = s.exchanges.find((e: { exchange: string }) => e.exchange === 'MEXC');
    const bu = s.exchanges.find((e: { exchange: string }) => e.exchange === 'BITUNIX');
    expect(s.exchanges.map((e: { exchange: string }) => e.exchange)).toEqual(['MEXC', 'BITUNIX']); // Lighter not connected: not listed
    expect(mx.connection.text).toBe('Verified');
    expect(bu.connection.text).toBe('Verified');
    expect(bu.entries.allowed).toBe(false);
    expect(bu.entries.blockers.map((b: { reason: string }) => b.reason)).toEqual(['LIVE_ACCOUNT_NOT_APPROVED', 'LIVE_NOT_ACTIVATED', 'LIVE_CONTRACT_NOT_ALLOWED']);
    expect(bu.entries.blockers[0]).toEqual({ reason: 'LIVE_ACCOUNT_NOT_APPROVED', text: 'The Bitunix account has not been approved for Live trading by an administrator.', next: 'Wait for an administrator to approve your Bitunix account and set its limits.' });
    expect(JSON.stringify(bu.entries.blockers)).not.toMatch(/MEXC/);
  });

  it('Bitunix becomes allowed on its own while MEXC stays blocked, matching the order path’s eligibility', async () => {
    expect((await call(approve.POST, { method: 'POST', path: '/x', cookie: cookies.admin, params: { id: (await connOf(idA, 'BITUNIX'))!.id }, body: LIMITS })).status).toBe(200);
    expect((await call(activate.POST, { method: 'POST', path: '/v1/me/live/activate?exchange=BITUNIX', cookie: cookies.a })).status).toBe(200);
    expect((await call(contracts.POST, { method: 'POST', path: '/x', cookie: cookies.admin, params: { id: bxBtc }, body: { allowed: true } })).status).toBe(200);
    const s = await status();
    const mx = s.exchanges.find((e: { exchange: string }) => e.exchange === 'MEXC');
    const bu = s.exchanges.find((e: { exchange: string }) => e.exchange === 'BITUNIX');
    expect(bu.entries).toEqual({ allowed: true, blockers: [] });
    expect(bu.liveContracts).toEqual(['BTCUSDT']);
    expect(mx.entries.allowed).toBe(false);
    expect(mx.entries.blockers.map((b: { reason: string }) => b.reason)).toEqual(['LIVE_ACCOUNT_NOT_APPROVED', 'LIVE_NOT_ACTIVATED', 'LIVE_CONTRACT_NOT_ALLOWED']);
    // The legacy MEXC summary no longer counts the Bitunix contract as a MEXC Live contract.
    expect(s.liveContracts).toEqual([]);
    expect(s.entries.allowed).toBe(false);
    // Same verdicts as the gate an order passes at evaluation and right before submission.
    const order = { contracts: '0.001', price: '64000', leverage: 5, openContracts: '0' };
    expect((await liveEntryEligibility(direct.db, { ownerId: idA, instrumentId: bxBtc, ...order })).verdict.ok).toBe(true);
    expect((await liveEntryEligibility(direct.db, { ownerId: idA, instrumentId: BTC, ...order })).verdict.ok).toBe(false);
  });
});

describe('3. Removing unused order blocks', () => {
  it('preview: an active block with an open position is kept with both reasons; a paused unused Live block is removable (deleted)', async () => {
    const created = await call(blocks.POST, { method: 'POST', path: '/x', cookie: cookies.a, body: blockBody({ instrumentId: bxBtc, strategyVersionId: bxVersion, mode: 'LIVE', orderCostUsdt: '50', leverage: 5, weekdays: ALL_DAYS }) });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    liveBxBlock = created.body.id;
    const p = await preview();
    expect(p.removable).toEqual([{ id: liveBxBlock, symbol: 'BTCUSDT', exchange: 'BITUNIX', mode: 'LIVE', status: 'PAUSED', action: 'DELETE' }]);
    expect(p.excluded).toEqual([{ id: paperBlock, symbol: 'BTCUSDT', exchange: 'MEXC', mode: 'PAPER', status: 'ACTIVE', reasons: [expect.objectContaining({ code: 'ACTIVE' }), expect.objectContaining({ code: 'OPEN_POSITION' })] }]);
  });

  it('a paused block that still manages an open position stays: the server refuses its removal', async () => {
    const b = await blockRow(paperBlock);
    expect((await call(pause.POST, { method: 'POST', path: '/x', cookie: cookies.a, params: { id: paperBlock }, ifMatch: b!.revision })).status).toBe(200);
    expect((await preview()).excluded.find((x) => x.id === paperBlock)!.reasons.map((r) => r.code)).toEqual(['OPEN_POSITION']);
    const r = await call(blockById.DELETE, { method: 'DELETE', path: '/x', cookie: cookies.a, params: { id: paperBlock } });
    expect(r.status).toBe(409);
    expect(r.body.message).toMatch(/^BTCUSDT is kept: 1 open position\(s\) are managed by it/);
    expect((await blockRow(paperBlock))!.archivedAt).toBeNull();
  });

  it('the server rechecks at apply time: a block resumed after the preview is kept', async () => {
    const b = await blockRow(liveBxBlock);
    expect((await call(resume.POST, { method: 'POST', path: '/x', cookie: cookies.a, params: { id: liveBxBlock }, ifMatch: b!.revision })).status).toBe(200);
    const r = await call(removal.POST, { method: 'POST', path: '/x', cookie: cookies.a, body: { ids: [liveBxBlock] } });
    expect(r.status).toBe(200);
    expect(r.body.removed).toEqual([]);
    expect(r.body.kept).toEqual([{ id: liveBxBlock, symbol: 'BTCUSDT', reasons: [expect.objectContaining({ code: 'ACTIVE' })] }]);
    const again = await blockRow(liveBxBlock);
    expect((await call(pause.POST, { method: 'POST', path: '/x', cookie: cookies.a, params: { id: liveBxBlock }, ifMatch: again!.revision })).status).toBe(200);
  });

  it('another investor cannot remove or even see A’s blocks', async () => {
    expect((await call(blockById.DELETE, { method: 'DELETE', path: '/x', cookie: cookies.b, params: { id: liveBxBlock } })).status).toBe(404);
    const r = await call(removal.POST, { method: 'POST', path: '/x', cookie: cookies.b, body: { ids: [liveBxBlock, paperBlock] } });
    expect(r.body).toEqual({ removed: [], kept: [{ id: liveBxBlock, symbol: null, reasons: [] }, { id: paperBlock, symbol: null, reasons: [] }] });
    expect(await preview(cookies.b)).toEqual({ removable: [], excluded: [] });
    expect(await blockRow(liveBxBlock)).toBeDefined();
  });

  it('bulk "Remove unused": after the position is closed, the history block is archived and the unused one deleted; history and the catalog stay', async () => {
    const [pos] = await direct.db.select().from(schema.positions).where(and(eq(schema.positions.orderBlockId, paperBlock), eq(schema.positions.status, 'OPEN')));
    await direct.db.transaction((tx) => requestExit(tx, { position: pos!, reason: 'MANUAL_CLOSE', now: clock.now }));
    await drain(clock.now);
    expect((await direct.db.select().from(schema.positions).where(eq(schema.positions.id, pos!.id)))[0]!.status).toBe('CLOSED');

    const p = await preview();
    expect(p.excluded).toEqual([]);
    expect(p.removable.map((x) => [x.id, x.action]).sort()).toEqual([
      [liveBxBlock, 'DELETE'],
      [paperBlock, 'ARCHIVE']
    ].sort());
    const decisionsBefore = await direct.db.select().from(schema.signalDecisions).where(eq(schema.signalDecisions.orderBlockId, paperBlock));
    expect(decisionsBefore.length).toBeGreaterThan(0);

    const r = await call(removal.POST, { method: 'POST', path: '/x', cookie: cookies.a, body: { ids: p.removable.map((x) => x.id) } });
    expect(r.status).toBe(200);
    expect(r.body.kept).toEqual([]);
    expect(r.body.removed.map((x: { id: string; result: string }) => [x.id, x.result]).sort()).toEqual([
      [liveBxBlock, 'DELETED'],
      [paperBlock, 'ARCHIVED']
    ].sort());
    expect(await blockRow(liveBxBlock)).toBeUndefined();
    expect((await blockRow(paperBlock))!.archivedAt).not.toBeNull();
    // History is intact and the shared instruments remain.
    expect(await direct.db.select().from(schema.signalDecisions).where(eq(schema.signalDecisions.orderBlockId, paperBlock))).toHaveLength(decisionsBefore.length);
    expect(await direct.db.select().from(schema.positions).where(eq(schema.positions.orderBlockId, paperBlock))).toHaveLength(1);
    expect(await direct.db.select().from(schema.instruments).where(eq(schema.instruments.id, bxBtc))).toHaveLength(1);
    expect(await direct.db.select().from(schema.instruments).where(eq(schema.instruments.id, BTC))).toHaveLength(1);
    // Trade Settings no longer lists them; the archived block cannot be edited or resumed.
    expect((await call(blocks.GET, { path: '/x', cookie: cookies.a })).body.items ?? (await call(blocks.GET, { path: '/x', cookie: cookies.a })).body).toEqual([]);
    expect((await call(blockById.GET, { path: '/x', cookie: cookies.a, params: { id: paperBlock } })).status).toBe(404);
    expect((await call(resume.POST, { method: 'POST', path: '/x', cookie: cookies.a, params: { id: paperBlock }, ifMatch: 99 })).status).toBe(404);
  });

  it('the pair can be set up again, and an archived block never receives a new signal', async () => {
    const created = await call(blocks.POST, { method: 'POST', path: '/x', cookie: cookies.a, body: blockBody({ weekdays: ALL_DAYS, orderCostUsdt: '100', leverage: 10 }) });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const bar = new Date('2026-11-08T09:30:00Z');
    clock.now = plus(new Date(bar.getTime() + 15 * 60_000), 3);
    setTestClock(() => clock.now);
    expect(await deliver('BEARISH_FLIP', bar, '65000.5')).toBe(202);
    await drain(clock.now);
    const [ev] = await direct.db.select().from(schema.signalEvents).where(eq(schema.signalEvents.barOpenAt, bar));
    const decided = await direct.db.select({ block: schema.signalDecisions.orderBlockId }).from(schema.signalDecisions).where(eq(schema.signalDecisions.eventId, ev!.id));
    expect(decided.map((d) => d.block)).toContain(created.body.id);
    expect(decided.map((d) => d.block)).not.toContain(paperBlock);
  });
});
