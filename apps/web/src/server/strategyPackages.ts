import {
  deleteDraftVersion,
  deleteUnpublishedPackage,
  getDb,
  getVersion,
  lockPackage,
  packageDependencies,
  recordAudit,
  renamePackage,
  setPackageArchived,
  versionDependencies,
  type PackageDependencies,
  type PublicUser
} from '@trendpilot/db';
import { DomainError, ErrorCode, notFound, packageCreateSchema, parseWith } from '@trendpilot/domain';
import { validationError } from './http';

/**
 * CFG-02 package maintenance, enforced server-side: rename (ID and everything referencing it are
 * unchanged), archive/restore, and deletion of unused drafts and never-published packages. Each
 * write locks the package row, checks dependencies, and is audited (blocked attempts as DENIED).
 */

const stale = () => new DomainError(409, ErrorCode.REVISION_CONFLICT, 'This package changed since you loaded it. Reload and try again.');
const blocked = (message: string) => new DomainError(409, ErrorCode.CONFLICT, message);

async function denied(admin: PublicUser, action: string, targetType: string, id: string, reason: string, correlationId: string, detail: object = {}) {
  await recordAudit(getDb(), { actorUserId: admin.id, action, targetType, targetId: id, result: 'DENIED', metadata: { reason, ...detail }, correlationId });
}

const plural = (k: number, one: string, many = `${one}s`) => `${k} ${k === 1 ? one : many}`;

/** What still uses a package, in words, for archive and delete refusals. */
function dependencyList(d: PackageDependencies, o: { forDelete: boolean }): string[] {
  const out: string[] = [];
  if (o.forDelete ? d.routes : d.enabledRoutes) out.push(`${plural(o.forDelete ? d.routes : d.enabledRoutes, o.forDelete ? 'signal route' : 'enabled signal route')} (${o.forDelete ? 'delete' : 'disable'} or re-point ${o.forDelete ? 'them' : 'them in TradingView Webhook & Routes'})`);
  if (d.orderBlocks) out.push(`${plural(d.orderBlocks, 'investor order block')} using one of its versions (investors must switch or delete those blocks)`);
  if (d.openPositions) out.push(`${plural(d.openPositions, 'open position')} (close them first)`);
  if (o.forDelete) {
    if (d.signalEvents) out.push(`${plural(d.signalEvents, 'recorded signal event')} (history must stay traceable)`);
    if (d.decisions) out.push(`${plural(d.decisions, 'recorded signal decision')} (history must stay traceable)`);
    if (d.positions && !d.openPositions) out.push(`${plural(d.positions, 'closed position')} in the paper ledger`);
  }
  return out;
}

/** New routes, drafts, publishes and investor selections are refused for an archived package. */
export async function assertPackageActive(packageId: string, path = 'packageId'): Promise<void> {
  const pkg = await getDb().query.strategyPackages.findFirst({ where: (p, { eq }) => eq(p.id, packageId) });
  if (!pkg) throw notFound();
  if (pkg.archivedAt) throw validationError([{ path, message: `“${pkg.name}” is archived. Restore it before using it for new routes, drafts or investor settings.` }]);
}

export async function renameStrategyPackage(admin: PublicUser, id: string, revision: number, raw: unknown, correlationId: string) {
  const r = parseWith(packageCreateSchema, raw);
  if (!r.ok) throw validationError(r.issues);
  return getDb().transaction(async (tx) => {
    const before = await lockPackage(tx, id);
    if (!before) throw notFound();
    if (before.revision !== revision) throw stale();
    const after = await renamePackage(tx, id, revision, r.value.name);
    if (!after) throw stale();
    await recordAudit(tx, { actorUserId: admin.id, action: 'ADMIN_STRATEGY_PACKAGE_RENAME', targetType: 'strategy_package', targetId: id, result: 'SUCCESS', before: { name: before.name }, after: { name: after.name }, correlationId });
    return { id, name: after.name, revision: after.revision };
  });
}

export async function archiveStrategyPackage(admin: PublicUser, id: string, revision: number, correlationId: string) {
  const out = await getDb().transaction(async (tx) => {
    const pkg = await lockPackage(tx, id);
    if (!pkg) throw notFound();
    if (pkg.revision !== revision) throw stale();
    if (pkg.archivedAt) return { done: { id, archived: true, revision: pkg.revision } };
    const deps = await packageDependencies(tx, id);
    if (!deps.publishedVersions) return { refuse: `“${pkg.name}” has never been published. Delete it instead of archiving it.`, reason: 'NEVER_PUBLISHED', deps };
    const what = dependencyList(deps, { forDelete: false });
    if (what.length) return { refuse: `“${pkg.name}” cannot be archived yet. Still depending on it: ${what.join('; ')}.`, reason: 'IN_USE', deps };
    const after = await setPackageArchived(tx, id, revision, true, admin.id);
    if (!after) throw stale();
    await recordAudit(tx, { actorUserId: admin.id, action: 'ADMIN_STRATEGY_PACKAGE_ARCHIVE', targetType: 'strategy_package', targetId: id, result: 'SUCCESS', before: { archived: false }, after: { archived: true, name: pkg.name }, metadata: { versions: deps.versions }, correlationId });
    return { done: { id, archived: true, revision: after.revision } };
  });
  if ('refuse' in out) {
    await denied(admin, 'ADMIN_STRATEGY_PACKAGE_ARCHIVE', 'strategy_package', id, out.reason!, correlationId, out.deps!);
    throw blocked(out.refuse!);
  }
  return out.done!;
}

