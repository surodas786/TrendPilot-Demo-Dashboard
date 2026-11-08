// IAM-01 / AT-02: invitations, password reset, MFA, session revocation, suspension.
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashToken, schema } from '@trendpilot/db';
import * as users from '@/app/v1/admin/users/route';
import * as resend from '@/app/v1/admin/users/[id]/resend-invite/route';
import * as suspend from '@/app/v1/admin/users/[id]/suspend/route';
import * as reactivate from '@/app/v1/admin/users/[id]/reactivate/route';
import * as adminReset from '@/app/v1/admin/users/[id]/reset-password/route';
import * as adminRevoke from '@/app/v1/admin/users/[id]/revoke-sessions/route';
import * as inviteCheck from '@/app/v1/auth/invite/check/route';
import * as inviteAccept from '@/app/v1/auth/invite/accept/route';
import * as forgot from '@/app/v1/auth/password/forgot/route';
import * as resetCheck from '@/app/v1/auth/password/check/route';
import * as reset from '@/app/v1/auth/password/reset/route';
import * as login from '@/app/v1/auth/login/route';
import * as mfa from '@/app/v1/auth/mfa/route';
import * as mfaSetup from '@/app/v1/me/mfa/setup/route';
import * as mfaEnable from '@/app/v1/me/mfa/enable/route';
import * as mfaDisable from '@/app/v1/me/mfa/disable/route';
import * as sessions from '@/app/v1/me/sessions/route';
import * as sessionRevoke from '@/app/v1/me/sessions/[id]/revoke/route';
import * as revokeOthers from '@/app/v1/me/sessions/revoke-others/route';
import * as me from '@/app/v1/me/route';
import { call, direct, latestLinkToken, resetAndSeed, signIn, teardown, totpNow, userId, USERS } from '../helpers';

const NEW = { name: 'Farhan Ahmed', email: 'farhan@trendpilot.local' };
const NEW_PASSWORD = 'Farhan-first-pass-1';
let admin: string;
let newId: string;

const post = (h: any, path: string, o: Record<string, unknown> = {}) => call(h.POST, { method: 'POST', path, ...o });
const userRow = async (id: string) => (await direct.db.select().from(schema.users).where(eq(schema.users.id, id)))[0]!;

beforeAll(async () => {
  await resetAndSeed();
  admin = await signIn(USERS.admin.email);
});
afterAll(teardown);

