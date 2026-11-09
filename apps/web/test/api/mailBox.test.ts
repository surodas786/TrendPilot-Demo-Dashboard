// Admin → Settings → Mail Box: admin-only SMTP settings, sealed write-only password, test sends
// against a mocked SMTP server, and delivery of existing emails (invite, reset) through the worker.
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { captureEmail, EMAIL_DELIVER_JOB, processNextEmailJob, schema, secretBox, setSmtpTransportFactoryForTests, type SmtpTransportFactory } from '@trendpilot/db';
import * as mail from '@/app/v1/admin/settings/mail/route';
import * as mailTest from '@/app/v1/admin/settings/mail/test/route';
import * as users from '@/app/v1/admin/users/route';
import * as forgot from '@/app/v1/auth/password/forgot/route';
import { resetAllLimits } from '@/server/rateLimit';
import { call, direct, resetAndSeed, signIn, teardown, userId, USERS } from '../helpers';

const PASSWORD = 'App-Pass-9f3K-unique-zq';
const NEW_PASSWORD = 'Second-Pass-7Lm-unique-wx';
const SETTINGS = {
  host: 'smtp.mail-test.example',
  port: 587,
  security: 'STARTTLS',
  username: 'mailer@trendpilot.example',
  password: PASSWORD,
  senderName: 'TrendPilot',
  senderEmail: 'no-reply@trendpilot.example',
  replyTo: 'support@trendpilot.example'
};

let admin = '';
let investor = '';

const get = (cookie?: string) => call(mail.GET, { path: '/v1/admin/settings/mail', cookie });
const put = (body: unknown, ifMatch: number | undefined, cookie = admin) => call(mail.PUT, { method: 'PUT', path: '/v1/admin/settings/mail', cookie, body, ifMatch });
const test = (recipient: string, cookie = admin) => call(mailTest.POST, { method: 'POST', path: '/v1/admin/settings/mail/test', cookie, body: { recipient } });
const row = async () => (await direct.db.select().from(schema.mailSettings).where(eq(schema.mailSettings.id, 1)))[0];
const auditDump = async () => JSON.stringify(await direct.db.select().from(schema.auditEvents));

/** Mocked SMTP server: records what would be sent and replies like a real server. */
function mockSmtp(reply: { response?: string; error?: Record<string, unknown> }) {
  const sent: { options: Record<string, any>; message: Record<string, any> }[] = [];
  const factory: SmtpTransportFactory = (options) => ({
    sendMail: async (message) => {
      sent.push({ options, message });
      if (reply.error) throw Object.assign(new Error(String(reply.error.response ?? 'SMTP error')), reply.error);
      return { response: reply.response ?? '250 2.0.0 OK queued as ABC123', messageId: '<m1@trendpilot>' };
    }
  });
  setSmtpTransportFactoryForTests(factory);
  return sent;
}

beforeAll(async () => {
  await resetAndSeed();
  admin = await signIn(USERS.admin.email);
  investor = await signIn(USERS.investorA.email);
});
afterEach(() => {
  setSmtpTransportFactoryForTests(null);
  resetAllLimits();
  delete process.env.EMAIL_DELIVERY;
});
afterAll(teardown);

describe('access', () => {
  it('the page API and test send are admin-only', async () => {
    expect((await get()).status).toBe(401);
    expect((await get(investor)).status).toBe(403);
    expect((await put(SETTINGS, 0, investor)).status).toBe(403);
    expect((await call(mail.PUT, { method: 'PUT', path: '/x', body: SETTINGS, ifMatch: 0 })).status).toBe(401);
    expect((await test('a@example.com', investor)).status).toBe(403);
    expect((await call(mailTest.POST, { method: 'POST', path: '/x', body: { recipient: 'a@example.com' } })).status).toBe(401);
    expect(await row()).toBeUndefined();
  });
});

