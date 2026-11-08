import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { getDb, resolveSession, type ResolvedSession } from '@trendpilot/db';
import { sessionCookieName } from './session';

/** Session for server components. Never trusts anything but the session cookie. */
export async function pageSession(): Promise<ResolvedSession | null> {
  const token = (await cookies()).get(sessionCookieName())?.value;
  return resolveSession(getDb(), token);
}

export const homeFor = (role: 'ADMIN' | 'INVESTOR') => (role === 'ADMIN' ? '/admin' : '/trade-settings');

export async function requirePageRole(role: 'ADMIN' | 'INVESTOR'): Promise<ResolvedSession> {
  const s = await pageSession();
  if (!s) redirect('/sign-in');
  if (s.user.role !== role) redirect(homeFor(s.user.role));
  return s;
}