describe('invitation (expiring, single-use, hashed)', () => {
  it('admin creates an INVITED investor and the invite is captured locally', async () => {
    const r = await post(users, '/v1/admin/users', { cookie: admin, body: NEW });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ email: NEW.email, role: 'INVESTOR', status: 'INVITED', mfaEnabled: false });
    newId = r.body.id;
    const token = await latestLinkToken(NEW.email, 'INVITE');
    const stored = await direct.db.select().from(schema.userTokens).where(eq(schema.userTokens.userId, newId));
    expect(stored).toHaveLength(1);
    expect(stored[0]!.tokenHash).toBe(hashToken(token));
    expect(JSON.stringify(stored)).not.toContain(token);
    expect(stored[0]!.expiresAt.getTime() - Date.now()).toBeGreaterThan(71 * 3_600_000);
  });

  it('duplicate email is 409; invalid email is 400', async () => {
    expect((await post(users, '/v1/admin/users', { cookie: admin, body: NEW })).status).toBe(409);
    expect((await post(users, '/v1/admin/users', { cookie: admin, body: { name: 'X Y', email: 'not-an-email' } })).status).toBe(400);
  });

  it('an invited user cannot sign in before accepting', async () => {
    const r = await post(login, '/v1/auth/login', { body: { email: NEW.email, password: NEW_PASSWORD } });
    expect(r.status).toBe(401);
  });

  it('resending supersedes the previous link', async () => {
    const first = await latestLinkToken(NEW.email, 'INVITE');
    expect((await post(resend, '', { cookie: admin, params: { id: newId } })).status).toBe(204);
    const second = await latestLinkToken(NEW.email, 'INVITE');
    expect(second).not.toBe(first);
    expect((await post(inviteCheck, '/v1/auth/invite/check', { body: { token: first } })).body.code).toBe('LINK_INVALID');
    expect((await post(inviteCheck, '/v1/auth/invite/check', { body: { token: second } })).body).toMatchObject({ name: NEW.name, email: NEW.email });
  });

  it('weak passwords are rejected; the link works exactly once', async () => {
    const token = await latestLinkToken(NEW.email, 'INVITE');
    expect((await post(inviteAccept, '/v1/auth/invite/accept', { body: { token, password: 'short' } })).status).toBe(400);
    expect((await post(inviteAccept, '/v1/auth/invite/accept', { body: { token, password: NEW_PASSWORD } })).status).toBe(204);
    const again = await post(inviteAccept, '/v1/auth/invite/accept', { body: { token, password: 'Another-pass-123' } });
    expect(again.status).toBe(400);
    expect(again.body.code).toBe('LINK_INVALID');
    expect((await userRow(newId)).status).toBe('ACTIVE');
    const s = await signIn(NEW.email, NEW_PASSWORD);
    expect((await call(me.GET, { path: '/v1/me', cookie: s })).body.user.email).toBe(NEW.email);
  });

  it('an expired link is rejected', async () => {
    const r = await post(users, '/v1/admin/users', { cookie: admin, body: { name: 'Expired Person', email: 'expired@trendpilot.local' } });
    const token = await latestLinkToken('expired@trendpilot.local', 'INVITE');
    await direct.db.update(schema.userTokens).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(schema.userTokens.userId, r.body.id));
    const res = await post(inviteAccept, '/v1/auth/invite/accept', { body: { token, password: NEW_PASSWORD } });
    expect(res.body.code).toBe('LINK_INVALID');
  });
});

describe('password reset (self-service and admin-initiated)', () => {
  it('unknown emails get the same 202 and no email is sent', async () => {
    const before = (await direct.db.select().from(schema.emailOutbox)).length;
    const r = await post(forgot, '/v1/auth/password/forgot', { body: { email: 'nobody@trendpilot.local' } });
    expect(r.status).toBe(202);
    expect((await direct.db.select().from(schema.emailOutbox)).length).toBe(before);
  });

  it('a reset link works once, sets the password and revokes every session', async () => {
    const oldSession = await signIn(NEW.email, NEW_PASSWORD);
    const r = await post(forgot, '/v1/auth/password/forgot', { body: { email: NEW.email } });
    expect(r.status).toBe(202);
    const token = await latestLinkToken(NEW.email, 'RESET');
    expect((await post(resetCheck, '/v1/auth/password/check', { body: { token } })).status).toBe(200);
    expect((await post(reset, '/v1/auth/password/reset', { body: { token, password: 'Farhan-second-pass-2' } })).status).toBe(204);
    expect((await post(reset, '/v1/auth/password/reset', { body: { token, password: 'Farhan-third-pass-3' } })).body.code).toBe('LINK_INVALID');
    expect((await call(me.GET, { path: '/v1/me', cookie: oldSession })).status).toBe(401);
    expect((await post(login, '/v1/auth/login', { body: { email: NEW.email, password: NEW_PASSWORD } })).status).toBe(401);
    await signIn(NEW.email, 'Farhan-second-pass-2');
  });

  it('reset links expire after 30 minutes', async () => {
    await post(forgot, '/v1/auth/password/forgot', { body: { email: NEW.email } });
    const rows = await direct.db.select().from(schema.userTokens).where(eq(schema.userTokens.userId, newId));
    const latest = rows.filter((x) => x.kind === 'RESET').sort((a, b) => +b.createdAt - +a.createdAt)[0]!;
    const ttlMin = (latest.expiresAt.getTime() - latest.createdAt.getTime()) / 60_000;
    expect(ttlMin).toBeGreaterThan(29);
    expect(ttlMin).toBeLessThanOrEqual(30.1);
  });

  it('an admin can send an authorized reset to an investor', async () => {
    const r = await post(adminReset, '', { cookie: admin, params: { id: newId } });
    expect(r.status).toBe(204);
    expect(await latestLinkToken(NEW.email, 'RESET')).toBeTruthy();
  });
});

