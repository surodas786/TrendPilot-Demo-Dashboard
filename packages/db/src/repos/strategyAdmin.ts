import { and, count, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import type { Executor } from '../client';
import { orderBlocks, positions, signalDecisions, signalEvents, signalRoutes, strategyPackages, strategyVersionInstruments, strategyVersions } from '../schema';

/**
 * CFG-02 package maintenance: rename, archive/restore, delete unused drafts and never-published
 * packages. The web layer locks the package row, checks these dependency counts and audits.
 */

export type PackageRow = typeof strategyPackages.$inferSelect;

export async function lockPackage(db: Executor, id: string): Promise<PackageRow | null> {
  const [row] = await db.select().from(strategyPackages).where(eq(strategyPackages.id, id)).for('update');
  return row ?? null;
}

const n = (rows: { n: number }[]) => Number(rows[0]?.n ?? 0);

/** Investor settings, signal decisions and positions that reference these versions. */
export async function versionDependencies(db: Executor, versionIds: string[]): Promise<{ orderBlocks: number; openPositions: number; positions: number; decisions: number }> {
  if (!versionIds.length) return { orderBlocks: 0, openPositions: 0, positions: 0, decisions: 0 };
  // Sequential: inside a transaction all queries share one connection.
  const b = await db.select({ n: count() }).from(orderBlocks).where(inArray(orderBlocks.strategyVersionId, versionIds));
  const op = await db.select({ n: count() }).from(positions).where(and(inArray(positions.strategyVersionId, versionIds), eq(positions.status, 'OPEN')));
  const p = await db.select({ n: count() }).from(positions).where(inArray(positions.strategyVersionId, versionIds));
  const d = await db.select({ n: count() }).from(signalDecisions).where(inArray(signalDecisions.strategyVersionId, versionIds));
  return { orderBlocks: n(b), openPositions: n(op), positions: n(p), decisions: n(d) };
}

export interface PackageDependencies {
  versions: number;
  publishedVersions: number;
  routes: number;
  enabledRoutes: number;
  signalEvents: number;
  orderBlocks: number;
  openPositions: number;
  positions: number;
  decisions: number;
}

export async function packageDependencies(db: Executor, packageId: string): Promise<PackageDependencies> {
  const vs = await db.select({ id: strategyVersions.id, publishedAt: strategyVersions.publishedAt }).from(strategyVersions).where(eq(strategyVersions.packageId, packageId));
  const r = await db.select({ n: count() }).from(signalRoutes).where(eq(signalRoutes.packageId, packageId));
  const er = await db.select({ n: count() }).from(signalRoutes).where(and(eq(signalRoutes.packageId, packageId), eq(signalRoutes.enabled, true)));
  const e = await db.select({ n: count() }).from(signalEvents).where(eq(signalEvents.packageId, packageId));
  const deps = await versionDependencies(db, vs.map((v) => v.id));
  return { versions: vs.length, publishedVersions: vs.filter((v) => v.publishedAt).length, routes: n(r), enabledRoutes: n(er), signalEvents: n(e), ...deps };
}

export async function renamePackage(db: Executor, id: string, revision: number, name: string): Promise<PackageRow | null> {
  const [row] = await db
    .update(strategyPackages)
    .set({ name, revision: sql`${strategyPackages.revision} + 1` })
    .where(and(eq(strategyPackages.id, id), eq(strategyPackages.revision, revision)))
    .returning();
  return row ?? null;
}

export async function setPackageArchived(db: Executor, id: string, revision: number, archived: boolean, by: string): Promise<PackageRow | null> {
  const [row] = await db
    .update(strategyPackages)
    .set({ archivedAt: archived ? sql`now()` : null, archivedBy: archived ? by : null, revision: sql`${strategyPackages.revision} + 1` })
    .where(and(eq(strategyPackages.id, id), eq(strategyPackages.revision, revision)))
    .returning();
  return row ?? null;
}

/** Deletes an unpublished draft and its pair mappings (the immutability trigger allows drafts only). */
export async function deleteDraftVersion(db: Executor, id: string, revision: number): Promise<boolean> {
  await db.delete(strategyVersionInstruments).where(eq(strategyVersionInstruments.versionId, id));
  const rows = await db
    .delete(strategyVersions)
    .where(and(eq(strategyVersions.id, id), eq(strategyVersions.revision, revision), isNull(strategyVersions.publishedAt)))
    .returning({ id: strategyVersions.id });
  return rows.length > 0;
}

/** Deletes a never-published package with its drafts. The caller has checked dependencies. */
export async function deleteUnpublishedPackage(db: Executor, id: string, revision: number): Promise<boolean> {
  const [published] = await db.select({ id: strategyVersions.id }).from(strategyVersions).where(and(eq(strategyVersions.packageId, id), isNotNull(strategyVersions.publishedAt))).limit(1);
  if (published) return false;
  const drafts = await db.select({ id: strategyVersions.id }).from(strategyVersions).where(eq(strategyVersions.packageId, id));
  if (drafts.length) {
    await db.delete(strategyVersionInstruments).where(inArray(strategyVersionInstruments.versionId, drafts.map((d) => d.id)));
    await db.delete(strategyVersions).where(eq(strategyVersions.packageId, id));
  }
  const rows = await db.delete(strategyPackages).where(and(eq(strategyPackages.id, id), eq(strategyPackages.revision, revision))).returning({ id: strategyPackages.id });
  return rows.length > 0;
}
