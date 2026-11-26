import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import {
  DomainError,
  ErrorCode,
  exitPlanChanges,
  TRAILING_OFF,
  type CommonExitDefinition,
  type EffectiveExitPlanDto,
  type ExitApplyScope,
  type ExitPlanSettings,
  type TakeProfitSettings,
  type TrailingSideSettings
} from '@trendpilot/domain';
import type { Db, Executor } from '../client';
import { commonExitDefinitions, instruments, orderBlocks, positions, userNotifications, users } from '../schema';
import { applyExitPlanToPosition, type ExitPlanApplyOutcome } from '../paper/exitPlanApply';
import { recordAudit } from './audit';

/**
 * Admin → Common Exit Definition. Published revisions are append-only; the highest version is the
 * current rule. Order blocks with "Sync Admin Setting" resolve their effective exit plan from it at
 * read and entry time (no copy is written into the block), so a publish reaches every linked block
 * at once and the block's own (custom) plan is preserved for when sync is turned off.
 */

/** Postgres NOTIFY channel announcing a newly published Common Exit Definition (payload: { version }). */
export const EXIT_DEFINITION_NOTIFY_CHANNEL = 'exit_definition';

export interface CommonExitRevisionDto {
  version: number;
  plan: CommonExitDefinition;
  changes: { field: string; before: unknown; after: unknown }[];
  scope: ExitApplyScope;
  note: string | null;
  applyResult: ExitPlanApplyOutcome[] | null;
  author: { id: string; name: string; email: string };
  publishedAt: string;
}

type DefRow = typeof commonExitDefinitions.$inferSelect;

const toDto = (r: DefRow, a: { id: string; name: string; email: string }): CommonExitRevisionDto => ({
  version: r.version,
  plan: r.plan as CommonExitDefinition,
  changes: (r.changes as CommonExitRevisionDto['changes']) ?? [],
  scope: r.scope as ExitApplyScope,
  note: r.note,
  applyResult: (r.applyResult as ExitPlanApplyOutcome[] | null) ?? null,
  author: a,
  publishedAt: r.publishedAt.toISOString()
});

export async function listCommonExitRevisions(db: Executor, limit = 20): Promise<CommonExitRevisionDto[]> {
  const rows = await db
    .select({ d: commonExitDefinitions, id: users.id, name: users.name, email: users.email })
    .from(commonExitDefinitions)
    .innerJoin(users, eq(users.id, commonExitDefinitions.authorId))
    .orderBy(desc(commonExitDefinitions.version))
    .limit(limit);
  return rows.map((r) => toDto(r.d, r));
}

/** The current (latest published) Common Exit Definition, or null when none is published. */
export async function latestCommonExit(db: Executor): Promise<CommonExitRevisionDto | null> {
  return (await listCommonExitRevisions(db, 1))[0] ?? null;
}

/** Normalises a stored side (rows saved before a field existed) to the current shape. */
const tpOf = (v: unknown): TakeProfitSettings => v as TakeProfitSettings;
const trOf = (v: unknown): TrailingSideSettings => ({ ...TRAILING_OFF, ...((v as Partial<TrailingSideSettings>) ?? {}) });

/** The block's own exit plan as stored. */
export function customExitPlanOf(b: { takeProfitLong: unknown; takeProfitShort: unknown; trailingLong: unknown; trailingShort: unknown }): ExitPlanSettings {
  return { takeProfitLong: tpOf(b.takeProfitLong), takeProfitShort: tpOf(b.takeProfitShort), trailingLong: trOf(b.trailingLong), trailingShort: trOf(b.trailingShort) };
}

/**
 * What entries of a block use. Sync on with a published rule: the admin plan (inheritance is
 * enforced here, server-side, whatever the block's own columns hold). Sync on without a published
 * rule: the block's own plan, flagged `adminUnavailable`.
 */