describe('MFA (TOTP)', () => {
  let secret: string;
  let a: string;

  it('enrolment needs a valid code before it turns on', async () => {
    a = await signIn(USERS.investorA.email);
    const setup = await post(mfaSetup, '/v1/me/mfa/setup', { cookie: a });
    expect(setup.status).toBe(200);
    secret = setup.body.secret;
    expect(setup.body.otpauthUri).toMatch(/^otpauth:\/\/totp\//);
    const row = await userRow(await userId(USERS.investorA.email));
    expect(row.mfaPendingSecretEnc).toBeTruthy();
    expect(row.mfaPendingSecretEnc).not.toContain(secret);
    expect((await post(mfaEnable, '/v1/me/mfa/enable', { cookie: a, body: { code: '000000' } })).status).toBe(400);
    expect((await post(mfaEnable, '/v1/me/mfa/enable', { cookie: a, body: { code: totpNow(secret) } })).status).toBe(204);
    expect((await call(me.GET, { path: '/v1/me', cookie: a })).body.user.mfaEnabled).toBe(true);
  });

  it('password alone yields a pending session that cannot use the API', async () => {
    const r = await post(login, '/v1/auth/login', { body: { email: USERS.investorA.email, password: process.env.SEED_PASSWORD } });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ mfaRequired: true });
    const pending = r.headers.get('set-cookie')!.split(';')[0]!;
    expect((await call(me.GET, { path: '/v1/me', cookie: pending })).status).toBe(401);

    expect((await post(mfa, '/v1/auth/mfa', { cookie: pending, body: { code: '123456' } })).status).toBe(400);
    const ok = await post(mfa, '/v1/auth/mfa', { cookie: pending, body: { code: totpNow(secret, 1) } });
    expect(ok.status).toBe(200);
    const full = ok.headers.get('set-cookie')!.split(';')[0]!;
    expect((await call(me.GET, { path: '/v1/me', cookie: full })).status).toBe(200);
    // The pending session was rotated away.
    expect((await post(mfa, '/v1/auth/mfa', { cookie: pending, body: { code: totpNow(secret, 1) } })).status).toBe(401);
  });

  it('a code cannot be replayed', async () => {
    const r = await post(login, '/v1/auth/login', { body: { email: USERS.investorA.email, password: process.env.SEED_PASSWORD } });
    const pending = r.headers.get('set-cookie')!.split(';')[0]!;
    // Step +1 was used above; it and every earlier step are now rejected.
    expect((await post(mfa, '/v1/auth/mfa', { cookie: pending, body: { code: totpNow(secret, 1) } })).status).toBe(400);
    expect((await post(mfa, '/v1/auth/mfa', { cookie: pending, body: { code: totpNow(secret, 0) } })).status).toBe(400);
  });

  it('turning MFA off needs a fresh code', async () => {
    // Steps up to +1 are used; no unused valid step remains in the ±1 window until time moves on.
    expect((await post(mfaDisable, '/v1/me/mfa/disable', { cookie: a, body: { code: totpNow(secret, 0) } })).status).toBe(400);
    await direct.db.update(schema.users).set({ mfaLastStep: null }).where(eq(schema.users.email, USERS.investorA.email));
    expect((await post(mfaDisable, '/v1/me/mfa/disable', { cookie: a, body: { code: totpNow(secret) } })).status).toBe(204);
    expect((await call(me.GET, { path: '/v1/me', cookie: a })).body.user.mfaEnabled).toBe(false);
  });
});

