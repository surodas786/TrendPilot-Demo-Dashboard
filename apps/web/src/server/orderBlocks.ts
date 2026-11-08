import { fixtureQuote, getDb, getInstrument, getVersion, orderBlocksFor, recordAudit, type Executor, type InstrumentDto, type PublicUser } from '@trendpilot/db';
import {
  assertModeAllowed,
  catalogIssues,
  changedFields,
  DomainError,
  ErrorCode,
  notFound,
  orderBlockCreateSchema,
  orderBlockPatchSchema,
  orderBlockSettingsSchema,
  parseWith,
  previewOrder,
  settingsOf,
  type OrderPreview,
  type OrderBlockSettings,
  type BlockStatus,
  type Issue,
  type OrderBlockDto
} from '@trendpilot/domain';
import { validationError } from './http';

/**
 * Order block use cases (CFG-03/04/05, UI-03). The owner is always the session user;
 * every repository call is scoped through orderBlocksFor(…, owner.id).
 */

async function catalogCheck(db: Executor, instrumentId: string, s: { strategyVersionId: string; leverage: number; direction: OrderBlockDto['direction'] }): Promise<Issue[]> {
  const [instrument, version] = await Promise.all([getInstrument(db, instrumentId), getVersion(db, s.strategyVersionId)]);
  const issues: Issue[] = [];
  if (!instrument) issues.push({ path: 'instrumentId', message: 'Select a trading pair.' });
  if (!version) issues.push({ path: 'strategyVersionId', message: 'Select a strategy.' });
  if (instrument && version) {
    // CFG-02: the version must be approved for this pair (contract mapping).
    issues.push(...catalogIssues(s, { instrument, version }));
  }
  return issues;
}

export async function listBlocks(owner: PublicUser): Promise<OrderBlockDto[]> {
  return orderBlocksFor(getDb(), owner.id).list();
}

export async function getBlock(owner: PublicUser, id: string): Promise<OrderBlockDto> {
  const block = await orderBlocksFor(getDb(), owner.id).get(id);
  if (!block) throw notFound();
  return block;
}

export async function createBlock(owner: PublicUser, raw: unknown, correlationId: string): Promise<OrderBlockDto> {
  const parsed = parseWith(orderBlockCreateSchema, raw);
  if (!parsed.ok) throw validationError(parsed.issues);
  const input = parsed.value;
  assertModeAllowed(input.mode);

  const db = getDb();
  const issues = await catalogCheck(db, input.instrumentId, input);
  if (issues.length) throw validationError(issues);

  return db.transaction(async (tx) => {
    const block = await orderBlocksFor(tx, owner.id).create(input, owner.timezone);
    await recordAudit(tx, {
      actorUserId: owner.id,
      action: 'ORDER_BLOCK_CREATE',
      targetType: 'order_block',
      targetId: block.id,
      result: 'SUCCESS',
      after: changedFields({}, block).after,
      metadata: { symbol: block.symbol, mode: block.mode },
      correlationId
    });
    return block;
  });
}

/** A mutation on an unknown or unowned ID: audited as denied, answered as not found. */
async function deny(owner: PublicUser, action: string, id: string, correlationId: string): Promise<never> {
  await recordAudit(getDb(), {
    actorUserId: owner.id,
    action,
    targetType: 'order_block',
    targetId: id.slice(0, 64),
    result: 'DENIED',
    metadata: { reason: 'NOT_FOUND_OR_NOT_OWNED' },
    correlationId
  });
  throw notFound();
}

const conflict = () => new DomainError(409, ErrorCode.REVISION_CONFLICT, 'This block changed since you loaded it. Reload and try again.');

export async function updateBlock(owner: PublicUser, id: string, revision: number, raw: unknown, correlationId: string): Promise<OrderBlockDto> {
  const patch = parseWith(orderBlockPatchSchema, raw);
  if (!patch.ok) throw validationError(patch.issues);

  const db = getDb();
  const repo = orderBlocksFor(db, owner.id);
  const current = await repo.get(id);
  if (!current) return deny(owner, 'ORDER_BLOCK_UPDATE', id, correlationId);
  if (current.revision !== revision) throw conflict();

  // CFG-05: the merged result must be a complete, valid configuration.
  const merged = parseWith(orderBlockSettingsSchema, { ...settingsOf(current), ...patch.value });
  if (!merged.ok) throw validationError(merged.issues);
  const issues = await catalogCheck(db, current.instrumentId, merged.value);
  if (issues.length) throw validationError(issues);

  return db.transaction(async (tx) => {
    const result = await orderBlocksFor(tx, owner.id).update(id, revision, merged.value);
    if (!result.ok) {
      if (result.reason === 'REVISION_CONFLICT') throw conflict();
      throw notFound();
    }
    const diff = changedFields(current, result.block);
    await recordAudit(tx, {
      actorUserId: owner.id,
      action: 'ORDER_BLOCK_UPDATE',
      targetType: 'order_block',
      targetId: id,
      result: 'SUCCESS',
      before: diff.before,
      after: diff.after,
      metadata: { revision: result.block.revision },
      correlationId
    });
    return result.block;
  });
}

