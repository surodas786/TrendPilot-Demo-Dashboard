import { hash, verify } from '@node-rs/argon2';
import { and, asc, eq, sql } from 'drizzle-orm';
import { DomainError, ErrorCode } from '@trendpilot/domain';
import type { Executor } from '../client';
import { users } from '../schema';

export type UserRow = typeof users.$inferSelect;

/** Public user shape; never includes the password hash or MFA secrets. */
export interface PublicUser {
  id: string;
  email: string;
  name: string;
  role: UserRow['role'];
  status: UserRow['status'];
  timezone: string;
  mfaEnabled: boolean;
}

export const toPublicUser = (u: UserRow): PublicUser => ({
  id: u.id,
  email: u.email,
  name: u.name,
  role: u.role,
  status: u.status,
  timezone: u.timezone,
  mfaEnabled: u.mfaEnabledAt !== null
});

/** Admin directory row. */
export interface AdminUserDto extends PublicUser {
  createdAt: string;
  suspendedAt: string | null;
  revision: number;
}

export const toAdminUser = (u: UserRow): AdminUserDto => ({
  ...toPublicUser(u),
  createdAt: u.createdAt.toISOString(),
  suspendedAt: u.suspendedAt?.toISOString() ?? null,
  revision: u.revision
});

export const normalizeEmail = (email: string) => email.trim().toLowerCase();

export async function findUserByEmail(db: Executor, email: string): Promise<UserRow | undefined> {
  const [row] = await db.select().from(users).where(eq(users.email, normalizeEmail(email))).limit(1);
  return row;
}

export async function findUserById(db: Executor, id: string): Promise<UserRow | undefined> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return undefined;
  const [row] = await db.select().from(users).where(eq(users.id, id)).limit(1);
  return row;
}

/** Admin-only listing (callers must enforce the role). */
export async function listUsers(db: Executor): Promise<AdminUserDto[]> {
  const rows = await db.select().from(users).orderBy(asc(users.role), asc(users.email));
  return rows.map(toAdminUser);
}

export const hashPassword = (password: string) => hash(password);

/** Returns false for unknown users or users without a password (e.g. invited). */
export async function verifyPassword(user: UserRow | undefined, password: string): Promise<boolean> {
  if (!user?.passwordHash) {
    // Spend comparable time so unknown emails are not distinguishable by latency.
    await hash(password).catch(() => undefined);
    return false;
  }
  return verify(user.passwordHash, password).catch(() => false);
}

/** IAM-01: an admin-created investor with no password until the invite is accepted. */
export async function createInvitedInvestor(db: Executor, input: { name: string; email: string }, invitedBy: string): Promise<UserRow> {
  const [row] = await db
    .insert(users)
    .values({ name: input.name, email: normalizeEmail(input.email), role: 'INVESTOR', status: 'INVITED', invitedBy })
    .onConflictDoNothing({ target: users.email })
    .returning();
  if (!row) throw new DomainError(409, ErrorCode.DUPLICATE, 'A user with this email already exists.');
  return row;
}

export async function setPassword(db: Executor, userId: string, passwordHash: string, activate: boolean): Promise<void> {
  await db
    .update(users)
    .set({ passwordHash, ...(activate ? { status: 'ACTIVE' as const } : {}), revision: sql`${users.revision} + 1`, updatedAt: sql`now()` })
    .where(eq(users.id, userId));
}

/** Status change with optimistic concurrency. */
export async function setUserStatus(db: Executor, userId: string, expectedRevision: number, status: 'ACTIVE' | 'SUSPENDED'): Promise<UserRow | null> {
  const [row] = await db
    .update(users)
    .set({ status, suspendedAt: status === 'SUSPENDED' ? new Date() : null, revision: sql`${users.revision} + 1`, updatedAt: sql`now()` })
    .where(and(eq(users.id, userId), eq(users.revision, expectedRevision)))
    .returning();
  return row ?? null;
}

/* ───────────────────────────── MFA (TOTP) ───────────────────────────── */

export async function setPendingMfaSecret(db: Executor, userId: string, sealed: string | null): Promise<void> {
  await db.update(users).set({ mfaPendingSecretEnc: sealed, updatedAt: sql`now()` }).where(eq(users.id, userId));
}

export async function enableMfa(db: Executor, userId: string, sealed: string, step: number): Promise<void> {
  await db
    .update(users)
    .set({ mfaSecretEnc: sealed, mfaPendingSecretEnc: null, mfaEnabledAt: new Date(), mfaLastStep: step, updatedAt: sql`now()` })
    .where(eq(users.id, userId));
}

export async function disableMfa(db: Executor, userId: string): Promise<void> {
  await db.update(users).set({ mfaSecretEnc: null, mfaPendingSecretEnc: null, mfaEnabledAt: null, mfaLastStep: null, updatedAt: sql`now()` }).where(eq(users.id, userId));
}

/** Records an accepted TOTP step only if it is newer than the last one (replay protection). */
export async function acceptMfaStep(db: Executor, userId: string, step: number): Promise<boolean> {
  const rows = await db
    .update(users)
    .set({ mfaLastStep: step })
    .where(and(eq(users.id, userId), sql`(${users.mfaLastStep} IS NULL OR ${users.mfaLastStep} < ${step})`))
    .returning({ id: users.id });
  return rows.length > 0;
}
