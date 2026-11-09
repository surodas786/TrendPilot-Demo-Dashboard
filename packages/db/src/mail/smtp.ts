import nodemailer from 'nodemailer';
import type { SmtpSecurity } from '@trendpilot/domain';

/**
 * SMTP relay for Admin → Settings → Mail Box. The only code that holds the plaintext SMTP
 * password; it never logs, returns or stores it. Errors are classified and redacted.
 */

export interface SmtpConfig {
  host: string;
  port: number;
  security: SmtpSecurity;
  username: string;
  password: string | null;
  senderName: string;
  senderEmail: string;
  replyTo: string | null;
}

export interface SmtpMessage {
  to: string;
  subject: string;
  text: string;
}

export type SmtpFailureKind = 'AUTH' | 'CONNECTION' | 'TIMEOUT' | 'TLS' | 'REJECTED' | 'NOT_CONFIGURED' | 'UNKNOWN';

export type SmtpResult =
  | { ok: true; response: string; messageId: string | null }
  | {
      ok: false;
      kind: SmtpFailureKind;
      /** SMTP reply code when the server sent one (e.g. 535). */
      code: number | null;
      /** Redacted, human-readable; safe for the admin UI, audit and logs. */
      detail: string;
      /** True when retrying the same message cannot help (auth, 5xx rejection). */
      permanent: boolean;
    };

/** Minimal transport surface; tests replace it with a mocked SMTP server. */
export interface SmtpTransport {
  sendMail(m: { from: { name: string; address: string }; to: string; replyTo?: string; subject: string; text: string }): Promise<{ response?: string; messageId?: string }>;
  close?(): void;
}
export type SmtpTransportFactory = (options: Record<string, unknown>) => SmtpTransport;

const TIMEOUTS = { connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 20_000 };

/** nodemailer options. STARTTLS is required (never falls back to plaintext); TLS is implicit TLS. */
export function transportOptions(c: SmtpConfig): Record<string, unknown> {
  return {
    host: c.host,
    port: c.port,
    secure: c.security === 'TLS',
    requireTLS: c.security === 'STARTTLS',
    ignoreTLS: false,
    tls: { minVersion: 'TLSv1.2', servername: c.host },
    auth: c.username ? { user: c.username, pass: c.password ?? '' } : undefined,
    ...TIMEOUTS,
    logger: false,
    debug: false,
    disableFileAccess: true,
    disableUrlAccess: true
  };
}

const defaultFactory: SmtpTransportFactory = (o) => (nodemailer.createTransport as (o: Record<string, unknown>) => unknown)(o) as SmtpTransport;
let factory: SmtpTransportFactory = defaultFactory;

/**
 * Test seam: replace the SMTP transport with a mock. Refused in production so a deployment can
 * never redirect mail by code path. Pass null to restore the real transport.
 */
export function setSmtpTransportFactoryForTests(f: SmtpTransportFactory | null): void {
  if (process.env.NODE_ENV === 'production') throw new Error('Replacing the SMTP transport is not allowed in production.');
  factory = f ?? defaultFactory;
}

/** Removes the password (plain and in AUTH PLAIN/LOGIN base64 forms) from any server text. */
export function redactSmtpText(text: string, c: Pick<SmtpConfig, 'username' | 'password'>): string {
  let out = text.replace(/[\r\n]+/g, ' ').trim();
  const secrets = new Set<string>();
  if (c.password) {
    secrets.add(c.password);
    secrets.add(Buffer.from(c.password).toString('base64'));
    secrets.add(Buffer.from(`\u0000${c.username}\u0000${c.password}`).toString('base64'));
    secrets.add(Buffer.from(`${c.username}\u0000${c.username}\u0000${c.password}`).toString('base64'));
  }
  for (const s of secrets) if (s.length >= 3) out = out.split(s).join('[redacted]');
  return out.slice(0, 300);
}

interface NodemailerError {
  code?: string;
  responseCode?: number;
  response?: string;
  message?: string;
  command?: string;
}

export function classifySmtpError(e: unknown, c: SmtpConfig): Extract<SmtpResult, { ok: false }> {
  const err = (e ?? {}) as NodemailerError;
  const code = typeof err.responseCode === 'number' ? err.responseCode : null;
  const raw = redactSmtpText(err.response || err.message || String(e), c);
  const at = `${c.host}:${c.port}`;
  const errCode = err.code ?? '';
  if (errCode === 'EAUTH' || code === 535 || code === 534 || code === 530) {
    return { ok: false, kind: 'AUTH', code, detail: `Authentication failed at ${at}: ${raw}`, permanent: true };
  }
  if (errCode === 'ETIMEDOUT' || /timeout/i.test(raw)) {
    return { ok: false, kind: 'TIMEOUT', code, detail: `Timed out talking to ${at}: ${raw}`, permanent: false };
  }
  if (errCode === 'ETLS' || /tls|ssl|certificate|wrong version number|starttls/i.test(raw)) {
    return { ok: false, kind: 'TLS', code, detail: `TLS negotiation with ${at} failed (check the port and security mode): ${raw}`, permanent: true };
  }
  if (errCode === 'ECONNECTION' || errCode === 'ESOCKET' || errCode === 'EDNS' || /ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ECONNRESET|EHOSTUNREACH/.test(raw)) {
    return { ok: false, kind: 'CONNECTION', code, detail: `Could not connect to ${at}: ${raw}`, permanent: false };
  }
  if (code !== null && code >= 500) return { ok: false, kind: 'REJECTED', code, detail: `The SMTP server rejected the message (${code}): ${raw}`, permanent: true };
  if (code !== null && code >= 400) return { ok: false, kind: 'REJECTED', code, detail: `The SMTP server deferred the message (${code}): ${raw}`, permanent: false };
  return { ok: false, kind: 'UNKNOWN', code, detail: `Sending through ${at} failed: ${raw}`, permanent: false };
}

/** Sends one plain-text message. Never throws; the result says whether the server accepted it. */
export async function sendSmtp(c: SmtpConfig, m: SmtpMessage): Promise<SmtpResult> {
  let transport: SmtpTransport | null = null;
  try {
    transport = factory(transportOptions(c));
    const info = await transport.sendMail({
      from: { name: c.senderName, address: c.senderEmail },
      to: m.to,
      replyTo: c.replyTo || undefined,
      subject: m.subject,
      text: m.text
    });
    return { ok: true, response: redactSmtpText(info.response ?? '250 Accepted', c), messageId: info.messageId ?? null };
  } catch (e) {
    return classifySmtpError(e, c);
  } finally {
    try {
      transport?.close?.();
    } catch {
      /* ignore */
    }
  }
}
