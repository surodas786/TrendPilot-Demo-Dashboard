import { and, desc, eq, sql } from 'drizzle-orm';
import { DomainError, ErrorCode, type EmailDeliveryMode, type MailBoxViewDto, type MailSettingsDto, type MailSettingsInput, type SmtpSecurity } from '@trendpilot/domain';
import type { Executor } from '../client';
import { recordAudit } from '../repos/audit';
import { emailOutbox, mailSettings } from '../schema';
import { open, seal } from '../security/secretBox';
import { sendSmtp, type SmtpConfig, type SmtpResult } from './smtp';

/**
 * Mail Box settings. The SMTP password is sealed with the platform secret box and is
 * write-only: DTOs report only whether one is stored. Audit entries never carry it.
 */

/**
 * capture: messages are stored in email_outbox only (development, tests, e2e); never sent.
 * smtp: messages are stored and then relayed by the worker with the Mail Box settings.
 * Default: smtp in production, capture elsewhere. EMAIL_DELIVERY overrides.
 */
export function emailDeliveryMode(env: Record<string, string | undefined> = process.env): EmailDeliveryMode {
  const v = (env.EMAIL_DELIVERY ?? '').trim().toLowerCase();
  if (v === 'smtp' || v === 'capture') return v;
  return env.NODE_ENV === 'production' ? 'smtp' : 'capture';
}

type Row = typeof mailSettings.$inferSelect;

const EMPTY: MailSettingsDto = {
  configured: false,
  revision: 0,
  host: '',
  port: 587,
  security: 'STARTTLS',
  username: '',
  passwordConfigured: false,
  senderName: 'TrendPilot',
  senderEmail: '',
  replyTo: '',
  updatedAt: null,
  lastTest: null
};

function toDto(r: Row | undefined): MailSettingsDto {
  if (!r) return EMPTY;
  return {
    configured: true,
    revision: r.revision,
    host: r.smtpHost,
    port: r.smtpPort,
    security: r.smtpSecurity as SmtpSecurity,
    username: r.smtpUsername,
    passwordConfigured: Boolean(r.smtpPasswordSealed),
    senderName: r.senderName,
    senderEmail: r.senderEmail,
    replyTo: r.replyTo ?? '',
    updatedAt: r.updatedAt.toISOString(),
    lastTest: r.lastTestAt ? { ok: Boolean(r.lastTestOk), at: r.lastTestAt.toISOString(), recipient: r.lastTestRecipient ?? '', detail: r.lastTestDetail ?? '' } : null
  };
}

const readRow = async (db: Executor) => (await db.select().from(mailSettings).where(eq(mailSettings.id, 1)))[0];

export async function getMailSettings(db: Executor): Promise<MailSettingsDto> {
  return toDto(await readRow(db));
}

/** Non-secret view of the settings for audit before/after. */
const auditView = (d: MailSettingsDto) => ({
  host: d.host,
  port: d.port,
  security: d.security,
  usernameSet: Boolean(d.username),
  passwordConfigured: d.passwordConfigured,
  senderName: d.senderName,
  senderEmail: d.senderEmail,
  replyTo: d.replyTo || null
});

/**
 * Saves the settings with optimistic concurrency (revision 0 = first save). A blank password
 * keeps the stored one; clearPassword removes it.
 */
export async function saveMailSettings(
  db: Executor,
  input: MailSettingsInput,
  opts: { adminId: string; expectedRevision: number; correlationId: string }
): Promise<MailSettingsDto> {
  const current = await readRow(db);
  const currentRevision = current?.revision ?? 0;
  if (opts.expectedRevision !== currentRevision) {
    throw new DomainError(409, ErrorCode.REVISION_CONFLICT, 'Someone else changed the mail settings. Reload the page and try again.');
  }
  const passwordSealed = input.clearPassword ? null : input.password ? seal(input.password) : (current?.smtpPasswordSealed ?? null);
  const values = {
    smtpHost: input.host,
    smtpPort: input.port,
    smtpSecurity: input.security,
    smtpUsername: input.username,
    smtpPasswordSealed: passwordSealed,
    senderName: input.senderName,
    senderEmail: input.senderEmail,
    replyTo: input.replyTo || null,
    updatedBy: opts.adminId,
    updatedAt: new Date()
  };
  let row: Row | undefined;
  if (current) {
    [row] = await db
      .update(mailSettings)
      .set({ ...values, revision: sql`${mailSettings.revision} + 1` })
      .where(and(eq(mailSettings.id, 1), eq(mailSettings.revision, currentRevision)))
      .returning();
    if (!row) throw new DomainError(409, ErrorCode.REVISION_CONFLICT, 'Someone else changed the mail settings. Reload the page and try again.');
  } else {
    [row] = await db.insert(mailSettings).values({ id: 1, revision: 1, ...values }).onConflictDoNothing().returning();
    if (!row) throw new DomainError(409, ErrorCode.REVISION_CONFLICT, 'Someone else saved the mail settings first. Reload the page and try again.');
  }
  const before = toDto(current);
  const after = toDto(row);
  await recordAudit(db, {
    actorUserId: opts.adminId,
    action: 'ADMIN_MAIL_SETTINGS_UPDATE',
    targetType: 'mail_settings',
    targetId: null,
    result: 'SUCCESS',
    before: current ? auditView(before) : null,
    after: auditView(after),
    metadata: {
      passwordChange: input.clearPassword ? 'REMOVED' : input.password ? 'REPLACED' : 'UNCHANGED',
      usernameChanged: before.username !== after.username
    },
    correlationId: opts.correlationId
  });
  return after;
}