describe('saving and reloading settings', () => {
  it('starts unconfigured, in capture mode outside production', async () => {
    const r = await get(admin);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ deliveryMode: 'capture', settings: { configured: false, revision: 0, passwordConfigured: false, lastTest: null } });
  });

  it('validates server-side', async () => {
    const r = await put({ ...SETTINGS, host: 'https://smtp.example.com', port: 0, security: 'NONE', senderName: 'Evil\r\nBcc: x@y.z', senderEmail: 'nope', replyTo: 'bad' }, 0);
    expect(r.status).toBe(400);
    expect(r.body.issues.map((i: any) => i.path).sort()).toEqual(['host', 'port', 'replyTo', 'security', 'senderEmail', 'senderName']);
    expect((await put({ ...SETTINGS, username: '' }, 0)).body.issues.map((i: any) => i.path)).toEqual(['username']);
    expect((await put({ ...SETTINGS, extra: 1 }, 0)).status).toBe(400);
    expect((await call(mail.PUT, { method: 'PUT', path: '/x', cookie: admin, body: SETTINGS })).status).toBe(428);
    expect(await row()).toBeUndefined();
  });

  it('saves, seals the password and never returns it', async () => {
    const r = await put(SETTINGS, 0);
    expect(r.status).toBe(200);
    expect(r.headers.get('etag')).toBe('"1"');
    expect(r.body.settings).toMatchObject({ configured: true, revision: 1, host: SETTINGS.host, port: 587, security: 'STARTTLS', username: SETTINGS.username, passwordConfigured: true, senderEmail: SETTINGS.senderEmail, replyTo: SETTINGS.replyTo });
    expect(JSON.stringify(r.body)).not.toContain(PASSWORD);
    expect(r.body.settings).not.toHaveProperty('password');

    const stored = (await row())!;
    expect(stored.smtpPasswordSealed).toMatch(/^v1\./);
    expect(stored.smtpPasswordSealed).not.toContain(PASSWORD);
    expect(secretBox.open(stored.smtpPasswordSealed!)).toBe(PASSWORD);

    const reloaded = await get(admin);
    expect(reloaded.body.settings).toEqual(r.body.settings);
    expect(JSON.stringify(reloaded.body)).not.toContain(PASSWORD);
  });

  it('a blank password on edit keeps the stored one', async () => {
    const before = (await row())!.smtpPasswordSealed;
    const r = await put({ ...SETTINGS, host: 'smtp2.mail-test.example', port: 465, security: 'TLS', password: '' }, 1);
    expect(r.status).toBe(200);
    expect(r.body.settings).toMatchObject({ revision: 2, host: 'smtp2.mail-test.example', port: 465, security: 'TLS', passwordConfigured: true });
    const after = (await row())!;
    expect(after.smtpPasswordSealed).toBe(before);
    expect(secretBox.open(after.smtpPasswordSealed!)).toBe(PASSWORD);
  });

  it('rejects a stale revision', async () => {
    const r = await put(SETTINGS, 1);
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('REVISION_CONFLICT');
  });

  it('replaces and removes the password on request', async () => {
    expect((await put({ ...SETTINGS, password: NEW_PASSWORD }, 2)).body.settings.passwordConfigured).toBe(true);
    expect(secretBox.open((await row())!.smtpPasswordSealed!)).toBe(NEW_PASSWORD);
    const cleared = await put({ ...SETTINGS, password: '', clearPassword: true }, 3);
    expect(cleared.body.settings.passwordConfigured).toBe(false);
    expect((await row())!.smtpPasswordSealed).toBeNull();
    expect((await put({ ...SETTINGS, password: PASSWORD }, 4)).body.settings.revision).toBe(5);
  });

  it('audits every change without credentials', async () => {
    const events = await direct.db.select().from(schema.auditEvents).where(eq(schema.auditEvents.action, 'ADMIN_MAIL_SETTINGS_UPDATE'));
    expect(events).toHaveLength(5);
    expect(events.map((e) => (e.metadata as any).passwordChange)).toEqual(['REPLACED', 'UNCHANGED', 'REPLACED', 'REMOVED', 'REPLACED']);
    const dump = await auditDump();
    expect(dump).not.toContain(PASSWORD);
    expect(dump).not.toContain(NEW_PASSWORD);
    expect(dump).not.toContain(SETTINGS.username);
    expect(dump).not.toContain('v1.');
  });
});

