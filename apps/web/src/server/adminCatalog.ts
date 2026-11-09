import {
  createDraft,
  createInstrumentFromContract,
  createPackage,
  FIXTURE_LABEL,
  getDb,
  getInstrument,
  leverageChoicesFor,
  MexcPublicClient,
  MEXC_PUBLIC_DEFAULT_BASE_URL,
  pairContractSource,
  publishDraft,
  resolvePairContract,
  recordAudit,
  updateDraft,
  updateInstrument,
  type ContractInfoSource,
  type InstrumentDto,
  type PairContract,
  type PairContractSource,
  type PublicUser,
  type StrategyVersionDto
} from '@trendpilot/db';
import {
  DomainError,
  ErrorCode,
  instrumentCreateSchema,
  instrumentUpdateSchema,
  instrumentValidateSchema,
  notFound,
  packageCreateSchema,
  parseWith,
  strategyVersionDraftSchema,
  type Issue
} from '@trendpilot/domain';
import { validationError } from './http';

/** UI-05 admin configuration: trading pairs and CFG-02 strategy versions. */

function parse<T>(schema: Parameters<typeof parseWith<T>>[0], raw: unknown): T {
  const r = parseWith(schema, raw);
  if (!r.ok) throw validationError(r.issues);
  return r.value;
}

const conflict = (what: string) => new DomainError(409, ErrorCode.REVISION_CONFLICT, `This ${what} changed since you loaded it. Reload and try again.`);
const immutable = () => new DomainError(409, ErrorCode.IMMUTABLE, 'Published versions cannot be changed. Create a new draft instead.');

/* ───────────── UI-05 pair validation: MEXC Get Contract Info (deployed) or fixtures (tests, demo) ───────────── */

let override: { source: PairContractSource; client?: ContractInfoSource } | null = null;

/** Test-only: force the contract source (and a stub client). Refuses to run in production. */
export function setPairContractSourceForTests(o: { source: PairContractSource; client?: ContractInfoSource } | null): void {
  if (process.env.NODE_ENV === 'production') throw new Error('Pair contract overrides cannot be used in production.');
  override = o;
}

function contractSource(): { source: PairContractSource; client?: ContractInfoSource } {
  if (override) return override;
  const source = pairContractSource();
  return source === 'FIXTURE' ? { source } : { source, client: new MexcPublicClient({ baseUrl: process.env.MEXC_PUBLIC_BASE_URL || MEXC_PUBLIC_DEFAULT_BASE_URL, timeoutMs: 8_000 }) };
}

/** Resolves an admin's ticker to a contract, or throws the matching API error. */
async function lookupPair(symbol: string): Promise<PairContract> {
  const r = await resolvePairContract(symbol, contractSource());
  if (r.ok) return r.contract;
  switch (r.reason) {
    case 'RATE_LIMITED':
      throw new DomainError(429, ErrorCode.RATE_LIMITED, r.message);
    case 'EXCHANGE_UNAVAILABLE':
      throw new DomainError(503, ErrorCode.EXCHANGE_UNAVAILABLE, r.message);
    default:
      throw validationError([{ path: 'symbol', message: r.message }]);
  }
}

/** "Type a ticker, validate it against the exchange." Accepts XAUUSDT or XAU_USDT. */
export async function validateTicker(raw: unknown) {
  const { symbol } = parse(instrumentValidateSchema, raw);
  const c = await lookupPair(symbol);
  return {
    symbol: c.symbol,
    exchangeSymbol: c.exchangeSymbol,
    base: c.base,
    quote: c.quote,
    settleCoin: c.settleCoin,
    displayName: c.displayName,
    contract: { multiplier: c.contractMultiplier, qtyStep: c.qtyStep, minQty: c.minQty, maxQty: c.maxQty, priceTick: c.priceTick, takerFeeRate: c.takerFeeRate },
    leverage: { min: c.minLeverage, max: c.maxLeverage },
    leverageChoices: leverageChoicesFor(c.maxLeverage, c.minLeverage),
    source: c.source,
    fixtureLabel: c.source === 'FIXTURE' ? FIXTURE_LABEL : null,
    warnings: c.warnings,
    checkedAt: c.checkedAt
  };
}

/** Publish: the contract is looked up again on the server; nothing from the browser is trusted. */
export async function createPair(admin: PublicUser, raw: unknown, correlationId: string): Promise<InstrumentDto> {
  const input = parse(instrumentCreateSchema, raw);
  const c = await lookupPair(input.symbol);
  const { symbol: _s, ...suggestions } = input;
  return getDb().transaction(async (tx) => {
    const inst = await createInstrumentFromContract(tx, { ...c, isFixture: c.source === 'FIXTURE' }, suggestions);
    await recordAudit(tx, {
      actorUserId: admin.id,
      action: 'ADMIN_INSTRUMENT_CREATE',
      targetType: 'instrument',
      targetId: inst.id,
      result: 'SUCCESS',
      after: { symbol: inst.symbol, exchangeSymbol: inst.exchangeSymbol, status: inst.status, suggested: inst.suggested, contractSource: c.source, checkedAt: c.checkedAt },
      correlationId
    });
    return inst;
  });
}