describe('session revocation', () => {
  it('lists only my sessions and revokes one by ID; other users\' IDs are 404', async () => {
    const b1 = await signIn(USERS.investorB.email);
    const b2 = await signIn(USERS.investorB.email);
    const list = await call(sessions.GET, { path: '/v1/me/sessions', cookie: b1 });
    expect(list.body.items.length).toBeGreaterThanOrEqual(2);
    expect(list.body.items.filter((s: any) => s.current)).toHaveLength(1);
    const other = list.body.items.find((s: any) => !s.current);

    const a = await signIn(USERS.investorA.email);
    expect((await post(sessionRevoke, '', { cookie: a, params: { id: other.id } })).status).toBe(404);

    expect((await post(sessionRevoke, '', { cookie: b1, params: { id: other.id } })).status).toBe(204);
    const stillWorks = [await call(me.GET, { path: '/v1/me', cookie: b1 }), await call(me.GET, { path: '/v1/me', cookie: b2 })].map((r) => r.status);
    expect(stillWorks.sort()).toEqual([200, 401]);
  });

  it('"sign out other sessions" keeps only the current one', async () => {
    const keep = await signIn(USERS.investorB.email);
    const drop = await signIn(USERS.investorB.email);
    const r = await post(revokeOthers, '/v1/me/sessions/revoke-others', { cookie: keep });
    expect(r.body.revoked).toBeGreaterThanOrEqual(1);
    expect((await call(me.GET, { path: '/v1/me', cookie: keep })).status).toBe(200);
    expect((await call(me.GET, { path: '/v1/me', cookie: drop })).status).toBe(401);
  });

  it('an admin can revoke all of an investor\'s sessions', async () => {
    const b = await signIn(USERS.investorB.email);
    const r = await post(adminRevoke, '', { cookie: admin, params: { id: await userId(USERS.investorB.email) } });
    expect(r.body.revoked).toBeGreaterThanOrEqual(1);
    expect((await call(me.GET, { path: '/v1/me', cookie: b })).status).toBe(401);
  });
});

describe('suspension', () => {
  it('suspending revokes sessions and blocks sign-in; reactivating restores sign-in', async () => {
    const id = await userId(USERS.investorB.email);
    const b = await signIn(USERS.investorB.email);
    const rev = (await userRow(id)).revision;
    expect((await post(suspend, '', { cookie: admin, params: { id }, ifMatch: rev - 1 })).status).toBe(409);
    const s = await post(suspend, '', { cookie: admin, params: { id }, ifMatch: rev });
    expect(s.status).toBe(200);
    expect(s.body.status).toBe('SUSPENDED');
    expect((await call(me.GET, { path: '/v1/me', cookie: b })).status).toBe(401);
    expect((await post(login, '/v1/auth/login', { body: { email: USERS.investorB.email, password: process.env.SEED_PASSWORD } })).status).toBe(401);

    const r = await post(reactivate, '', { cookie: admin, params: { id }, ifMatch: s.body.revision });
    expect(r.body.status).toBe('ACTIVE');
    await signIn(USERS.investorB.email);
  });

  it('admins cannot suspend other admins through investor actions', async () => {
    const adminId = await userId(USERS.admin.email);
    expect((await post(suspend, '', { cookie: admin, params: { id: adminId }, ifMatch: 1 })).status).toBe(404);
  });
});

describe('audit of account actions', () => {
  it('records actor, time and action for admin and account changes', async () => {
    const events = await direct.db.select().from(schema.auditEvents);
    const adminId = await userId(USERS.admin.email);
    for (const action of ['ADMIN_USER_INVITE', 'ADMIN_USER_INVITE_RESEND', 'ADMIN_USER_SUSPEND', 'ADMIN_USER_REACTIVATE', 'ADMIN_USER_RESET_SEND', 'ADMIN_USER_SESSIONS_REVOKE']) {
      const e = events.find((x) => x.action === action);
      expect(e, action).toBeTruthy();
      expect(e!.actorUserId).toBe(adminId);
      expect(e!.createdAt).toBeInstanceOf(Date);
    }
    for (const action of ['ACCOUNT_INVITE_ACCEPT', 'ACCOUNT_PASSWORD_RESET', 'ACCOUNT_MFA_ENABLE', 'ACCOUNT_MFA_DISABLE', 'ACCOUNT_SESSION_REVOKE']) {
      expect(events.some((x) => x.action === action), action).toBe(true);
    }
    // No secrets, passwords or raw tokens in the audit trail.
    const dump = JSON.stringify(events);
    expect(dump).not.toMatch(/Farhan-(first|second)-pass|argon2|otpauth/);
  });
});