describe('send test email (mocked SMTP)', () => {
  it('reports success when the server accepts the message, and records the last test', async () => {
    const sent = mockSmtp({ response: '250 2.0.0 OK queued as ABC123' });
    const r = await test('ops@trendpilot.example');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, recipient: 'ops@trendpilot.example', kind: null });
    expect(r.body.detail).toMatch(/Accepted by smtp\.mail-test\.example: 250 2\.0\.0 OK/);
    expect(JSON.stringify(r.body)).not.toContain(PASSWORD);

    expect(sent).toHaveLength(1);
    expect(sent[0]!.options).toMatchObject({ host: SETTINGS.host, port: 587, secure: false, requireTLS: true, auth: { user: SETTINGS.username, pass: PASSWORD } });
    expect(sent[0]!.message).toMatchObject({ to: 'ops@trendpilot.example', from: { name: 'TrendPilot', address: SETTINGS.senderEmail }, replyTo: SETTINGS.replyTo, subject: 'TrendPilot test email' });

    const last = (await get(admin)).body.settings.lastTest;
    expect(last).toMatchObject({ ok: true, recipient: 'ops@trendpilot.example' });
    expect(Date.parse(last.at)).toBeGreaterThan(Date.now() - 60_000);
  });

  it('reports the server error, redacted, when the server rejects the login', async () => {
    mockSmtp({ error: { code: 'EAUTH', responseCode: 535, command: 'AUTH PLAIN', response: `535 5.7.8 Username and Password not accepted (${PASSWORD})` } });
    const r = await test('ops@trendpilot.example');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: false, kind: 'AUTH' });
    expect(r.body.detail).toMatch(/Authentication failed at smtp\.mail-test\.example:587: 535 5\.7\.8 Username and Password not accepted \(\[redacted\]\)/);
    expect(JSON.stringify(r.body)).not.toContain(PASSWORD);
    expect((await get(admin)).body.settings.lastTest).toMatchObject({ ok: false });
    expect(JSON.stringify((await get(admin)).body)).not.toContain(PASSWORD);
  });

  it('reports a connection failure from a real socket (nothing listening)', async () => {
    const saved = (await get(admin)).body.settings;
    await put({ ...SETTINGS, host: '127.0.0.1', port: 9, password: '' }, saved.revision);
    const r = await test('ops@trendpilot.example');
    expect(r.body).toMatchObject({ ok: false, kind: 'CONNECTION' });
    expect(r.body.detail).toMatch(/Could not connect to 127\.0\.0\.1:9/);
    const now = (await get(admin)).body.settings;
    await put({ ...SETTINGS, password: '' }, now.revision);
  });

  it('audits test attempts without credentials', async () => {
    const events = await direct.db.select().from(schema.auditEvents).where(eq(schema.auditEvents.action, 'ADMIN_MAIL_TEST_SEND'));
    expect(events.map((e) => [e.result, (e.metadata as any).outcome])).toEqual([
      ['SUCCESS', 'ACCEPTED'],
      ['FAILED', 'AUTH'],
      ['FAILED', 'CONNECTION']
    ]);
    expect(await auditDump()).not.toContain(PASSWORD);
  });

  it('rate-limits test sends per admin', async () => {
    mockSmtp({});
    for (let i = 0; i < 5; i++) expect((await test('ops@trendpilot.example')).status).toBe(200);
    const limited = await test('ops@trendpilot.example');
    expect(limited.status).toBe(429);
    expect(limited.body.code).toBe('RATE_LIMITED');
    const denied = await direct.db.select().from(schema.auditEvents).where(eq(schema.auditEvents.result, 'DENIED'));
    expect(denied.some((e) => e.action === 'ADMIN_MAIL_TEST_SEND')).toBe(true);
  });

  it('validates the recipient', async () => {
    expect((await test('not-an-email')).status).toBe(400);
  });
});

