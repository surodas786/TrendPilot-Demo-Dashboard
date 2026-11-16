import { and, eq, sql } from 'drizzle-orm';
import { Decimal, DomainError, ErrorCode } from '@trendpilot/domain';
import type { Db } from '../client';
import { leverageChoicesFor } from '../mexcFixtures';
import { recordAudit } from '../repos/audit';
import { instruments } from '../schema';
import { BitunixPublicClient, discoverBitunixContracts, parseBitunixTradingPairs, type BitunixContract } from './bitunixPublic';
import { pairContractSource } from './contractCatalog';

/**
 * Bitunix contracts as platform instruments (Step 3), for the execution path. One row per
 * (exchange, symbol), so BTCUSDT on Bitunix and BTCUSDT on MEXC are separate instruments with
 * separate quotes, orders and positions. Bitunix quantities are in the BASE coin: the contract
 * multiplier is 1, the quantity step is 10^-basePrecision, the minimum is the minimum opening
 * quantity and the maximum is the maximum MARKET order quantity (TrendPilot sends market orders).
 *
 * A new row starts DISABLED and not allowed for Live; an administrator publishes it and allows it
 * for Live as for any contract. Refreshing an existing row updates only the exchange's trading
 * rules, never its status, Live allowlist or suggested settings.
 */

/** Bitunix's standard USDT-M taker fee. trading_pairs does not report fees; the fills carry the real ones. */
export const BITUNIX_DEFAULT_TAKER_FEE_RATE = '0.0006';

/** Local contract data for tests and demo mode (captured from the live API on 2026-11-16). */
export const BITUNIX_FIXTURE_TRADING_PAIRS = {
  code: 0,
  msg: 'Success',
  data: [
    { symbol: 'BTCUSDT', base: 'BTC', quote: 'USDT', minTradeVolume: '0.0001', maxLimitOrderVolume: '1200', maxMarketOrderVolume: '120', basePrecision: 4, quotePrecision: 1, maxLeverage: 200, minLeverage: 1, defaultLeverage: 10, defaultMarginMode: '2', priceProtectScope: '0.01', symbolStatus: 'OPEN', isApiSupported: true, launchTime: '1719403200000' },
    { symbol: 'XAUUSDT', base: 'XAU', quote: 'USDT', minTradeVolume: '0.002', maxLimitOrderVolume: '2000', maxMarketOrderVolume: '200', basePrecision: 3, quotePrecision: 2, maxLeverage: 200, minLeverage: 1, defaultLeverage: 10, defaultMarginMode: '2', priceProtectScope: '0.05', symbolStatus: 'OPEN', isApiSupported: true, launchTime: '1770724800000' }
  ]
};

export async function upsertBitunixInstrument(db: Db, actorId: string | null, c: BitunixContract, o: { isFixture: boolean; correlationId?: string }): Promise<typeof instruments.$inferSelect> {
  const spec = {
    exchangeSymbol: c.exchangeSymbol,
    base: c.base,
    quote: 'USDT',
    contractMultiplier: '1',
    qtyStep: c.qtyStep,
    minQty: c.minTradeVolume,
    maxQty: c.maxMarketOrderVolume ?? c.maxLimitOrderVolume ?? c.minTradeVolume,
    priceTick: c.priceTick,
    takerFeeRate: BITUNIX_DEFAULT_TAKER_FEE_RATE,
    leverageChoices: leverageChoicesFor(c.maxLeverage ?? 1, c.minLeverage ?? 1),
    isFixture: o.isFixture
  };
  if (!new Decimal(spec.maxQty).gte(spec.minQty)) throw new DomainError(409, ErrorCode.CONFLICT, `${c.exchangeSymbol}: maximum market quantity is below the minimum opening quantity.`);
  // Suggested settings start from the MEXC instrument for the same contract, when there is one.
  const [mexc] = await db.select().from(instruments).where(and(eq(instruments.exchange, 'MEXC'), eq(instruments.symbol, c.exchangeSymbol)));
  const [row] = await db
    .insert(instruments)
    .values({
      exchange: 'BITUNIX',
      symbol: c.exchangeSymbol,
      status: 'DISABLED',
      suggestedStopPct: mexc?.suggestedStopPct ?? '1.5',
      suggestedTakeProfitPct: mexc?.suggestedTakeProfitPct ?? '3',
      suggestedTrailingEnabled: mexc?.suggestedTrailingEnabled ?? false,
      suggestedTrailingPct: mexc?.suggestedTrailingPct ?? '1',
      ...spec
    })
    .onConflictDoUpdate({ target: [instruments.exchange, instruments.symbol], set: { ...spec, revision: sql`${instruments.revision} + 1`, updatedAt: sql`now()` } })
    .returning();
  await recordAudit(db, { actorUserId: actorId, action: 'ADMIN_INSTRUMENT_BITUNIX_UPSERT', targetType: 'instrument', targetId: row!.id, result: 'SUCCESS', metadata: { symbol: c.exchangeSymbol, ...spec, leverageChoices: spec.leverageChoices.join(',') }, correlationId: o.correlationId ?? 'bitunix' });
  return row!;
}

/**
 * Validates a Bitunix contract (open, API-enabled, USDT, launched) and adds or refreshes it as an
 * instrument. Source: the public Bitunix API in a deployed app, the local fixture elsewhere
 * (PAIR_VALIDATION_SOURCE, as for MEXC pairs).
 */
export async function addBitunixInstrument(db: Db, actorId: string, symbol: string, o: { env?: Record<string, string | undefined>; client?: Pick<BitunixPublicClient, 'tradingPairs'>; correlationId?: string } = {}) {
  const live = pairContractSource(o.env ?? process.env) === 'MEXC_PUBLIC';
  const client = o.client ?? (live ? new BitunixPublicClient() : { tradingPairs: async () => parseBitunixTradingPairs(BITUNIX_FIXTURE_TRADING_PAIRS) });
  const d = await discoverBitunixContracts(client, [symbol]);
  const r = d.results[symbol]!;
  if (!r.ok) throw new DomainError(r.reason === 'INVALID_INPUT' ? 400 : 409, r.reason === 'INVALID_INPUT' ? ErrorCode.VALIDATION_FAILED : ErrorCode.CONFLICT, r.message);
  const row = await upsertBitunixInstrument(db, actorId, r.contract, { isFixture: !live && !o.client, correlationId: o.correlationId });
  return { instrument: row, warnings: r.warnings, source: live ? 'BITUNIX_PUBLIC' : 'FIXTURE' };
}
