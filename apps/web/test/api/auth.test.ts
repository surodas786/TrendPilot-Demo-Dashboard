// IAM-01/IAM-02: sign-in, sessions, roles.
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashToken, schema } from '@trendpilot/db';
import * as login from '@/app/v1/auth/login/route';
import * as logout from '@/app/v1/auth/logout/route';
import * as me from '@/app/v1/me/route';
import * as blocks from '@/app/v1/me/order-blocks/route';
import * as adminUsers from '@/app/v1/admin/users/route';
import { call, direct, resetAndSeed, signIn, teardown, USERS } from '../helpers';

beforeAll(resetAndSeed);
afterAll(teardown);

const tokenOf = (cookie: string) => decodeURIComponent(cookie.split('=')[1]!);

describe('sign-in', () => {
  it('returns an HttpOnly SameSite session cookie and stores only its hash', async () => {
    const res = await call(login.POST, { method: 'POST', path: '/v1/auth/login', body: { email: USERS.investorA.email, password: process.env.SEED_PASSWORD } });
    expect(res.status).toBe(200);
    const setCookie = res.headers.get('set-cookie')!;
    expect(setCookie).toMatch(/HttpOnly/);
    expect(setCookie).toMatch(/SameSite=Lax/);
    const token = tokenOf(setCookie.split(';')[0]!);
    const rows = await direct.db.select().from(schema.sessions);
    expect(rows.some((r) => r.tokenHash === token)).toBe(false);
    expect(rows.some((r) => r.tokenHash === hashToken(token))).toBe(true);
  });

  it('rejects a wrong password with a generic 401 and audits it without the password', async () => {
    const res = await call(login.POST, { method: 'POST', path: '/v1/auth/login', body: { email: USERS.investorB.email, password: 'wrong-password-xyz' } });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('INVALID_CREDENTIALS');
    const unknown = await call(login.POST, { method: 'POST', path: '/v1/auth/login', body: { email: 'nobody@trendpilot.local', password: 'x' } });
    expect(unknown.status).toBe(401);
    expect(unknown.body.message).toBe(res.body.message);
    const failed = await direct.db.select().from(schema.auditEvents).where(eq(schema.auditEvents.result, 'FAILED'));
    expect(failed.length).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(failed)).not.toContain('wrong-password-xyz');
  });

  it('rate-limits repeated attempts for one email', async () => {
    let last = 0;
    for (let i = 0; i < 12; i++) {
      last = (await call(login.POST, { method: 'POST', path: '/v1/auth/login', body: { email: 'limit@trendpilot.local', password: 'x' } })).status;
    }
    expect(last).toBe(429);
  });

  it('rejects cross-origin sign-in posts', async () => {
    const res = await call(login.POST, {
      method: 'POST',
      path: '/v1/auth/login',
      headers: { origin: 'https://evil.example', host: 'localhost:3000' },
      body: { email: USERS.investorA.email, password: process.env.SEED_PASSWORD }
    });
    expect(res.status).toBe(403);
  });
});

describe('sessions', () => {
  it('no cookie or a forged cookie is 401', async () => {
    expect((await call(me.GET, { path: '/v1/me' })).status).toBe(401);
    expect((await call(me.GET, { path: '/v1/me', cookie: 'tp_session=forged-token' })).status).toBe(401);
    expect((await call(blocks.GET, { path: '/v1/me/order-blocks' })).status).toBe(401);
  });

  it('GET /v1/me reflects the signed-in investor with Paper and Live modes', async () => {
    const a = await signIn(USERS.investorA.email);
    const res = await call(me.GET, { path: '/v1/me', cookie: a });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ user: { email: USERS.investorA.email, name: 'Nadia Rahman', role: 'INVESTOR' }, allowedModes: ['PAPER', 'LIVE'], timezone: 'Asia/Dhaka' });
    expect(JSON.stringify(res.body)).not.toContain('password');
  });

  it('logout revokes the session', async () => {
    const a = await signIn(USERS.investorA.email);
    expect((await call(me.GET, { path: '/v1/me', cookie: a })).status).toBe(200);
    const out = await call(logout.POST, { method: 'POST', path: '/v1/auth/logout', cookie: a });
    expect(out.status).toBe(204);
    expect(out.headers.get('set-cookie')).toMatch(/Max-Age=0/);
    expect((await call(me.GET, { path: '/v1/me', cookie: a })).status).toBe(401);
  });

  it('an expired session is 401', async () => {
    const a = await signIn(USERS.investorA.email);
    await direct.db.update(schema.sessions).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(schema.sessions.tokenHash, hashToken(tokenOf(a))));
    expect((await call(me.GET, { path: '/v1/me', cookie: a })).status).toBe(401);
  });

  it('a suspended user\'s existing session stops working', async () => {
    const b = await signIn(USERS.investorB.email);
    await direct.db.update(schema.users).set({ status: 'SUSPENDED' }).where(eq(schema.users.email, USERS.investorB.email));
    expect((await call(me.GET, { path: '/v1/me', cookie: b })).status).toBe(401);
    await direct.db.update(schema.users).set({ status: 'ACTIVE' }).where(eq(schema.users.email, USERS.investorB.email));
  });
});

describe('roles', () => {
  it('admins have no investor order blocks (403)', async () => {
    const admin = await signIn(USERS.admin.email);
    const res = await call(blocks.GET, { path: '/v1/me/order-blocks', cookie: admin });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('FORBIDDEN');
  });

  it('investors cannot use admin routes; admins get users without credentials', async () => {
    const a = await signIn(USERS.investorA.email);
    expect((await call(adminUsers.GET, { path: '/v1/admin/users', cookie: a })).status).toBe(403);
    const admin = await signIn(USERS.admin.email);
    const res = await call(adminUsers.GET, { path: '/v1/admin/users', cookie: admin });
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(3);
    expect(JSON.stringify(res.body)).not.toMatch(/password|argon2/i);
  });
});
