import { and, desc, eq, like, sql } from 'drizzle-orm';
import type { Executor } from '../client';
import { auditEvents, users } from '../schema';

export interface AuditInput {
  actorUserId: string | null;
  action: string;
  targetType: string;
  targetId?: string | null;
  result: 'SUCCESS' | 'DENIED' | 'FAILED';
  before?: unknown;
  after?: unknown;
  metadata?: Record<string, unknown>;
  correlationId: string;
}

/** Append-only (OPS-04, DB trigger). Callers pass redacted data; never secrets or passwords. */
export async function recordAudit(db: Executor, e: AuditInput): Promise<void> {
  await db.insert(auditEvents).values({
    actorUserId: e.actorUserId,
    action: e.action,
    targetType: e.targetType,
    targetId: e.targetId ?? null,
    result: e.result,
    before: e.before ?? null,
    after: e.after ?? null,
    metadata: e.metadata ?? null,
    correlationId: e.correlationId
  });
}

export interface AuditEventDto {
  id: string;
  at: string;
  actor: { id: string; email: string; name: string } | null;
  action: string;
  targetType: string;
  targetId: string | null;
  result: string;
  before: unknown;
  after: unknown;
  metadata: unknown;
  correlationId: string;
}

/** Opaque cursor: "<iso time>|<id>". */
const encodeCursor = (at: Date, id: string) => Buffer.from(`${at.toISOString()}|${id}`).toString('base64url');
function decodeCursor(c: string): { at: Date; id: string } | null {
  try {
    const [iso, id] = Buffer.from(c, 'base64url').toString('utf8').split('|');
    const at = new Date(iso ?? '');
    return id && !Number.isNaN(at.getTime()) ? { at, id } : null;
  } catch {
    return null;
  }
}

const msTime = sql`date_trunc('milliseconds', ${auditEvents.createdAt})`;

/** Admin-only. Newest first, cursor-paginated, optional action prefix filter. */
export async function listAudit(db: Executor, opts: { cursor?: string; limit?: number; actionPrefix?: string } = {}): Promise<{ items: AuditEventDto[]; nextCursor: string | null }> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const cur = opts.cursor ? decodeCursor(opts.cursor) : null;
  const prefix = opts.actionPrefix?.replace(/[^A-Z_]/g, '');
  const rows = await db
    .select({ e: auditEvents, actorEmail: users.email, actorName: users.name })
    .from(auditEvents)
    .leftJoin(users, eq(users.id, auditEvents.actorUserId))
    .where(
      and(
        // Compare at millisecond precision: the cursor carries a JS (ms) timestamp.
        cur ? sql`(${msTime}, ${auditEvents.id}) < (${cur.at.toISOString()}::timestamptz, ${cur.id}::uuid)` : undefined,
        prefix ? like(auditEvents.action, `${prefix}%`) : undefined
      )
    )
    .orderBy(desc(msTime), desc(auditEvents.id))
    .limit(limit + 1);
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    items: page.map(({ e, actorEmail, actorName }) => ({
      id: e.id,
      at: e.createdAt.toISOString(),
      actor: e.actorUserId && actorEmail ? { id: e.actorUserId, email: actorEmail, name: actorName ?? '' } : null,
      action: e.action,
      targetType: e.targetType,
      targetId: e.targetId,
      result: e.result,
      before: e.before,
      after: e.after,
      metadata: e.metadata,
      correlationId: e.correlationId
    })),
    nextCursor: rows.length > limit && last ? encodeCursor(last.e.createdAt, last.e.id) : null
  };
}
