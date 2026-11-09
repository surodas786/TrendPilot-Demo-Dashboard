import { z } from 'zod';
import { emailSchema } from './auth';

/**
 * Admin → Settings → Mail Box: outgoing SMTP for invitations, password resets and notices.
 * The password is write-only: it is sealed at rest and never returned to the browser.
 */

export const SMTP_SECURITY_MODES = ['STARTTLS', 'TLS'] as const;
export type SmtpSecurity = (typeof SMTP_SECURITY_MODES)[number];

/** Header values must never carry CR/LF (prevents SMTP header injection). */
const noLineBreaks = (s: string) => !/[\r\n]/.test(s);

/** A DNS hostname or IPv4/IPv6 literal; no scheme, path, port or whitespace. */
const HOSTNAME_RE = /^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;
const IPV6_RE = /^[0-9A-Fa-f:.]{2,45}$/;
export const isValidSmtpHost = (h: string) => HOSTNAME_RE.test(h) || (h.includes(':') && IPV6_RE.test(h));

const optionalEmail = z
  .string()
  .trim()
  .max(254)
  .transform((s) => s.toLowerCase())
  .refine((s) => s === '' || z.email().safeParse(s).success, 'Enter a valid email address or leave it empty.');

export const mailSettingsInputSchema = z
  .object({
    host: z
      .string()
      .trim()
      .min(1, 'Enter the SMTP host.')
      .max(253)
      .refine(isValidSmtpHost, 'Enter a host name only, e.g. smtp.example.com (no https:// or port).'),
    port: z.coerce.number({ error: 'Enter a port number.' }).int('Enter a whole number.').min(1, 'Use a port from 1 to 65535.').max(65535, 'Use a port from 1 to 65535.'),
    security: z.enum(SMTP_SECURITY_MODES, { error: 'Choose STARTTLS or implicit TLS.' }),
    username: z.string().trim().max(254).refine(noLineBreaks, 'Line breaks are not allowed.').default(''),
    /** Blank keeps the stored password. */
    password: z.string().max(512).refine(noLineBreaks, 'Line breaks are not allowed.').optional().default(''),
    /** Remove the stored password (e.g. a relay without authentication). */
    clearPassword: z.boolean().optional().default(false),
    senderName: z.string().trim().min(1, 'Enter a sender name.').max(100).refine(noLineBreaks, 'Line breaks are not allowed.'),
    senderEmail: emailSchema,
    replyTo: optionalEmail.default('')
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.clearPassword && v.password) ctx.addIssue({ code: 'custom', path: ['password'], message: 'Leave the password empty when removing it.' });
    if (v.password && !v.username) ctx.addIssue({ code: 'custom', path: ['username'], message: 'Enter the username that goes with this password.' });
  });
export type MailSettingsInput = z.output<typeof mailSettingsInputSchema>;

export const mailTestSchema = z.object({ recipient: emailSchema }).strict();

/** Where outgoing mail goes: captured in the local outbox (dev/test) or relayed over SMTP. */
export type EmailDeliveryMode = 'capture' | 'smtp';

export interface MailTestResultDto {
  ok: boolean;
  at: string;
  recipient: string;
  /** SMTP reply or a redacted error description. Never contains credentials. */
  detail: string;
}

export interface MailSettingsDto {
  configured: boolean;
  revision: number;
  host: string;
  port: number;
  security: SmtpSecurity;
  username: string;
  /** True when a password is stored. The password itself is never returned. */
  passwordConfigured: boolean;
  senderName: string;
  senderEmail: string;
  replyTo: string;
  updatedAt: string | null;
  lastTest: MailTestResultDto | null;
}

export interface MailDeliveryFailureDto {
  id: string;
  to: string;
  template: string;
  subject: string;
  error: string;
  createdAt: string;
}

export interface MailBoxViewDto {
  deliveryMode: EmailDeliveryMode;
  settings: MailSettingsDto;
  deliveries: { queued: number; sent: number; failed: number; captured: number };
  recentFailures: MailDeliveryFailureDto[];
}