describe('existing emails use the saved settings', () => {
  const jobsFor = async () => direct.db.select().from(schema.jobs).where(eq(schema.jobs.kind, EMAIL_DELIVER_JOB));

  it('capture mode (development and tests): stored only, nothing queued or sent', async () => {
    const sent = mockSmtp({});
    const before = (await jobsFor()).length;
    const r = await captureEmail(direct.db, { to: 'x@trendpilot.example', subject: 's', body: 'b', template: 'SUSPENDED' });
    expect(r.deliveryStatus).toBe('CAPTURED');
    expect(await jobsFor()).toHaveLength(before);
    expect((await processNextEmailJob(direct.db, { workerId: 'w-test' })).outcome).toBe('IDLE');
    expect(sent).toHaveLength(0);
  });

  it('SMTP mode: an invitation and a password reset are delivered by the worker with the saved settings', async () => {
    process.env.EMAIL_DELIVERY = 'smtp';
    const sent = mockSmtp({ response: '250 OK' });
    const invited = { name: 'Mail Box Invitee', email: 'mailbox.invitee@trendpilot.local' };
    expect((await call(users.POST, { method: 'POST', path: '/v1/admin/users', cookie: admin, body: invited })).status).toBe(201);
    expect((await call(forgot.POST, { method: 'POST', path: '/v1/auth/password/forgot', body: { email: USERS.investorA.email } })).status).toBe(202);

    const queued = await direct.db.select().from(schema.emailOutbox).where(eq(schema.emailOutbox.deliveryStatus, 'QUEUED'));
    expect(queued.map((q) => q.template).sort()).toEqual(['INVITE', 'RESET']);
    expect(sent).toHaveLength(0); // nothing leaves before the worker runs

    expect((await processNextEmailJob(direct.db, { workerId: 'w-test' })).outcome).toBe('SENT');
    expect((await processNextEmailJob(direct.db, { workerId: 'w-test' })).outcome).toBe('SENT');
    expect((await processNextEmailJob(direct.db, { workerId: 'w-test' })).outcome).toBe('IDLE');

    expect(sent.map((s) => s.message.to).sort()).toEqual([USERS.investorA.email, invited.email].sort());
    expect(sent.every((s) => s.options.host === SETTINGS.host && s.options.auth.pass === PASSWORD && s.message.from.address === SETTINGS.senderEmail)).toBe(true);
    expect(sent.find((s) => s.message.to === invited.email)!.message.text).toMatch(/\/account\/invite#token=/);
    const rows = await direct.db.select().from(schema.emailOutbox).where(eq(schema.emailOutbox.deliveryStatus, 'SENT'));
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.deliveredAt)).toBe(true);
    expect(await userId(invited.email)).toBeTruthy();
  });

  it('SMTP mode: a transient failure is retried; a rejection is reported as FAILED', async () => {
    process.env.EMAIL_DELIVERY = 'smtp';
    mockSmtp({ error: { code: 'ECONNECTION', response: 'connect ECONNREFUSED' } });
    const a = await captureEmail(direct.db, { to: 'retry@trendpilot.example', subject: 's', body: 'b', template: 'SUSPENDED' });
    const r1 = await processNextEmailJob(direct.db, { workerId: 'w-test' });
    expect(r1).toMatchObject({ outcome: 'RETRY', outboxId: a.id });
    const [stillQueued] = await direct.db.select().from(schema.emailOutbox).where(eq(schema.emailOutbox.id, a.id));
    expect(stillQueued).toMatchObject({ deliveryStatus: 'QUEUED' });
    expect(stillQueued!.deliveryError).toMatch(/^Retrying: Could not connect/);

    // Retry after the backoff: the server now rejects the recipient permanently.
    mockSmtp({ error: { responseCode: 550, response: '550 5.1.1 Recipient address rejected' } });
    const r2 = await processNextEmailJob(direct.db, { workerId: 'w-test', now: new Date(Date.now() + 5 * 60_000) });
    expect(r2).toMatchObject({ outcome: 'FAILED', outboxId: a.id });
    const view = (await get(admin)).body;
    expect(view.deliveries.failed).toBeGreaterThanOrEqual(1);
    expect(view.recentFailures[0]).toMatchObject({ to: 'retry@trendpilot.example', template: 'SUSPENDED' });
    expect(view.recentFailures[0].error).toMatch(/rejected the message \(550\)/);
    expect(JSON.stringify(view)).not.toMatch(/"body"|bodyText/);
  });

  it('SMTP mode without saved settings: the message is marked FAILED with a clear reason', async () => {
    process.env.EMAIL_DELIVERY = 'smtp';
    await direct.db.delete(schema.mailSettings);
    const sent = mockSmtp({});
    const m = await captureEmail(direct.db, { to: 'nosmtp@trendpilot.example', subject: 's', body: 'b', template: 'SUSPENDED' });
    const r = await processNextEmailJob(direct.db, { workerId: 'w-test' });
    expect(r).toMatchObject({ outcome: 'FAILED', outboxId: m.id });
    expect(r.detail).toMatch(/SMTP is not configured/);
    expect(sent).toHaveLength(0);
    const view = (await get(admin)).body;
    expect(view).toMatchObject({ deliveryMode: 'smtp', settings: { configured: false } });
    expect(view.recentFailures[0].error).toMatch(/SMTP is not configured/);
  });
});