export function effectiveExitPlan(
  b: { syncAdminExit: boolean; takeProfitLong: unknown; takeProfitShort: unknown; trailingLong: unknown; trailingShort: unknown },
  admin: Pick<CommonExitRevisionDto, 'version' | 'plan' | 'publishedAt'> | null
): EffectiveExitPlanDto {
  if (b.syncAdminExit && admin) return { ...customExitPlanOf(admin.plan), source: 'ADMIN', adminVersion: admin.version, adminPublishedAt: admin.publishedAt };
  return { ...customExitPlanOf(b), source: 'CUSTOM', adminVersion: null, adminPublishedAt: null, ...(b.syncAdminExit ? { adminUnavailable: true } : {}) };
}

/* ───────────────────────── notifications ───────────────────────── */

export interface NotificationDto {
  id: string;
  kind: string;
  title: string;
  body: string;
  data: unknown;
  readAt: string | null;
  createdAt: string;
}

export async function notify(db: Executor, n: { userId: string; kind: string; title: string; body: string; data?: unknown; dedupeKey?: string | null }): Promise<void> {
  await db
    .insert(userNotifications)
    .values({ userId: n.userId, kind: n.kind, title: n.title, body: n.body, data: n.data ?? null, dedupeKey: n.dedupeKey ?? null })
    .onConflictDoNothing();
}

/** IAM-02: a user's own notifications only. */
export function notificationsFor(db: Executor, userId: string) {
  return {
    async list(limit = 20): Promise<NotificationDto[]> {
      const rows = await db.select().from(userNotifications).where(eq(userNotifications.userId, userId)).orderBy(desc(userNotifications.createdAt)).limit(limit);
      return rows.map((r) => ({ id: r.id, kind: r.kind, title: r.title, body: r.body, data: r.data, readAt: r.readAt?.toISOString() ?? null, createdAt: r.createdAt.toISOString() }));
    },
    async markRead(ids: string[] | 'ALL'): Promise<number> {
      const rows = await db
        .update(userNotifications)
        .set({ readAt: sql`now()` })
        .where(and(eq(userNotifications.userId, userId), isNull(userNotifications.readAt), ...(ids === 'ALL' ? [] : [inArray(userNotifications.id, ids.length ? ids : ['00000000-0000-0000-0000-000000000000'])])))
        .returning({ id: userNotifications.id });
      return rows.length;
    }
  };
}

/* ───────────────────────── publish ───────────────────────── */

/** Linked (synced, not archived) order blocks and their open positions. */
export async function linkedExposure(db: Executor) {
  const blocks = await db
    .select({ id: orderBlocks.id, ownerId: orderBlocks.ownerId, mode: orderBlocks.mode, symbol: instruments.symbol, exchange: instruments.exchange, ownerName: users.name })
    .from(orderBlocks)
    .innerJoin(instruments, eq(instruments.id, orderBlocks.instrumentId))
    .innerJoin(users, eq(users.id, orderBlocks.ownerId))
    .where(and(eq(orderBlocks.syncAdminExit, true), isNull(orderBlocks.archivedAt)));
  const ids = blocks.map((b) => b.id);
  const open = ids.length
    ? await db
        .select({ p: positions, symbol: instruments.symbol, exchange: instruments.exchange, ownerName: users.name })
        .from(positions)
        .innerJoin(instruments, eq(instruments.id, positions.instrumentId))
        .innerJoin(users, eq(users.id, positions.ownerId))
        .where(and(inArray(positions.orderBlockId, ids), eq(positions.status, 'OPEN')))
    : [];
  return { blocks, open };
}

export interface PublishInput {
  plan: CommonExitDefinition;
  scope: ExitApplyScope;
  expectedVersion: number | null;
  note?: string;
  authorId: string;
  correlationId: string;
  now: Date;
}

export interface PublishResult {
  revision: CommonExitRevisionDto;
  linkedBlocks: number;
  notifiedInvestors: number;
  positions: ExitPlanApplyOutcome[];
}

/**
 * Publishes a new revision (one transaction): version check, revision row, linked blocks bumped
 * (open editors see a revision change), optional application to linked open positions (each one
 * atomically; skipped positions are listed with their reason), audit event, investor
 * notifications, and a NOTIFY so open screens refresh. The worker reads the effective plan at
 * entry time and holds no exit-plan cache, so nothing else needs invalidating.
 */
