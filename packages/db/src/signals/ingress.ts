import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { Executor } from '../client';
import { webhookIngress } from '../schema';

/**
 * SIG-01 ingress tokens: high-entropy, rotatable, stored only as a SHA-256 verifier plus a
 * non-secret lookup prefix. Comparison is constant-time.
 */
export const INGRESS_TOKEN_PREFIX_LEN = 12;
/** What people may see: 'tvw_' plus 4 characters. The 12-char lookup prefix stays server-side. */
export const tokenHint = (prefix: string) => `${prefix.slice(0, 8)}…`;

export const newIngressToken = () => `tvw_${randomBytes(32).toString('base64url')}`;
const verifier = (token: string) => createHash('sha256').update(token).digest();

export type IngressRow = typeof webhookIngress.$inferSelect;

export async function createIngress(db: Executor, input: { namespace: string; name: string; token?: string; createdBy?: string | null }): Promise<{ ingress: IngressRow; token: string }> {
  const token = input.token ?? newIngressToken();
  const [ingress] = await db
    .insert(webhookIngress)
    .values({
      namespace: input.namespace,
      name: input.name,
      tokenPrefix: token.slice(0, INGRESS_TOKEN_PREFIX_LEN),
      tokenHash: verifier(token).toString('hex'),
      createdBy: input.createdBy ?? null
    })
    .returning();
  return { ingress: ingress!, token };
}

/** Returns the ingress for a presented token, or null. Never logs or stores the token. */
export async function verifyIngressToken(db: Executor, token: string | undefined): Promise<IngressRow | null> {
  if (!token || token.length < 20 || token.length > 200) return null;
  const candidates = await db.select().from(webhookIngress).where(eq(webhookIngress.tokenPrefix, token.slice(0, INGRESS_TOKEN_PREFIX_LEN)));
  const presented = verifier(token);
  let match: IngressRow | null = null;
  for (const c of candidates) {
    // Constant-time comparison of equal-length digests; keep scanning to avoid early exit.
    if (timingSafeEqual(Buffer.from(c.tokenHash, 'hex'), presented)) match = c;
  }
  return match;
}

/** Rotation keeps the namespace (and therefore SIG-05 dedupe keys) and invalidates the old token. */
export async function rotateIngressToken(db: Executor, id: string): Promise<{ token: string; ingress: IngressRow } | null> {
  const token = newIngressToken();
  const [ingress] = await db
    .update(webhookIngress)
    .set({ tokenPrefix: token.slice(0, INGRESS_TOKEN_PREFIX_LEN), tokenHash: verifier(token).toString('hex'), rotatedAt: new Date() })
    .where(eq(webhookIngress.id, id))
    .returning();
  return ingress ? { token, ingress } : null;
}

export async function listIngress(db: Executor) {
  const rows = await db.select().from(webhookIngress);
  return rows.map((r) => ({ id: r.id, namespace: r.namespace, name: r.name, tokenHint: tokenHint(r.tokenPrefix), rotatedAt: r.rotatedAt?.toISOString() ?? null, createdAt: r.createdAt.toISOString() }));
}