export async function updatePair(admin: PublicUser, id: string, revision: number, raw: unknown, correlationId: string): Promise<InstrumentDto> {
  const patch = parse(instrumentUpdateSchema, raw);
  return getDb().transaction(async (tx) => {
    const r = await updateInstrument(tx, id, revision, patch);
    if (!r.ok) throw r.reason === 'NOT_FOUND' ? notFound() : conflict('pair');
    await recordAudit(tx, {
      actorUserId: admin.id,
      action: 'ADMIN_INSTRUMENT_UPDATE',
      targetType: 'instrument',
      targetId: id,
      result: 'SUCCESS',
      before: { status: r.before.status, suggested: r.before.suggested },
      after: { status: r.after.status, suggested: r.after.suggested },
      correlationId
    });
    return r.after;
  });
}

export async function createStrategyPackage(admin: PublicUser, raw: unknown, correlationId: string) {
  const { name } = parse(packageCreateSchema, raw);
  return getDb().transaction(async (tx) => {
    const pkg = await createPackage(tx, name);
    await recordAudit(tx, { actorUserId: admin.id, action: 'ADMIN_STRATEGY_PACKAGE_CREATE', targetType: 'strategy_package', targetId: pkg.id, result: 'SUCCESS', after: { name }, correlationId });
    return pkg;
  });
}

async function checkPairs(instrumentIds: string[]): Promise<void> {
  const issues: Issue[] = [];
  for (const [i, id] of instrumentIds.entries()) {
    const inst = await getInstrument(getDb(), id);
    if (!inst) issues.push({ path: `instrumentIds.${i}`, message: 'Unknown pair.' });
    else if (inst.status !== 'PUBLISHED') issues.push({ path: `instrumentIds.${i}`, message: `${inst.symbol} is not a published pair.` });
  }
  if (issues.length) throw validationError(issues);
}

const versionSummary = (v: StrategyVersionDto) => ({
  version: v.version,
  timeframe: v.timeframe,
  atrLength: v.atrLength,
  atrFactor: v.atrFactor,
  permittedDirections: v.permittedDirections,
  emaFilter: v.emaFilter,
  oppositePolicy: v.oppositePolicy,
  signalMaxAgeSeconds: v.signalMaxAgeSeconds,
  maxPriceDeviationPct: v.maxPriceDeviationPct,
  instrumentIds: v.instrumentIds
});

export async function createVersionDraft(admin: PublicUser, packageId: string, raw: unknown, correlationId: string): Promise<StrategyVersionDto> {
  const draft = parse(strategyVersionDraftSchema, raw);
  await checkPairs(draft.instrumentIds);
  return getDb().transaction(async (tx) => {
    const v = await createDraft(tx, packageId, draft, admin.id);
    await recordAudit(tx, { actorUserId: admin.id, action: 'ADMIN_STRATEGY_DRAFT_CREATE', targetType: 'strategy_version', targetId: v.id, result: 'SUCCESS', after: versionSummary(v), metadata: { packageId }, correlationId });
    return v;
  });
}

export async function editVersionDraft(admin: PublicUser, id: string, revision: number, raw: unknown, correlationId: string): Promise<StrategyVersionDto> {
  const draft = parse(strategyVersionDraftSchema, raw);
  await checkPairs(draft.instrumentIds);
  return getDb().transaction(async (tx) => {
    const r = await updateDraft(tx, id, revision, draft);
    if (!r.ok) throw r.reason === 'NOT_FOUND' ? notFound() : r.reason === 'IMMUTABLE' ? immutable() : conflict('draft');
    await recordAudit(tx, { actorUserId: admin.id, action: 'ADMIN_STRATEGY_DRAFT_UPDATE', targetType: 'strategy_version', targetId: id, result: 'SUCCESS', before: versionSummary(r.before), after: versionSummary(r.after), correlationId });
    return r.after;
  });
}

/** CFG-02: publishing creates an immutable version. Existing order blocks stay pinned to theirs. */
export async function publishVersion(admin: PublicUser, id: string, revision: number, correlationId: string): Promise<StrategyVersionDto> {
  return getDb().transaction(async (tx) => {
    const r = await publishDraft(tx, id, revision, admin.id);
    if (!r.ok) throw r.reason === 'NOT_FOUND' ? notFound() : r.reason === 'IMMUTABLE' ? immutable() : conflict('draft');
    await recordAudit(tx, { actorUserId: admin.id, action: 'ADMIN_STRATEGY_PUBLISH', targetType: 'strategy_version', targetId: id, result: 'SUCCESS', after: versionSummary(r.after), metadata: { packageId: r.after.packageId }, correlationId });
    return r.after;
  });
}
