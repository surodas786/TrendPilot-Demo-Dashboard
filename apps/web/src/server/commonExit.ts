import { applyExitPlanToPosition, getDb, latestCommonExit, linkedExposure, listCommonExitRevisions, publishCommonExit, quoteFor, type ExitPlanApplyOutcome } from '@trendpilot/db';
import { basisPrice, commonExitDefinitionSchema, commonExitPublishSchema, parseWith, type CommonExitDefinition, type PriceBasis } from '@trendpilot/domain';
import { now } from './clock';
import { validationError } from './http';
import { partialExitProtectionMatrix } from './orderBlocks';

/**
 * Admin → Common Exit Definition use cases. Validation is the same shared schema as an investor's
 * exit plan (commonExitDefinitionSchema → refineExitPlan).
 */

export async function commonExitView() {
  const db = getDb();
  const [revisions, linked] = await Promise.all([listCommonExitRevisions(db, 20), linkedExposure(db)]);
  return {
    current: revisions[0] ?? null,
    revisions,
    linked: {
      blocks: linked.blocks.map((b) => ({ id: b.id, owner: b.ownerName, symbol: b.symbol, exchange: b.exchange, mode: b.mode })),
      openPositions: linked.open.map((o) => ({
        id: o.p.id,
        owner: o.ownerName,
        symbol: o.symbol,
        exchange: o.exchange,
        mode: o.p.mode,
        side: o.p.side,
        contracts: o.p.contracts,
        exitPlan: { source: o.p.exitPlanSource, adminVersion: o.p.exitPlanAdminVersion, appliedAt: o.p.exitPlanAppliedAt?.toISOString() ?? null }
      }))
    },
    partialExitProtection: partialExitProtectionMatrix()
  };
}

function parsePlan(raw: unknown): CommonExitDefinition {
  const r = parseWith(commonExitDefinitionSchema, raw);
  if (!r.ok) throw validationError(r.issues);
  return r.value;
}

export interface ApplyPreviewItem extends ExitPlanApplyOutcome {
  owner: string;
  symbol: string;
  exchange: string;
  mode: string;
}

/**
 * Dry run of "Apply to existing linked positions": what would change on each linked open position,
 * what is kept (completed / in flight), which thresholds the latest price already crosses, and which
 * positions would be left on their previous plan (with the reason). Nothing is written.
 */
export async function previewApply(rawPlan: unknown): Promise<{ plan: CommonExitDefinition; positions: ApplyPreviewItem[] }> {
  const plan = parsePlan(rawPlan);
  const db = getDb();
  const { open } = await linkedExposure(db);
  const at = now();
  const current = await latestCommonExit(db);
  const out: ApplyPreviewItem[] = [];
  for (const o of open) {
    const q = await quoteFor(db, o.p.instrumentId, at);
    const lastPrice = q ? basisPrice(q, (o.p.trailingBasis ?? o.p.stopBasis) as PriceBasis) : null;
    const r = await db.transaction((tx) => applyExitPlanToPosition(tx, o.p.id, plan, { version: (current?.version ?? 0) + 1, now: at, dryRun: true, lastPrice }));
    out.push({ ...r, owner: o.ownerName, symbol: o.symbol, exchange: o.exchange, mode: o.p.mode });
  }
  return { plan, positions: out };
}

export async function publish(adminId: string, raw: unknown, correlationId: string) {
  const body = parseWith(commonExitPublishSchema, raw);
  if (!body.ok) throw validationError(body.issues);
  const plan = parsePlan(body.value.plan);
  return publishCommonExit(getDb(), { plan, scope: body.value.scope, expectedVersion: body.value.expectedVersion, note: body.value.note, authorId: adminId, correlationId, now: now() });
}
