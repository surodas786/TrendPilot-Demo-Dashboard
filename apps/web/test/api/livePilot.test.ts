// Step 12 pilot API: platform authorization (admin), explicit activation (the allowlisted investor
// only), halts, resume rules, isolation, and database constraints. Live submission stays disabled.
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema } from '@trendpilot/db';
import * as adminPilot from '@/app/v1/admin/live-pilot/route';
import * as checks from '@/app/v1/admin/live-pilot/checks/route';
import * as approve from '@/app/v1/admin/live-pilot/approve/route';
import * as halt from '@/app/v1/admin/live-pilot/halt/route';
import * as resume from '@/app/v1/admin/live-pilot/resume/route';
import * as end from '@/app/v1/admin/live-pilot/end/route';
import * as mine from '@/app/v1/me/live-pilot/route';
import * as activate from '@/app/v1/me/live-pilot/activate/route';
import * as deactivate from '@/app/v1/me/live-pilot/deactivate/route';
import * as myHalt from '@/app/v1/me/live-pilot/halt/route';
import * as blocks from '@/app/v1/me/order-blocks/route';
import { BTC, blockBody, call, direct, resetAndSeed, signIn, teardown, userId, USERS } from '../helpers';

let admin = '';
let a = '';
let b = '';
const post = (h: { POST: (r: Request) => Promise<Response> }, cookie: string, body?: unknown) => call(h.POST as never, { method: 'POST', path: '/x', cookie, body });
const LIMITS = { maxOrderContracts: '15', maxOrderNotionalUsdt: '110', maxLeverage: 5, maxExposureUsdt: '110' };

beforeAll(async () => {
  await resetAndSeed();
  admin = await signIn(USERS.admin.email);
  a = await signIn(USERS.investorA.email);
  b = await signIn(USERS.investorB.email);
  expect((await call(blocks.POST, { method: 'POST', path: '/x', cookie: a, body: blockBody({ orderCostUsdt: '20', leverage: 5 }) })).status).toBe(201);
});
afterAll(teardown);

describe('pilot definition and platform authorization', () => {
  it('only an admin defines the pilot; credentials-like references are refused', async () => {
    const body = { investorId: await userId(USERS.investorA.email), instrumentId: BTC, exchangeAccountRef: 'UID …4821', ...LIMITS };
    expect((await post(adminPilot, a, body)).status).toBe(403);
    expect((await post(adminPilot, admin, { ...body, exchangeAccountRef: 'apikey mx0-abc' })).status).toBe(400);
    expect((await post(adminPilot, admin, { ...body, maxLeverage: 50 })).status).toBe(400);
    const r = await post(adminPilot, admin, body);
    expect(r.status).toBe(201);
    expect(r.body.pilot).toMatchObject({ status: 'DRAFT', allowAdds: false, allowReversal: false });
    expect(r.body.readiness.readyForFirstTrade).toBe(false);
    expect((await post(adminPilot, admin, body)).status).toBe(409); // one open pilot at a time
  });

  it('approval is refused until every pre-pilot check is recorded as passed', async () => {
    const r = await post(approve, admin);
    expect(r.status).toBe(409);
    expect(r.body.message).toMatch(/ELIGIBILITY_CONFIRMED/);
    for (const check of ['ELIGIBILITY_CONFIRMED', 'KYC_AND_KEY_PERMISSIONS', 'READ_ONLY_CHECK', 'POSITION_MODE', 'CONTRACT_SPEC_MATCH', 'ACCOUNT_FLAT_AT_START']) {
      expect((await post(checks, admin, { check, passed: true, evidence: '' })).status).toBe(400); // evidence required
      expect((await post(checks, admin, { check, passed: true, evidence: 'TEST evidence' })).status).toBe(200);
    }
    expect((await post(approve, a)).status).toBe(403);
    expect((await post(approve, admin)).body.pilot).toMatchObject({ status: 'APPROVED' });
  });
});