export async function publishCommonExit(db: Db, input: PublishInput): Promise<PublishResult> {
  return db.transaction(async (tx) => {
    // Serialise publishers.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('common_exit_definitions'))`);
    const [prev] = await tx.select().from(commonExitDefinitions).orderBy(desc(commonExitDefinitions.version)).limit(1);
    const current = prev?.version ?? 0;
    if ((input.expectedVersion ?? 0) !== current) {
      throw new DomainError(409, ErrorCode.REVISION_CONFLICT, `The Common Exit Definition changed (now version ${current}). Reload it before publishing.`);
    }
    const version = current + 1;
    const changes = exitPlanChanges(prev ? (prev.plan as ExitPlanSettings) : null, input.plan);
    const { blocks, open } = await linkedExposure(tx);

    let outcomes: ExitPlanApplyOutcome[] = [];
    if (input.scope === 'EXISTING_POSITIONS') {
      for (const o of open) {
        outcomes.push(await applyExitPlanToPosition(tx, o.p.id, input.plan, { version, now: input.now }));
      }
    } else {
      outcomes = [];
    }

    const [row] = await tx
      .insert(commonExitDefinitions)
      .values({ version, plan: input.plan, changes, scope: input.scope, note: input.note ?? null, applyResult: input.scope === 'EXISTING_POSITIONS' ? outcomes : null, authorId: input.authorId, publishedAt: input.now })
      .returning();
    if (blocks.length) {
      await tx
        .update(orderBlocks)
        .set({ revision: sql`${orderBlocks.revision} + 1`, updatedAt: sql`now()` })
        .where(inArray(orderBlocks.id, blocks.map((b) => b.id)));
    }

    const owners = [...new Set(blocks.map((b) => b.ownerId))];
    for (const ownerId of owners) {
      const mine = blocks.filter((b) => b.ownerId === ownerId);
      const theirOutcomes = outcomes.filter((o) => o.ownerId === ownerId);
      const applied = theirOutcomes.filter((o) => o.status === 'APPLIED').length;
      const skipped = theirOutcomes.filter((o) => o.status === 'SKIPPED').length;
      const scopeText =
        input.scope === 'EXISTING_POSITIONS'
          ? ` It was also applied to your open positions: ${applied} updated${skipped ? `, ${skipped} kept on their previous plan (see the position for the reason)` : ''}.`
          : ' Open positions keep the exit plan they were opened with; new entries use the new rule.';
      await notify(tx, {
        userId: ownerId,
        kind: 'COMMON_EXIT_DEFINITION',
        title: `Admin exit rule updated to version ${version}`,
        body: `Your order block(s) ${mine.map((b) => `${b.symbol} · ${b.mode === 'LIVE' ? 'Live' : 'Paper'}`).join(', ')} follow the admin Common Exit Definition (Sync Admin Setting).${scopeText}`,
        data: { version, scope: input.scope, blockIds: mine.map((b) => b.id), changes: changes.map((c) => c.field) },
        dedupeKey: `common-exit:${version}`
      });
    }

    const [author] = await tx.select({ id: users.id, name: users.name, email: users.email }).from(users).where(eq(users.id, input.authorId));
    await recordAudit(tx, {
      actorUserId: input.authorId,
      action: 'common_exit_definition.publish',
      targetType: 'common_exit_definition',
      targetId: String(version),
      result: 'SUCCESS',
      before: prev ? { version: prev.version, plan: prev.plan } : null,
      after: { version, plan: input.plan },
      metadata: {
        version,
        scope: input.scope,
        note: input.note ?? null,
        changes,
        linkedBlocks: blocks.length,
        notifiedInvestors: owners.length,
        positions: outcomes.map((o) => ({ positionId: o.positionId, status: o.status, reason: o.reason ?? null }))
      },
      correlationId: input.correlationId
    });
    await tx.execute(sql`select pg_notify(${EXIT_DEFINITION_NOTIFY_CHANNEL}, ${JSON.stringify({ version })})`);
    return { revision: toDto(row!, author!), linkedBlocks: blocks.length, notifiedInvestors: owners.length, positions: outcomes };
  });
}
