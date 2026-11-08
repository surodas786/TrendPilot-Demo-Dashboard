import { getDb, resolveSession, type ResolvedSession } from '@trendpilot/db';
import { DomainError, ErrorCode } from '@trendpilot/domain';

const isProduction = () => process.env.NODE_ENV === 'production';

/** `__Host-` requires Secure, which local http cannot provide. */
export const sessionCookieName = () => (isProduction() ? '__Host-tp_session' : 'tp_session');

export const sessionTtlHours = () => {
  const n = Number(process.env.SESSION_TTL_HOURS ?? 12);
  return Number.isFinite(n) && n > 0 && n <= 24 * 30 ? n : 12;
};

export function readCookie(header: string | null, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return undefined;
}

export const sessionTokenFrom = (req: Request) => readCookie(req.headers.get('cookie'), sessionCookieName());

export function sessionCookie(token: string, maxAgeSeconds: number): string {
  const parts = [`${sessionCookieName()}=${encodeURIComponent(token)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAgeSeconds}`];
  if (isProduction()) parts.push('Secure');
  return parts.join('; ');
}

export const clearSessionCookie = () => sessionCookie('', 0);

/** IAM-02: identity is resolved from the session only, never from request input. */
export async function requireSession(req: Request): Promise<ResolvedSession> {
  const s = await resolveSession(getDb(), sessionTokenFrom(req));
  if (!s) throw new DomainError(401, ErrorCode.UNAUTHENTICATED, 'Sign in to continue.');
  return s;
}

export async function requireInvestor(req: Request): Promise<ResolvedSession> {
  const s = await requireSession(req);
  if (s.user.role !== 'INVESTOR') throw new DomainError(403, ErrorCode.FORBIDDEN, 'Only investors have order blocks.');
  return s;
}

export async function requireAdmin(req: Request): Promise<ResolvedSession> {
  const s = await requireSession(req);
  if (s.user.role !== 'ADMIN') throw new DomainError(403, ErrorCode.FORBIDDEN, 'Administrator access required.');
  return s;
}