describe('explicit investor activation', () => {
  it('another investor cannot see or activate the pilot', async () => {
    expect((await call(mine.GET, { path: '/x', cookie: b })).body.pilot).toBeNull();
    expect((await post(activate, b)).status).toBe(404);
    expect((await post(activate, admin)).status).toBe(403);
  });

  it('the allowlisted investor sees the offer and activates it', async () => {
    const m = (await call(mine.GET, { path: '/x', cookie: a })).body;
    expect(m.pilot).toMatchObject({ status: 'APPROVED', allowAdds: false, allowReversal: false, limits: { maxLeverage: 5 } });
    expect(m.liveOrderSubmission).toBe('disabled');
    expect((await post(activate, a)).body.status).toBe('ACTIVE');
  });

  it('activation is refused for a block with leverage above the approved maximum', async () => {
    await post(deactivate, a);
    await direct.db.update(schema.orderBlocks).set({ leverage: 10 }).where(eq(schema.orderBlocks.ownerId, await userId(USERS.investorA.email)));
    const r = await post(activate, a);
    expect(r.status).toBe(409);
    expect(r.body.message).toMatch(/leverage/);
    await direct.db.update(schema.orderBlocks).set({ leverage: 5 }).where(eq(schema.orderBlocks.ownerId, await userId(USERS.investorA.email)));
    expect((await post(activate, a)).body.status).toBe('ACTIVE');
  });
});

describe('halts and resume', () => {
  it('the investor or the operator can halt entries; only the operator resumes, with a note', async () => {
    expect((await post(myHalt, a)).body.entriesHalted).toBe(true);
    expect((await post(myHalt, b)).status).toBe(404);
    expect((await post(resume, a, { note: 'x' })).status).toBe(403);
    expect((await post(resume, admin, { note: '' })).status).toBe(400);
    expect((await post(resume, admin, { note: 'reviewed' })).body.pilot.entriesHalted).toBe(false);
    expect((await post(halt, admin, { reason: 'end of session' })).body.pilot).toMatchObject({ entriesHalted: true, haltReason: 'end of session' });
  });

  // "Resume is refused while an order is unresolved" is exercised through the real flow in pilotRehearsal.test.ts (step 6).

  it('every pilot action is audited', async () => {
    const rows = await direct.db.select({ action: schema.auditEvents.action }).from(schema.auditEvents).where(eq(schema.auditEvents.targetType, 'live_pilot'));
    expect(rows.map((x) => x.action)).toEqual(expect.arrayContaining(['ADMIN_LIVE_PILOT_CREATE', 'ADMIN_LIVE_PILOT_CHECK', 'ADMIN_LIVE_PILOT_APPROVE', 'LIVE_PILOT_ACTIVATE', 'LIVE_PILOT_DEACTIVATE', 'LIVE_PILOT_HALT', 'ADMIN_LIVE_PILOT_RESUME']));
  });
});

describe('database constraints', () => {
  it('adds and automatic reversal cannot be enabled; a second open pilot cannot exist', async () => {
    await expect(direct.db.execute(sql`UPDATE live_pilots SET allow_adds = true`)).rejects.toThrow();
    await expect(direct.db.execute(sql`UPDATE live_pilots SET allow_reversal = true`)).rejects.toThrow();
    const [p] = await direct.db.select().from(schema.livePilots);
    await expect(direct.db.insert(schema.livePilots).values({ ...p!, id: undefined as never, status: 'DRAFT' })).rejects.toThrow();
  });

  it('ending the pilot halts entries for good and frees the slot', async () => {
    const r = await post(end, admin);
    expect(r.body.pilot).toBeNull();
    const [p] = await direct.db.select().from(schema.livePilots);
    expect(p).toMatchObject({ status: 'ENDED', entriesHalted: true });
    expect((await call(mine.GET, { path: '/x', cookie: a })).body.pilot).toBeNull();
  });
});
