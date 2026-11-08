import { createHash, randomBytes } from 'node:crypto';
import { and, desc, eq, gt, isNull, ne } from 'drizzle-orm';
import type { Executor } from '../client';
import { sessions, users } from '../schema';
import { toPublicUser, type PublicUser, type UserRow } from './users';

export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

export interface CreateSessionOptions {
  stage?: 'ACTIVE' | 'MFA_PENDING';
  userAgent?: string | null;
}

export async function createSession(db: Executor, userId: string, ttlHours: number, opts: CreateSessionOptions = {}): Promise<{ token: string; expiresAt: Date; id: string }> {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + ttlHours * 3_600_000);
  const [row] = await db
    .insert(sessions)
    .values({ userId, tokenHash: hashToken(token), expiresAt, stage: opts.stage ?? 'ACTIVE', userAgent: opts.userAgent?.slice(0, 300) ?? null })
    .returning({ id: sessions.id });
  return { token, expiresAt, id: row!.id };
}

export interface ResolvedSession {
  sessionId: string;
  user: PublicUser;
}

const live = (token: string) => and(eq(sessions.tokenHash, hashToken(token)), isNull(sessions.revokedAt), gt(sessions.expiresAt, new Date()));

/** IAM-02: identity comes only from an unexpired, unrevoked, fully authenticated session of an ACTIVE user. */
export async function resolveSession(db: Executor, token: string | undefined): Promise<ResolvedSession | null> {
  if (!token || token.length > 200) return null;
  const [row] = await db
    .select({ sessionId: sessions.id, stage: sessions.stage, user: users })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(live(token))
    .limit(1);
  if (!row || row.stage !== 'ACTIVE' || row.user.status !== 'ACTIVE') return null;
  return { sessionId: row.sessionId, user: toPublicUser(row.user) };
}

/** A password-verified session still waiting for its TOTP code. */
export async function resolveMfaChallenge(db: Executor, token: string | undefined): Promise<{ sessionId: string; user: UserRow } | null> {
  if (!token || token.length > 200) return null;
  const [row] = await db
    .select({ sessionId: sessions.id, stage: sessions.stage, user: users })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(live(token))
    .limit(1);
  if (!row || row.stage !== 'MFA_PENDING' || row.user.status !== 'ACTIVE') return null;
  return { sessionId: row.sessionId, user: row.user };
}

export async function revokeSession(db: Executor, token: string): Promise<void> {
  await db
    .update(sessions)
    .set({ revokedAt: new Date() })
    .where(and(eq(sessions.tokenHash, hashToken(token)), isNull(sessions.revokedAt)));
}

export interface SessionDto {
  id: string;
  createdAt: string;
  expiresAt: string;
  lastSeenAt: string;
  userAgent: string | null;
  current: boolean;
}

/** Active sessions of one user (never another user's). */
export async function listSessions(db: Executor, userId: string, currentSessionId?: string): Promise<SessionDto[]> {
  const rows = await db
    .select()
    .from(sessions)
    .where(and(eq(sessions.userId, userId), eq(sessions.stage, 'ACTIVE'), isNull(sessions.revokedAt), gt(sessions.expiresAt, new Date())))
    .orderBy(desc(sessions.createdAt));
  return rows.map((r) => ({
    id: r.id,
    createdAt: r.createdAt.toISOString(),
    expiresAt: r.expiresAt.toISOString(),
    lastSeenAt: r.lastSeenAt.toISOString(),
    userAgent: r.userAgent,
    current: r.id === currentSessionId
  }));
}

/** Revokes one of the user's own sessions. Returns false for unknown or unowned IDs. */
export async function revokeSessionById(db: Executor, userId: string, sessionId: string): Promise<boolean> {
  if (!/^[0-9a-f-]{36}$/i.test(sessionId)) return false;
  const rows = await db
    .update(sessions)
    .set({ revokedAt: new Date() })
    .where(and(eq(sessions.id, sessionId), eq(sessions.userId, userId), isNull(sessions.revokedAt)))
    .returning({ id: sessions.id });
  return rows.length > 0;
}

/** Revokes every session of a user, optionally keeping one (e.g. the caller's). */
export async function revokeAllSessions(db: Executor, userId: string, exceptSessionId?: string): Promise<number> {
  const rows = await db
    .update(sessions)
    .set({ revokedAt: new Date() })
    .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt), exceptSessionId ? ne(sessions.id, exceptSessionId) : undefined))
    .returning({ id: sessions.id });
  return rows.length;
}