/** Server-side only: the full SMTP configuration including the unsealed password. */
export async function loadSmtpConfig(db: Executor): Promise<SmtpConfig | null> {
  const r = await readRow(db);
  if (!r) return null;
  return {
    host: r.smtpHost,
    port: r.smtpPort,
    security: r.smtpSecurity as SmtpSecurity,
    username: r.smtpUsername,
    password: r.smtpPasswordSealed ? open(r.smtpPasswordSealed) : null,
    senderName: r.senderName,
    senderEmail: r.senderEmail,
    replyTo: r.replyTo
  };
}

const TEST_SUBJECT = 'TrendPilot test email';
const TEST_BODY = 'This is a test message from TrendPilot (Admin → Settings → Mail Box).\n\nIf you received it, outgoing email is configured correctly. No action is needed.';

/**
 * Sends a test message with the saved settings, records the outcome on the settings row and
 * audits the attempt (recipient and result only).
 */
export async function sendMailTest(db: Executor, opts: { adminId: string; recipient: string; correlationId: string; now?: Date }): Promise<{ ok: boolean; at: string; recipient: string; detail: string; kind: string | null }> {
  const at = opts.now ?? new Date();
  let config: SmtpConfig | null = null;
  let result: SmtpResult;
  try {
    config = await loadSmtpConfig(db);
    result = config
      ? await sendSmtp(config, { to: opts.recipient, subject: TEST_SUBJECT, text: TEST_BODY })
      : { ok: false, kind: 'NOT_CONFIGURED', code: null, detail: 'Save the SMTP settings before sending a test email.', permanent: true };
  } catch {
    // e.g. the sealed password cannot be opened (DATA_ENCRYPTION_KEY changed).
    result = { ok: false, kind: 'UNKNOWN', code: null, detail: 'The stored SMTP password could not be read. Enter the password again and save.', permanent: true };
  }
  const detail = result.ok ? `Accepted by ${config!.host}: ${result.response}` : result.detail;
  if (config) {
    await db
      .update(mailSettings)
      .set({ lastTestAt: at, lastTestOk: result.ok, lastTestRecipient: opts.recipient, lastTestDetail: detail })
      .where(eq(mailSettings.id, 1));
  }
  await recordAudit(db, {
    actorUserId: opts.adminId,
    action: 'ADMIN_MAIL_TEST_SEND',
    targetType: 'mail_settings',
    targetId: null,
    result: result.ok ? 'SUCCESS' : 'FAILED',
    metadata: { recipient: opts.recipient, outcome: result.ok ? 'ACCEPTED' : result.kind, smtpCode: result.ok ? null : result.code },
    correlationId: opts.correlationId
  });
  return { ok: result.ok, at: at.toISOString(), recipient: opts.recipient, detail, kind: result.ok ? null : result.kind };
}

export async function getMailBoxView(db: Executor, env: Record<string, string | undefined> = process.env): Promise<MailBoxViewDto> {
  const settings = await getMailSettings(db);
  const counts = await db
    .select({ status: emailOutbox.deliveryStatus, n: sql<number>`count(*)::int` })
    .from(emailOutbox)
    .groupBy(emailOutbox.deliveryStatus);
  const n = (s: string) => counts.find((c) => c.status === s)?.n ?? 0;
  // Bodies are never returned: they contain single-use invite and reset links.
  const failures = await db
    .select({ id: emailOutbox.id, to: emailOutbox.toEmail, template: emailOutbox.template, subject: emailOutbox.subject, error: emailOutbox.deliveryError, createdAt: emailOutbox.createdAt })
    .from(emailOutbox)
    .where(eq(emailOutbox.deliveryStatus, 'FAILED'))
    .orderBy(desc(emailOutbox.createdAt))
    .limit(10);
  return {
    deliveryMode: emailDeliveryMode(env),
    settings,
    deliveries: { queued: n('QUEUED'), sent: n('SENT'), failed: n('FAILED'), captured: n('CAPTURED') },
    recentFailures: failures.map((f) => ({ ...f, error: f.error ?? '', createdAt: f.createdAt.toISOString() }))
  };
}
