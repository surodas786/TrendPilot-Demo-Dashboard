import { connectionFor, fixtureQuote, lighterLiveRefusalFor, getDb, getInstrument, latestQuote, getVersion, orderBlocksFor, recordAudit, type Executor, type InstrumentDto, type PublicUser } from '@trendpilot/db';
import {
  assertModeAllowed,
  catalogIssues,
  changedFields,
  MODE_LABELS,
  modeChangeBlocker,
  exchangeLabel,
  exchangeUnavailableReason,
  isTradableExchange,
  paperUnsupportedReason,
  DomainError,
  ErrorCode,
  notFound,
  orderBlockCreateSchema,
  orderBlockPatchSchema,
  orderBlockSettingsSchema,
  parseWith,
  previewOrder,
  quoteAgeState,
  settingsOf,
  type OrderPreview,
  type OrderBlockSettings,
  type BlockStatus,
  type Issue,
  type OrderBlockDto,
  type Quote,
  type BlockMode,
  type ModeChangeBlocker,
  type ExchangeId
} from '@trendpilot/domain';
import { now } from './clock';
import { validationError } from './http';

/**
 * Order block use cases (CFG-03/04/05, UI-03). The owner is always the session user;
 * every repository call is scoped through orderBlocksFor(…, owner.id).
 */

