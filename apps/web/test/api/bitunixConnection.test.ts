// Bitunix exchange connection (Step 1, read-only) through the real investor routes: a Bitunix key
// is a separate connection next to MEXC, verified with two read-only calls (position mode + USDT
// account), scoped to its investor, never applied to the Live (MEXC) account, and never approvable
// for Live in this step. Existing MEXC connections and their records are untouched.
import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { BitunixPrivateError, installBitunixTestSeam, installLiveTestSeam, schema, type BitunixRequester, type ConnectionRow } from '@trendpilot/db';
import * as conn from '@/app/v1/me/exchange-connection/route';
import * as verifyConn from '@/app/v1/me/exchange-connection/verify/route';
import * as meLive from '@/app/v1/me/live/route';
import * as approve from '@/app/v1/admin/live/connections/[id]/approve/route';
import * as adminSync from '@/app/v1/admin/live/connections/[id]/sync/route';
import * as adminLive from '@/app/v1/admin/live/route';
import { call, direct, resetAndSeed, signIn, teardown, userId, USERS } from '../helpers';
import { MockMexc } from '../mexcMock';

const A = USERS.investorA.email;
const B = USERS.investorB.email;
const KEY_A = 'bitunix-key-AAAA1111';
const KEY_B = 'bitunix-key-BBBB2222';

/** Per-key mock Bitunix account: what each investor's key would read. */
const accounts: Record<string, { mode: string; available: string } | 'SIGN_ERROR'> = {};
const seen: { key: string; path: string }[] = [];
const mexc = new MockMexc();

beforeAll(async () => {
  await resetAndSeed();
});
beforeEach(() => {
  seen.length = 0;
  accounts[KEY_A] = { mode: 'HEDGE', available: '250.5' };
  accounts[KEY_B] = { mode: 'ONE_WAY', available: '10' };
  mexc.reset();
  mexc.positionMode = 2;
  installLiveTestSeam({ requesterFor: () => mexc });
  installBitunixTestSeam({
    requesterFor: (c: ConnectionRow): BitunixRequester => {
      // The real code unseals the key; the seam identifies the investor by fingerprint.
      const key = Object.keys(accounts).find((k) => k.endsWith(c.keyFingerprint.replace(/[^A-Za-z0-9]/g, '')))!;
      return {
        async get<T>(path: string) {
          seen.push({ key, path });
          const a = accounts[key];
          if (a === 'SIGN_ERROR') throw new BitunixPrivateError('GET /api/v1/futures/account/position_mode: Signature Error (code 10007)', 'API', 10007);
          if (path.endsWith('/position_mode')) return { positionMode: a!.mode } as T;
          return [{ marginCoin: 'USDT', available: a!.available, frozen: '0', margin: '5', transfer: a!.available, positionMode: a!.mode, crossUnrealizedPNL: '0', isolationUnrealizedPNL: '0', bonus: '0' }] as T;
        }
      };
    }
  });
});
afterEach(() => {
  installBitunixTestSeam(null);
  installLiveTestSeam(null);
});
afterAll(teardown);

const rows = async (email: string) => direct.db.select().from(schema.exchangeConnections).where(eq(schema.exchangeConnections.ownerId, await userId(email)));

