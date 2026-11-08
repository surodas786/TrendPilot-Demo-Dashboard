import { randomBytes } from 'node:crypto';
import { and, eq, gt, isNull } from 'drizzle-orm';
import type { Executor } from '../client';
import { userTokens } from '../schema';
import { hashToken } from './sessions';

export type TokenKind = 'INVITE' | 'RESET';

/**
 * IAM-01: issue a single-use link token. Only its SHA-256 hash is stored. Any earlier
 * unused link of the same kind for the user is superseded so only the newest works.
 */
export async function issueToken(db: Executor, userId: string, kind: TokenKind, ttlMs: number, createdBy: string | null): Promise<{ token: string; expiresAt: Date }> {
  await db
    .update(userTokens)
    .set({ supersededAt: new Date() })
    .where(and(eq(userTokens.userId, userId), eq(userTokens.kind, kind), isNull(userTokens.usedAt), isNull(userTokens.supersededAt)));
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + ttlMs);
  await db.insert(userTokens).values({ userId, kind, tokenHash: hashToken(token), expiresAt, createdBy });
  return { token, expiresAt };
}

const usable = (token: string, kind: TokenKind) =>
  and(eq(userTokens.tokenHash, hashToken(token)), eq(userTokens.kind, kind), isNull(userTokens.usedAt), isNull(userTokens.supersededAt), gt(userTokens.expiresAt, new Date()));

/** Checks a link without consuming it (to render the form). */
export async function peekToken(db: Executor, token: string, kind: TokenKind): Promise<{ userId: string } | null> {
  const [row] = await db.select({ userId: userTokens.userId }).from(userTokens).where(usable(token, kind)).limit(1);
  return row ?? null;
}

/** Atomically consumes a link: succeeds once, then never again. */
export async function consumeToken(db: Executor, token: string, kind: TokenKind): Promise<{ userId: string } | null> {
  const [row] = await db.update(userTokens).set({ usedAt: new Date() }).where(usable(token, kind)).returning({ userId: userTokens.userId });
  return row ?? null;
}

/** Revokes every outstanding link of a kind (e.g. on suspension). */
export async function supersedeTokens(db: Executor, userId: string, kind?: TokenKind): Promise<void> {
  await db
    .update(userTokens)
    .set({ supersededAt: new Date() })
    .where(and(eq(userTokens.userId, userId), isNull(userTokens.usedAt), isNull(userTokens.supersededAt), kind ? eq(userTokens.kind, kind) : undefined));
}
