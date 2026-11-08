import { z } from 'zod';

export const ROLES = ['ADMIN', 'INVESTOR'] as const;
export type Role = (typeof ROLES)[number];

export const PASSWORD_MIN = 12;

export const passwordSchema = z
  .string()
  .min(PASSWORD_MIN, `Use at least ${PASSWORD_MIN} characters.`)
  .max(200)
  .refine((p) => /[A-Za-z]/.test(p) && /\d/.test(p), 'Include at least one letter and one number.');

export const emailSchema = z.string().trim().toLowerCase().pipe(z.email({ error: 'Enter a valid email address.' })).pipe(z.string().max(254));

export const loginSchema = z
  .object({
    email: z.string().trim().min(3).max(254),
    password: z.string().min(1).max(200)
  })
  .strict();
export type LoginInput = z.output<typeof loginSchema>;

export const mfaCodeSchema = z.object({ code: z.string().trim().regex(/^\d{6}$/, 'Enter the 6-digit code.') }).strict();

/** Tokens travel in the URL fragment and are posted here; the server stores only their hash. */
const linkToken = z.string().min(20).max(200);

export const inviteCreateSchema = z.object({ name: z.string().trim().min(2).max(120), email: emailSchema }).strict();
export const acceptInviteSchema = z.object({ token: linkToken, password: passwordSchema }).strict();
export const resetPasswordSchema = z.object({ token: linkToken, password: passwordSchema }).strict();
export const forgotPasswordSchema = z.object({ email: z.string().trim().min(3).max(254) }).strict();
export const tokenOnlySchema = z.object({ token: linkToken }).strict();

/** IAM-01 link lifetimes. */
export const INVITE_TTL_HOURS = 72;
export const RESET_TTL_MINUTES = 30;
export const MFA_CHALLENGE_TTL_MINUTES = 5;