async function catalogCheck(db: Executor, instrumentId: string, s: { strategyVersionId: string; leverage: number; direction: OrderBlockDto['direction'] }, mode?: BlockMode): Promise<Issue[]> {
  const [instrument, version] = await Promise.all([getInstrument(db, instrumentId), getVersion(db, s.strategyVersionId)]);
  const issues: Issue[] = [];
  if (!instrument) issues.push({ path: 'instrumentId', message: 'Select a trading pair.' });
  if (!version) issues.push({ path: 'strategyVersionId', message: 'Select a strategy.' });
  else if (version.packageArchived) issues.push({ path: 'strategyVersionId', message: `“${version.packageName}” has been archived by the administrator. Select another strategy.` });
  if (instrument && mode === 'PAPER') {
    const reason = paperUnsupportedReason(instrument.exchange);
    if (reason) issues.push({ path: 'instrumentId', message: reason });
  }
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
  const issues = await catalogCheck(db, input.instrumentId, input, input.mode as BlockMode);
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

/**
 * Why this block cannot switch to `to`, or null. Same rules the editor shows: Live needs a
 * verified MEXC connection (the New Entry rule), one block per pair and mode, and a block that
 * manages an open position or unfinished order keeps its mode. `lock` (inside a transaction)
 * serialises with entries for the block's current mode before counting.
 */
async function modeChangeBlockerFor(db: Executor, owner: PublicUser, block: OrderBlockDto, to: BlockMode, lock = false): Promise<ModeChangeBlocker | null> {
  const repo = orderBlocksFor(db, owner.id);
  const from = block.mode as BlockMode;
  const [conn, instrument, destinationBlockId, activity] = await Promise.all([
    // Only an exchange TrendPilot can trade has a connection; Lighter (selection only) has none and
    // modeChangeBlocker reports it as unavailable for Live.
    isTradableExchange(block.exchange) || block.exchange === 'LIGHTER' ? connectionFor(db, owner.id, block.exchange as ExchangeId) : Promise.resolve(undefined),
    getInstrument(db, block.instrumentId),
    repo.idFor(block.instrumentId, to),
    repo.activity(block.id, lock ? { lockMode: from } : {})
  ]);
  // Lighter Live: only inside the Lighter Live scope (account + market; the route is checked per alert).
  const lighterLive = block.exchange === 'LIGHTER' && to === 'LIVE' && !(await lighterLiveRefusalFor(db, { ownerId: owner.id, instrumentId: block.instrumentId }, 'SEND'));
  return modeChangeBlocker({
    from,
    to,
    pair: instrument ? `${instrument.base}/${instrument.quote}` : block.symbol,
    liveConnectionStatus: conn?.status ?? null,
    exchange: block.exchange,
    lighterLive,
    destinationBlockId: destinationBlockId === block.id ? null : destinationBlockId,
    ...activity
  });
}

const modeChangeError = (b: ModeChangeBlocker) =>
  new DomainError(b.code === 'LIVE_UNAVAILABLE' || b.code === 'PAPER_UNSUPPORTED' ? 422 : 409, ErrorCode.MODE_CHANGE_BLOCKED, b.message, [{ path: 'mode', message: b.message }], { blocker: b });

/** GET …/mode-change?to=: whether the block may switch to `to` now, and why not (read-only). */
export async function modeChangeStatus(owner: PublicUser, id: string, to: string | null) {
  if (to !== 'PAPER' && to !== 'LIVE') throw validationError([{ path: 'to', message: 'Use to=PAPER or to=LIVE.' }]);
  const db = getDb();
  const block = await orderBlocksFor(db, owner.id).get(id);
  if (!block) throw notFound();
  const blocker = await modeChangeBlockerFor(db, owner, block, to);
  return { from: block.mode, to, allowed: blocker === null, blocker };
}

export async function updateBlock(owner: PublicUser, id: string, revision: number, raw: unknown, correlationId: string): Promise<OrderBlockDto> {
  const patch = parseWith(orderBlockPatchSchema, raw);
  if (!patch.ok) throw validationError(patch.issues);
  const { mode: requestedMode, ...settingsPatch } = patch.value;

  const db = getDb();
  const repo = orderBlocksFor(db, owner.id);
  const current = await repo.get(id);
  if (!current) return deny(owner, 'ORDER_BLOCK_UPDATE', id, correlationId);
  if (current.revision !== revision) throw conflict();
  const toMode = requestedMode !== undefined && requestedMode !== current.mode ? requestedMode : undefined;
  if (toMode) assertModeAllowed(toMode);

  // CFG-05: the merged result must be a complete, valid configuration.
  const merged = parseWith(orderBlockSettingsSchema, { ...settingsOf(current), ...settingsPatch });
  if (!merged.ok) throw validationError(merged.issues);
  const issues = await catalogCheck(db, current.instrumentId, merged.value);
  if (issues.length) throw validationError(issues);

  // A legacy trailing stop converts only when this save carries trailing settings, which the
  // merged validation above held to Trailing Take Profit rules (explicit activation value).
  const trailingConverted = current.trailingConversionRequired && settingsPatch.trailing !== undefined;

  return db.transaction(async (tx) => {
    if (toMode) {
      // Rechecked under the account lock entries take, so the answer cannot go stale before commit.
      const blocker = await modeChangeBlockerFor(tx, owner, current, toMode, true);
      if (blocker) throw modeChangeError(blocker);
    }
    const result = await orderBlocksFor(tx, owner.id).update(id, revision, merged.value, { trailingConverted, mode: toMode });
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
      before: toMode ? { ...diff.before, mode: current.mode } : diff.before,
      after: toMode ? { ...diff.after, mode: result.block.mode } : diff.after,
      metadata: {
        revision: result.block.revision,
        ...(trailingConverted ? { trailingConvertedToTakeProfit: true } : {}),
        ...(toMode ? { modeChange: { from: current.mode, to: toMode, note: `Switched from ${MODE_LABELS[current.mode as BlockMode]} to ${MODE_LABELS[toMode]} for future entries; paused.` } } : {})
      },
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
    // Live needs the connection of the exchange this block's contract trades on.
    const exchange = current.exchange;
    // Lighter Live: only inside the Lighter Live scope (lighterLiveScope.ts), refused by default.
    const notTradable = exchange === 'LIGHTER' && current.mode === 'LIVE' ? await lighterLiveRefusalFor(db, { ownerId: owner.id, instrumentId: current.instrumentId }, 'SEND') : exchangeUnavailableReason(exchange);
    const [instrument, version, conn] = await Promise.all([getInstrument(db, current.instrumentId), getVersion(db, current.strategyVersionId), isTradableExchange(exchange) || exchange === 'LIGHTER' ? connectionFor(db, owner.id, exchange as ExchangeId) : Promise.resolve(undefined)]);
    const reason =
      owner.status !== 'ACTIVE'
        ? 'Your account is not active.'
        : instrument?.status !== 'PUBLISHED'
          ? 'This pair is no longer available.'
          : !version?.published
            ? 'This strategy version is not published.'
            : current.mode === 'LIVE' && notTradable
              ? notTradable
            : current.mode === 'PAPER' && paperUnsupportedReason(current.exchange)
              ? paperUnsupportedReason(current.exchange)!
            : current.mode === 'LIVE' && (!conn || conn.status !== 'VERIFIED')
              ? `Connect and verify your ${exchangeLabel(exchange)} account (Live Trading page) before activating Live settings.`
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

/**
 * A fresh public MEXC quote when the feed is running (MKT-01), otherwise the labelled static
 * fixture. The preview always says which one it used.
 */
async function previewQuote(instrument: InstrumentDto): Promise<Quote | undefined> {
  const at = now();
  const q = await latestQuote(getDb(), instrument.id, at);
  // The contract's own exchange feed only: MEXC_PUBLIC for MEXC pairs, BITUNIX_PUBLIC for Bitunix pairs, etc.
  const own = `${instrument.exchange}_PUBLIC`;
  if (q && q.source === own && quoteAgeState(q.asOf, at) === 'FRESH') return { bid: q.bid, ask: q.ask, mark: q.mark, asOf: q.asOf.toISOString(), source: own as Quote['source'] };
  // The static fixture prices are MEXC-shaped demo data keyed by symbol. A real Bitunix contract never
  // previews on them: without a fresh Bitunix price the preview says so instead.
  // Lighter has no price feed yet and never previews on another exchange's or fixture prices.
  if (instrument.exchange !== 'MEXC' && (instrument.exchange !== 'BITUNIX' || !instrument.isFixture)) return undefined;
  return fixtureQuote(instrument.symbol);
}

async function previewWith(instrument: InstrumentDto, settings: OrderBlockSettings, mode: BlockMode = 'PAPER'): Promise<OrderPreview & { instrument: { symbol: string; exchangeSymbol: string; fixtureLabel: string | null; exchange: string; quoteCurrency: string } }> {
  const quote = await previewQuote(instrument);
  if (!quote)
    throw new DomainError(
      422,
      ErrorCode.VALIDATION_FAILED,
      instrument.exchange === 'LIGHTER'
        ? `No fresh Lighter price is available for ${instrument.exchangeSymbol} (market ${instrument.marketId}): the preview needs a fresh Lighter bid/ask. Nothing from another exchange is used in its place.`
        : !isTradableExchange(instrument.exchange)
        ? `No ${exchangeLabel(instrument.exchange)} price is available for ${instrument.exchangeSymbol}. Nothing from another exchange is used in its place.`
        : instrument.isFixture
        ? `No fixture quote is available for ${instrument.symbol}.`
        : `No fresh public ${exchangeLabel(instrument.exchange)} price for ${instrument.symbol} (${instrument.exchangeSymbol}) yet. The market feed picks up a newly published pair within seconds; if it stays unavailable, check Admin → Market Data Feed (the contract may not be trading).`
    );
  const lighter = instrument.exchange === 'LIGHTER';
  // Lighter: base step and minimum, USDC order-value limits; no base-unit maximum (see paper/spec.ts).
  const spec = {
    contractMultiplier: instrument.contract.multiplier,
    qtyStep: instrument.contract.qtyStep,
    minQty: instrument.contract.minQty,
    maxQty: lighter ? null : instrument.contract.maxQty,
    priceTick: instrument.contract.priceTick,
    takerFeeRate: instrument.contract.takerFeeRate,
    ...(lighter ? { minNotional: instrument.contract.minNotional, maxNotional: instrument.contract.maxNotional, quoteCurrency: instrument.quote } : {})
  };
  const inst = { symbol: instrument.symbol, exchangeSymbol: instrument.exchangeSymbol, fixtureLabel: instrument.fixtureLabel, exchange: instrument.exchange, quoteCurrency: instrument.quote };
  // Lighter Live is not available: its own fresh public price only, no Live estimates.
  if (mode === 'LIVE' && !isTradableExchange(instrument.exchange)) {
    return { quote, sides: [], notes: [`${exchangeLabel(instrument.exchange)} public price only: Live order estimates are not available until ${exchangeLabel(instrument.exchange)} Live trading is released. Paper is available.`], instrument: inst };
  }
  if (lighter) {
    if (!instrument.contract.maxNotional) throw new DomainError(422, ErrorCode.VALIDATION_FAILED, `No verified maximum order value is stored for Lighter ${instrument.exchangeSymbol}. An administrator must refresh it from the Lighter catalog (Admin → Trading Pairs).`);
    const p = previewOrder(settings, spec, quote);
    return {
      ...p,
      notes: [
        `Paper simulation on Lighter public prices (USDC): bid/ask ${quote.asOf ? `at ${quote.asOf}` : ''}. Nothing is sent to Lighter.`,
        `Lighter rules: size step ${instrument.contract.qtyStep} ${instrument.base}, minimum ${instrument.contract.minQty} ${instrument.base} and ${instrument.contract.minNotional ?? '?'} USDC, maximum ${instrument.contract.maxNotional} USDC per order (catalog market ${instrument.marketId}).`,
        'Simulated fee: Lighter Standard account 0% (per Lighter docs); your real Lighter account tier may differ.',
        'Market entry estimate before slippage. A preview is not a guarantee of fill price.'
      ],
      instrument: inst
    };
  }
  return { ...previewOrder(settings, spec, quote), instrument: inst };
}

/** Preview unsaved settings (the editor). Validates exactly like create; persists nothing. */
export async function previewDraft(raw: unknown) {
  const parsed = parseWith(orderBlockCreateSchema, raw);
  if (!parsed.ok) throw validationError(parsed.issues);
  const db = getDb();
  const issues = await catalogCheck(db, parsed.value.instrumentId, parsed.value);
  if (issues.length) throw validationError(issues);
  return previewWith((await getInstrument(db, parsed.value.instrumentId))!, parsed.value, parsed.value.mode as BlockMode);
}

/** Preview a saved block. Owner-scoped: an unowned ID is 404. */
export async function previewSaved(owner: PublicUser, id: string) {
  const block = await orderBlocksFor(getDb(), owner.id).get(id);
  if (!block) throw notFound();
  const instrument = await getInstrument(getDb(), block.instrumentId);
  if (!instrument) throw notFound();
  return previewWith(instrument, block, block.mode as BlockMode);
}