/** CFG-04: Pause blocks new exposure only. Resume rechecks eligibility for this slice. */
export async function setBlockStatus(owner: PublicUser, id: string, revision: number, status: BlockStatus, correlationId: string): Promise<OrderBlockDto> {
  const action = status === 'PAUSED' ? 'ORDER_BLOCK_PAUSE' : 'ORDER_BLOCK_RESUME';
  const db = getDb();
  const repo = orderBlocksFor(db, owner.id);
  const current = await repo.get(id);
  if (!current) return deny(owner, action, id, correlationId);
  if (current.revision !== revision) throw conflict();
  if (current.status === status) return current;

  if (status === 'ACTIVE') {
    const [instrument, version] = await Promise.all([getInstrument(db, current.instrumentId), getVersion(db, current.strategyVersionId)]);
    const reason =
      owner.status !== 'ACTIVE'
        ? 'Your account is not active.'
        : instrument?.status !== 'PUBLISHED'
          ? 'This pair is no longer available.'
          : !version?.published
            ? 'This strategy version is not published.'
            : current.mode !== 'PAPER'
              ? 'Live trading is unavailable in this build.'
              : undefined;
    if (reason) throw new DomainError(422, ErrorCode.RESUME_BLOCKED, reason);
  }

  return db.transaction(async (tx) => {
    const result = await orderBlocksFor(tx, owner.id).setStatus(id, revision, status);
    if (!result.ok) {
      if (result.reason === 'REVISION_CONFLICT') throw conflict();
      throw notFound();
    }
    await recordAudit(tx, {
      actorUserId: owner.id,
      action,
      targetType: 'order_block',
      targetId: id,
      result: 'SUCCESS',
      before: { status: current.status },
      after: { status },
      metadata: { revision: result.block.revision },
      correlationId
    });
    return result.block;
  });
}

/* ───────────── EXE-01 order preview (fixture quote, no orders) ───────────── */

function previewWith(instrument: InstrumentDto, settings: OrderBlockSettings): OrderPreview & { instrument: { symbol: string; exchangeSymbol: string; fixtureLabel: string | null } } {
  const quote = fixtureQuote(instrument.symbol);
  if (!quote) throw new DomainError(422, ErrorCode.VALIDATION_FAILED, `No fixture quote is available for ${instrument.symbol}.`);
  const spec = {
    contractMultiplier: instrument.contract.multiplier,
    qtyStep: instrument.contract.qtyStep,
    minQty: instrument.contract.minQty,
    maxQty: instrument.contract.maxQty,
    priceTick: instrument.contract.priceTick,
    takerFeeRate: instrument.contract.takerFeeRate
  };
  return { ...previewOrder(settings, spec, quote), instrument: { symbol: instrument.symbol, exchangeSymbol: instrument.exchangeSymbol, fixtureLabel: instrument.fixtureLabel } };
}

/** Preview unsaved settings (the editor). Validates exactly like create; persists nothing. */
export async function previewDraft(raw: unknown) {
  const parsed = parseWith(orderBlockCreateSchema, raw);
  if (!parsed.ok) throw validationError(parsed.issues);
  const db = getDb();
  const issues = await catalogCheck(db, parsed.value.instrumentId, parsed.value);
  if (issues.length) throw validationError(issues);
  return previewWith((await getInstrument(db, parsed.value.instrumentId))!, parsed.value);
}

/** Preview a saved block. Owner-scoped: an unowned ID is 404. */
export async function previewSaved(owner: PublicUser, id: string) {
  const block = await orderBlocksFor(getDb(), owner.id).get(id);
  if (!block) throw notFound();
  const instrument = await getInstrument(getDb(), block.instrumentId);
  if (!instrument) throw notFound();
  return previewWith(instrument, block);
}
