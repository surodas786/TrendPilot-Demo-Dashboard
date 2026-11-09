import { and, asc, desc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import { DomainError, ErrorCode, normDecimal, type Direction, type StrategyVersionDraft } from '@trendpilot/domain';
import type { Executor } from '../client';
import { FIXTURE_LABEL, leverageChoicesFor, type MexcContractFixture } from '../mexcFixtures';
import { instruments, strategyPackages, strategyVersionInstruments, strategyVersions } from '../schema';

/* ───────────────────────────── Instruments (trading pairs) ───────────────────────────── */

export interface InstrumentDto {
  id: string;
  exchange: string;
  symbol: string;
  exchangeSymbol: string;
  base: string;
  quote: string;
  status: 'PUBLISHED' | 'DISABLED';
  leverageChoices: number[];
  contract: { multiplier: string; qtyStep: string; minQty: string; maxQty: string; priceTick: string; takerFeeRate: string };
  suggested: { stopPct: string; takeProfitPct: string; trailingEnabled: boolean; trailingPct: string };
  isFixture: boolean;
  fixtureLabel: string | null;
  revision: number;
  updatedAt: string;
}

type InstrumentRow = typeof instruments.$inferSelect;

const toInstrument = (r: InstrumentRow): InstrumentDto => ({
  id: r.id,
  exchange: r.exchange,
  symbol: r.symbol,
  exchangeSymbol: r.exchangeSymbol,
  base: r.base,
  quote: r.quote,
  status: r.status,
  leverageChoices: [...r.leverageChoices].sort((a, b) => a - b),
  contract: {
    multiplier: normDecimal(r.contractMultiplier),
    qtyStep: normDecimal(r.qtyStep),
    minQty: normDecimal(r.minQty),
    maxQty: normDecimal(r.maxQty),
    priceTick: normDecimal(r.priceTick),
    takerFeeRate: normDecimal(r.takerFeeRate)
  },
  suggested: {
    stopPct: normDecimal(r.suggestedStopPct),
    takeProfitPct: normDecimal(r.suggestedTakeProfitPct),
    trailingEnabled: r.suggestedTrailingEnabled,
    trailingPct: normDecimal(r.suggestedTrailingPct)
  },
  isFixture: r.isFixture,
  fixtureLabel: r.isFixture ? FIXTURE_LABEL : null,
  revision: r.revision,
  updatedAt: r.updatedAt.toISOString()
});

export async function listPublishedInstruments(db: Executor): Promise<InstrumentDto[]> {
  const rows = await db.select().from(instruments).where(eq(instruments.status, 'PUBLISHED')).orderBy(asc(instruments.symbol));
  return rows.map(toInstrument);
}

export async function listAllInstruments(db: Executor): Promise<InstrumentDto[]> {
  const rows = await db.select().from(instruments).orderBy(asc(instruments.symbol));
  return rows.map(toInstrument);
}

export async function getInstrument(db: Executor, id: string): Promise<InstrumentDto | undefined> {
  if (!UUID_RE.test(id)) return undefined;
  const [row] = await db.select().from(instruments).where(eq(instruments.id, id)).limit(1);
  return row && toInstrument(row);
}

export interface Suggestions {
  suggestedStopPct: string;
  suggestedTakeProfitPct: string;
  suggestedTrailingEnabled: boolean;
  suggestedTrailingPct: string;
}

/** UI-05: create an approved pair from a validated (fixture) exchange contract. */
/** Creates a PUBLISHED pair from a validated contract. `isFixture` marks unverified fixture metadata. */
export async function createInstrumentFromContract(db: Executor, spec: MexcContractFixture & { minLeverage?: number; isFixture?: boolean }, s: Suggestions): Promise<InstrumentDto> {
  const [row] = await db
    .insert(instruments)
    .values({
      exchange: 'MEXC',
      symbol: spec.symbol,
      exchangeSymbol: spec.exchangeSymbol,
      base: spec.base,
      quote: spec.quote,
      status: 'PUBLISHED',
      contractMultiplier: spec.contractMultiplier,
      qtyStep: spec.qtyStep,
      minQty: spec.minQty,
      maxQty: spec.maxQty,
      priceTick: spec.priceTick,
      takerFeeRate: spec.takerFeeRate,
      leverageChoices: leverageChoicesFor(spec.maxLeverage, spec.minLeverage ?? 1),
      ...s,
      isFixture: spec.isFixture ?? true
    })
    .onConflictDoNothing()
    .returning();
  if (!row) throw new DomainError(409, ErrorCode.DUPLICATE, `${spec.symbol} is already a trading pair.`);
  return toInstrument(row);
}

export async function updateInstrument(
  db: Executor,
  id: string,
  expectedRevision: number,
  patch: Partial<Suggestions> & { status?: 'PUBLISHED' | 'DISABLED' }
): Promise<{ ok: true; before: InstrumentDto; after: InstrumentDto } | { ok: false; reason: 'NOT_FOUND' | 'REVISION_CONFLICT' }> {
  const before = await getInstrument(db, id);
  if (!before) return { ok: false, reason: 'NOT_FOUND' };
  const [row] = await db
    .update(instruments)
    .set({ ...patch, revision: sql`${instruments.revision} + 1`, updatedAt: sql`now()` })
    .where(and(eq(instruments.id, id), eq(instruments.revision, expectedRevision)))
    .returning();
  if (!row) return { ok: false, reason: 'REVISION_CONFLICT' };
  return { ok: true, before, after: toInstrument(row) };
}

/* ─────────────────────────────── Strategy versions ─────────────────────────────── */

export interface StrategyVersionDto {
  id: string;
  packageId: string;
  packageName: string;
  version: number;
  status: 'DRAFT' | 'PUBLISHED';
  timeframe: '5m' | '15m';
  atrLength: number;
  atrFactor: string;
  permittedDirections: Direction;
  emaFilter: 'OFF' | 'EMA200';
  oppositePolicy: 'KEEP_OPEN' | 'CLOSE_ONLY' | 'CLOSE_AND_REVERSE';
  signalMaxAgeSeconds: number;
  maxPriceDeviationPct: string;
  instrumentIds: string[];
  published: boolean;
  publishedAt: string | null;
  /** True for the newest published version of its package. */
  isLatest: boolean;
  revision: number;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function hydrateVersions(db: Executor, rows: { v: typeof strategyVersions.$inferSelect; packageName: string }[]): Promise<StrategyVersionDto[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.v.id);
  const maps = await db.select().from(strategyVersionInstruments).where(inArray(strategyVersionInstruments.versionId, ids));
  const latestRows = await db
    .select({ packageId: strategyVersions.packageId, latest: sql<number>`max(${strategyVersions.version})`.as('latest') })
    .from(strategyVersions)
    .where(isNotNull(strategyVersions.publishedAt))
    .groupBy(strategyVersions.packageId);
  const latest = new Map(latestRows.map((l) => [l.packageId, Number(l.latest)]));
  return rows.map(({ v, packageName }) => ({
    id: v.id,
    packageId: v.packageId,
    packageName,
    version: v.version,
    status: v.publishedAt ? 'PUBLISHED' : 'DRAFT',
    timeframe: v.timeframe,
    atrLength: v.atrLength,
    atrFactor: normDecimal(v.atrFactor),
    permittedDirections: v.permittedDirections,
    emaFilter: v.emaFilter,
    oppositePolicy: v.oppositePolicy,
    signalMaxAgeSeconds: v.signalMaxAgeSeconds,
    maxPriceDeviationPct: normDecimal(v.maxPriceDeviationPct),
    instrumentIds: maps.filter((m) => m.versionId === v.id).map((m) => m.instrumentId),
    published: v.publishedAt !== null,
    publishedAt: v.publishedAt?.toISOString() ?? null,
    isLatest: v.publishedAt !== null && latest.get(v.packageId) === v.version,
    revision: v.revision
  }));
}

const versionSelect = (db: Executor) =>
  db.select({ v: strategyVersions, packageName: strategyPackages.name }).from(strategyVersions).innerJoin(strategyPackages, eq(strategyPackages.id, strategyVersions.packageId));

/** Published versions, newest first within each package. */
export async function listPublishedVersions(db: Executor): Promise<StrategyVersionDto[]> {
  const rows = await versionSelect(db).where(isNotNull(strategyVersions.publishedAt)).orderBy(asc(strategyPackages.name), desc(strategyVersions.version));
  return hydrateVersions(db, rows);
}

export async function getVersion(db: Executor, id: string): Promise<StrategyVersionDto | undefined> {
  if (!UUID_RE.test(id)) return undefined;
  const rows = await versionSelect(db).where(eq(strategyVersions.id, id)).limit(1);
  return (await hydrateVersions(db, rows))[0];
}

export interface PackageDto {
  id: string;
  name: string;
  versions: StrategyVersionDto[];
}

export async function listPackages(db: Executor): Promise<PackageDto[]> {
  const pkgs = await db.select().from(strategyPackages).orderBy(asc(strategyPackages.name));
  const rows = await versionSelect(db).orderBy(desc(strategyVersions.version));
  const versions = await hydrateVersions(db, rows);
  return pkgs.map((p) => ({ id: p.id, name: p.name, versions: versions.filter((v) => v.packageId === p.id) }));
}

export async function createPackage(db: Executor, name: string): Promise<{ id: string; name: string }> {
  const [row] = await db.insert(strategyPackages).values({ name }).returning();
  return { id: row!.id, name: row!.name };
}

async function setMappings(db: Executor, versionId: string, instrumentIds: string[]): Promise<void> {
  await db.delete(strategyVersionInstruments).where(eq(strategyVersionInstruments.versionId, versionId));
  if (instrumentIds.length) await db.insert(strategyVersionInstruments).values([...new Set(instrumentIds)].map((instrumentId) => ({ versionId, instrumentId })));
}

const draftColumns = (d: StrategyVersionDraft) => ({
  timeframe: d.timeframe,
  atrLength: d.atrLength,
  atrFactor: d.atrFactor,
  permittedDirections: d.permittedDirections,
  emaFilter: d.emaFilter,
  oppositePolicy: d.oppositePolicy,
  signalMaxAgeSeconds: d.signalMaxAgeSeconds,
  maxPriceDeviationPct: d.maxPriceDeviationPct
});

/** CFG-02: editing creates a draft. One open draft per package (partial unique index). */
export async function createDraft(db: Executor, packageId: string, d: StrategyVersionDraft, createdBy: string): Promise<StrategyVersionDto> {
  const [pkg] = await db.select().from(strategyPackages).where(eq(strategyPackages.id, packageId));
  if (!pkg) throw new DomainError(404, ErrorCode.NOT_FOUND, 'Not found.');
  const [open] = await db.select({ id: strategyVersions.id }).from(strategyVersions).where(and(eq(strategyVersions.packageId, packageId), isNull(strategyVersions.publishedAt)));
  if (open) throw new DomainError(409, ErrorCode.CONFLICT, 'This package already has an unpublished draft. Edit or publish it first.');
  const [max] = await db.select({ v: sql<number>`coalesce(max(${strategyVersions.version}), 0)` }).from(strategyVersions).where(eq(strategyVersions.packageId, packageId));
  const [row] = await db
    .insert(strategyVersions)
    .values({ packageId, version: Number(max!.v) + 1, ...draftColumns(d), createdBy })
    .returning({ id: strategyVersions.id });
  await setMappings(db, row!.id, d.instrumentIds);
  return (await getVersion(db, row!.id))!;
}

export type VersionWrite = { ok: true; before: StrategyVersionDto; after: StrategyVersionDto } | { ok: false; reason: 'NOT_FOUND' | 'REVISION_CONFLICT' | 'IMMUTABLE' };

export async function updateDraft(db: Executor, id: string, expectedRevision: number, d: StrategyVersionDraft): Promise<VersionWrite> {
  const before = await getVersion(db, id);
  if (!before) return { ok: false, reason: 'NOT_FOUND' };
  if (before.published) return { ok: false, reason: 'IMMUTABLE' };
  const rows = await db
    .update(strategyVersions)
    .set({ ...draftColumns(d), revision: sql`${strategyVersions.revision} + 1` })
    .where(and(eq(strategyVersions.id, id), eq(strategyVersions.revision, expectedRevision), isNull(strategyVersions.publishedAt)))
    .returning({ id: strategyVersions.id });
  if (rows.length === 0) return { ok: false, reason: 'REVISION_CONFLICT' };
  await setMappings(db, id, d.instrumentIds);
  return { ok: true, before, after: (await getVersion(db, id))! };
}

/** Publishing freezes the version. Existing order blocks stay pinned to whatever they reference. */
export async function publishDraft(db: Executor, id: string, expectedRevision: number, publishedBy: string): Promise<VersionWrite> {
  const before = await getVersion(db, id);
  if (!before) return { ok: false, reason: 'NOT_FOUND' };
  if (before.published) return { ok: false, reason: 'IMMUTABLE' };
  const rows = await db
    .update(strategyVersions)
    .set({ publishedAt: sql`now()`, publishedBy, revision: sql`${strategyVersions.revision} + 1` })
    .where(and(eq(strategyVersions.id, id), eq(strategyVersions.revision, expectedRevision), isNull(strategyVersions.publishedAt)))
    .returning({ id: strategyVersions.id });
  if (rows.length === 0) return { ok: false, reason: 'REVISION_CONFLICT' };
  return { ok: true, before, after: (await getVersion(db, id))! };
}