describe('Bitunix connection setup (read-only)', () => {
  it('a MEXC connection saved the old way (no exchange field) is unchanged when a Bitunix key is added', async () => {
    const cookie = await signIn(A);
    const m = await call(conn.PUT, { method: 'PUT', cookie, body: { accountRef: 'uid-1234', apiKey: 'mexc-key-12345678', secretKey: 'mexc-secret-12345678' } });
    expect(m.status).toBe(200);
    expect(m.body.connection).toMatchObject({ exchange: 'MEXC', status: 'VERIFIED', positionMode: 'ONE_WAY' });
    const [before] = await rows(A);

    const b = await call(conn.PUT, { method: 'PUT', path: '/v1/me/exchange-connection?exchange=BITUNIX', cookie, body: { exchange: 'BITUNIX', accountRef: 'bx-9', apiKey: KEY_A, secretKey: 'bitunix-secret-AAAA' } });
    expect(b.status).toBe(200);
    expect(b.body.connection).toMatchObject({ exchange: 'BITUNIX', status: 'VERIFIED', positionMode: 'HEDGE', keyFingerprint: '…1111', liveEnabled: false, approved: false });
    expect(b.body.connection.verification).toMatchObject({ exchange: 'BITUNIX', positionMode: 'HEDGE', positionModeRaw: 'HEDGE', usdt: { available: '250.5', equity: '255.5' } });
    expect(JSON.stringify(b.body)).not.toMatch(/bitunix-secret|apiKeySealed|secretSealed/);
    expect(seen.map((s) => s.path)).toEqual(['/api/v1/futures/account/position_mode', '/api/v1/futures/account']);

    const all = await rows(A);
    expect(all.map((r) => r.exchange).sort()).toEqual(['BITUNIX', 'MEXC']);
    const after = all.find((r) => r.exchange === 'MEXC')!;
    expect(after).toEqual(before); // byte-for-byte the same MEXC record

    // GET without an exchange still answers the MEXC connection (existing clients); ?exchange=BITUNIX the other.
    expect((await call(conn.GET, { cookie })).body.connection).toMatchObject({ exchange: 'MEXC', keyFingerprint: '…5678' });
    expect((await call(conn.GET, { cookie, path: '/v1/me/exchange-connection?exchange=BITUNIX' })).body.connection).toMatchObject({ exchange: 'BITUNIX', keyFingerprint: '…1111' });
    const live = (await call(meLive.GET, { cookie })).body;
    expect(live.connection).toMatchObject({ exchange: 'MEXC' });
    expect(live.bitunix).toMatchObject({ exchange: 'BITUNIX', positionMode: 'HEDGE' });
  });

  it('the Bitunix check never touches the Live (MEXC) account balance', async () => {
    const owner = await userId(A);
    const accts = await direct.db.select().from(schema.paperAccounts).where(and(eq(schema.paperAccounts.ownerId, owner), eq(schema.paperAccounts.mode, 'LIVE')));
    const ledger = await direct.db.select().from(schema.ledgerEntries).where(eq(schema.ledgerEntries.ownerId, owner));
    await call(verifyConn.POST, { method: 'POST', cookie: await signIn(A), path: '/v1/me/exchange-connection/verify?exchange=BITUNIX' });
    expect(await direct.db.select().from(schema.paperAccounts).where(and(eq(schema.paperAccounts.ownerId, owner), eq(schema.paperAccounts.mode, 'LIVE')))).toEqual(accts);
    expect(await direct.db.select().from(schema.ledgerEntries).where(eq(schema.ledgerEntries.ownerId, owner))).toHaveLength(ledger.length);
  });

  it('each investor sees only their own Bitunix key and results', async () => {
    const cb = await signIn(B);
    expect((await call(conn.GET, { cookie: cb, path: '/v1/me/exchange-connection?exchange=BITUNIX' })).body.connection).toBeNull();
    await call(conn.PUT, { method: 'PUT', cookie: cb, body: { exchange: 'BITUNIX', accountRef: 'bx-b', apiKey: KEY_B, secretKey: 'bitunix-secret-BBBB' } });
    const b = (await call(conn.GET, { cookie: cb, path: '/v1/me/exchange-connection?exchange=BITUNIX' })).body.connection;
    expect(b).toMatchObject({ keyFingerprint: '…2222', positionMode: 'ONE_WAY', verification: { usdt: { available: '10' } } });
    expect(seen.every((s) => s.key === KEY_B)).toBe(true);
    const a = (await call(conn.GET, { cookie: await signIn(A), path: '/v1/me/exchange-connection?exchange=BITUNIX' })).body.connection;
    expect(a).toMatchObject({ keyFingerprint: '…1111', positionMode: 'HEDGE', verification: { usdt: { available: '250.5' } } });
  });

  it('a Bitunix API error marks only that connection FAILED, with the code and no secret', async () => {
    accounts[KEY_A] = 'SIGN_ERROR';
    const cookie = await signIn(A);
    const r = await call(verifyConn.POST, { method: 'POST', cookie, body: { exchange: 'BITUNIX' } });
    expect(r.body.connection).toMatchObject({ exchange: 'BITUNIX', status: 'FAILED', positionMode: null });
    expect(r.body.connection.verification.error).toMatch(/^API 10007: .*Signature Error/);
    expect((await rows(A)).find((x) => x.exchange === 'MEXC')).toMatchObject({ status: 'VERIFIED' });
  });

  it('a Bitunix connection cannot be approved for Live or synced through the MEXC path', async () => {
    const admin = await signIn(USERS.admin.email);
    const bx = (await rows(B)).find((x) => x.exchange === 'BITUNIX')!;
    const ap = await call(approve.POST, { method: 'POST', cookie: admin, params: { id: bx.id }, body: { maxOrderContracts: '1', maxOrderNotionalUsdt: '100', maxLeverage: 5, maxExposureUsdt: '100' } });
    expect(ap.status).toBe(409);
    expect(ap.body.message ?? JSON.stringify(ap.body)).toMatch(/Bitunix/);
    // Step 2: the admin sync runs Bitunix's own READ-ONLY reconciliation, never the MEXC sync.
    // This file's seam answers only the two Step 1 endpoints, so the snapshot is reported failed.
    const sy = await call(adminSync.POST, { method: 'POST', cookie: admin, params: { id: bx.id } });
    expect(sy.status).toBe(200);
    expect(sy.body.sync).toMatchObject({ ok: false, connectionId: bx.id });
    const list = (await call(adminLive.GET, { cookie: admin })).body;
    expect(JSON.stringify(list)).not.toMatch(/sealed/i);
    expect(list.connections.filter((c: { exchange: string }) => c.exchange === 'BITUNIX')).toHaveLength(2);
  });

  it('rejects an unknown exchange, and removing the Bitunix key leaves MEXC connected', async () => {
    const cookie = await signIn(A);
    expect((await call(conn.PUT, { method: 'PUT', cookie, body: { exchange: 'BINANCE', accountRef: 'x', apiKey: 'k'.repeat(10), secretKey: 's'.repeat(10) } })).status).toBe(400);
    const d = await call(conn.DELETE, { method: 'DELETE', cookie, path: '/v1/me/exchange-connection?exchange=BITUNIX' });
    expect(d.status).toBe(200);
    expect(d.body.connection).toMatchObject({ exchange: 'BITUNIX', status: 'REVOKED' });
    const all = await rows(A);
    expect(all.find((x) => x.exchange === 'BITUNIX')).toMatchObject({ status: 'REVOKED', apiKeySealed: '', secretSealed: '' });
    expect(all.find((x) => x.exchange === 'MEXC')).toMatchObject({ status: 'VERIFIED' });
    expect((await call(conn.GET, { cookie, path: '/v1/me/exchange-connection?exchange=BITUNIX' })).body.connection).toBeNull();
  });
});