export async function restoreStrategyPackage(admin: PublicUser, id: string, revision: number, correlationId: string) {
  return getDb().transaction(async (tx) => {
    const pkg = await lockPackage(tx, id);
    if (!pkg) throw notFound();
    if (pkg.revision !== revision) throw stale();
    if (!pkg.archivedAt) return { id, archived: false, revision: pkg.revision };
    const after = await setPackageArchived(tx, id, revision, false, admin.id);
    if (!after) throw stale();
    await recordAudit(tx, { actorUserId: admin.id, action: 'ADMIN_STRATEGY_PACKAGE_RESTORE', targetType: 'strategy_package', targetId: id, result: 'SUCCESS', before: { archived: true }, after: { archived: false, name: pkg.name }, correlationId });
    return { id, archived: false, revision: after.revision };
  });
}

/** Permanent deletion of a package that was never published and that nothing references. */
export async function deleteStrategyPackage(admin: PublicUser, id: string, revision: number, correlationId: string) {
  const out = await getDb().transaction(async (tx) => {
    const pkg = await lockPackage(tx, id);
    if (!pkg) throw notFound();
    if (pkg.revision !== revision) throw stale();
    const deps = await packageDependencies(tx, id);
    if (deps.publishedVersions) {
      return { refuse: `“${pkg.name}” has ${plural(deps.publishedVersions, 'published version')}. Published versions are permanent history and cannot be deleted; archive the package to hide it from new selections.`, reason: 'PUBLISHED', deps };
    }
    const what = dependencyList(deps, { forDelete: true });
    if (what.length) return { refuse: `“${pkg.name}” cannot be deleted. Still depending on it: ${what.join('; ')}.`, reason: 'IN_USE', deps };
    if (!(await deleteUnpublishedPackage(tx, id, revision))) throw stale();
    await recordAudit(tx, { actorUserId: admin.id, action: 'ADMIN_STRATEGY_PACKAGE_DELETE', targetType: 'strategy_package', targetId: id, result: 'SUCCESS', before: { name: pkg.name, drafts: deps.versions }, correlationId });
    return { done: true };
  });
  if ('refuse' in out) {
    await denied(admin, 'ADMIN_STRATEGY_PACKAGE_DELETE', 'strategy_package', id, out.reason!, correlationId, out.deps!);
    throw blocked(out.refuse!);
  }
}

/** Permanent deletion of an unpublished draft that nothing references. Published versions are refused. */
export async function deleteStrategyDraft(admin: PublicUser, id: string, revision: number, correlationId: string) {
  const v = await getVersion(getDb(), id);
  if (!v) throw notFound();
  if (v.published) {
    await denied(admin, 'ADMIN_STRATEGY_DRAFT_DELETE', 'strategy_version', id, 'PUBLISHED', correlationId, { version: v.version });
    throw new DomainError(
      409,
      ErrorCode.IMMUTABLE,
      `v${v.version} of “${v.packageName}” is published. Published versions are permanent history (investor settings and signals stay pinned to them) and cannot be deleted. Archive the package to hide it from new selections.`
    );
  }
  const out = await getDb().transaction(async (tx) => {
    await lockPackage(tx, v.packageId);
    const deps = await versionDependencies(tx, [id]);
    if (deps.orderBlocks || deps.decisions || deps.positions) return { refuse: `Draft v${v.version} is referenced by ${deps.orderBlocks} order block(s), ${deps.decisions} signal decision(s) and ${deps.positions} position(s); it cannot be deleted.`, deps };
    if (!(await deleteDraftVersion(tx, id, revision))) throw new DomainError(409, ErrorCode.REVISION_CONFLICT, 'This draft changed since you loaded it. Reload and try again.');
    await recordAudit(tx, { actorUserId: admin.id, action: 'ADMIN_STRATEGY_DRAFT_DELETE', targetType: 'strategy_version', targetId: id, result: 'SUCCESS', before: { packageId: v.packageId, version: v.version, timeframe: v.timeframe }, correlationId });
    return { done: true };
  });
  if ('refuse' in out) {
    await denied(admin, 'ADMIN_STRATEGY_DRAFT_DELETE', 'strategy_version', id, 'IN_USE', correlationId, out.deps!);
    throw blocked(out.refuse!);
  }
}
