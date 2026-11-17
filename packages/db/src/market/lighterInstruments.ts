import { and, eq } from 'drizzle-orm';
import { Decimal, DomainError, ErrorCode } from '@trendpilot/domain';
import type { Db } from '../client';
import { leverageChoicesFor } from '../mexcFixtures';
import { recordAudit } from '../repos/audit';
import { instruments } from '../schema';
import { pairContractSource } from './contractCatalog';
import { assertLighterMainnet, findLighterMarket, LIGHTER_MAINNET, LighterPublicClient, LighterPublicError, parseLighterOrderBookDetails, type LighterEnvironmentIdentity, type LighterMarket } from './lighterPublic';

/**
 * Lighter markets as platform instruments (Lighter plan, Step 1). Registration only: the row lets an
 * administrator publish a market and investors select it; no prices, connection or orders exist for
 * Lighter yet, and every Live path refuses it (exchangeUnavailableReason).
 *
 * One row per (exchange, native symbol), addressed by the catalog's market ID
 * (`exchange_market_id`), which is never derived from a ticker. Quantities are in the base asset
 * (`base_amount = size × 10^size_decimals`, docs core-concepts): contract multiplier 1, quantity step
 * 10^-size_decimals, price tick 10^-price_decimals, minimum quantity `min_base_amount`, minimum order
 * value `min_quote_amount` USDC. Lighter reports no maximum base quantity per order (only a USDC
 * order limit): max_qty keeps the column default and must not be used for Lighter sizing.
 * A new row starts DISABLED and not allowed for Live. A refresh updates the exchange's rules only,
 * never status or suggestions, and refuses when the symbol now points at another market ID.
 */

/** Captured from the public Lighter mainnet catalog (GET /api/v1/orderBookDetails) on 2026-11-17: XAU and BTC perps (active), SOXS (inactive), ASELS (externally deployed, inactive) and the XAUT/USDC SPOT market. Subset of fields. */
export const LIGHTER_FIXTURE_ORDER_BOOK_DETAILS = {
  "code": 200,
  "order_book_details": [
    {
      "symbol": "ASELS",
      "market_id": 8286,
      "market_type": "perp",
      "base_asset_id": 0,
      "quote_asset_id": 0,
      "status": "inactive",
      "taker_fee": "0.0000",
      "maker_fee": "0.0000",
      "min_base_amount": "1.50",
      "min_quote_amount": "10.000000",
      "order_quote_limit": "50000.000000",
      "supported_size_decimals": 2,
      "supported_price_decimals": 4,
      "supported_quote_decimals": 6,
      "size_decimals": 2,
      "price_decimals": 4,
      "end_timestamp": 0,
      "settlement_type": 0,
      "outcome": 0,
      "is_frozen": false,
      "market_deployer": "external",
      "default_initial_margin_fraction": 3333,
      "min_initial_margin_fraction": 3333,
      "maintenance_margin_fraction": 2000,
      "closeout_margin_fraction": 1333,
      "market_config": {
        "market_margin_mode": 0,
        "trading_hours": "",
        "hidden": false,
        "force_reduce_only": false
      }
    },
    {
      "symbol": "SOXS",
      "market_id": 222,
      "market_type": "perp",
      "base_asset_id": 0,
      "quote_asset_id": 0,
      "status": "inactive",
      "taker_fee": "0.0000",
      "maker_fee": "0.0000",
      "min_base_amount": "0.100",
      "min_quote_amount": "10.000000",
      "order_quote_limit": "50000000.000000",
      "supported_size_decimals": 3,
      "supported_price_decimals": 3,
      "supported_quote_decimals": 6,
      "size_decimals": 3,
      "price_decimals": 3,
      "end_timestamp": 0,
      "settlement_type": 0,
      "outcome": 0,
      "is_frozen": false,
      "market_deployer": "lighter",
      "default_initial_margin_fraction": 1000,
      "min_initial_margin_fraction": 1000,
      "maintenance_margin_fraction": 600,
      "closeout_margin_fraction": 400,
      "market_config": {
        "market_margin_mode": 0,
        "trading_hours": "",
        "hidden": false,
        "force_reduce_only": true
      }
    },
    {
      "symbol": "BTC",
      "market_id": 1,
      "market_type": "perp",
      "base_asset_id": 0,
      "quote_asset_id": 0,
      "status": "active",
      "taker_fee": "0.0000",
      "maker_fee": "0.0000",
      "min_base_amount": "0.00007",
      "min_quote_amount": "10.000000",
      "order_quote_limit": "281474976.710655",
      "supported_size_decimals": 5,
      "supported_price_decimals": 1,
      "supported_quote_decimals": 6,
      "size_decimals": 5,
      "price_decimals": 1,
      "end_timestamp": 0,
      "settlement_type": 0,
      "outcome": 0,
      "is_frozen": false,
      "market_deployer": "lighter",
      "default_initial_margin_fraction": 500,
      "min_initial_margin_fraction": 200,
      "maintenance_margin_fraction": 120,
      "closeout_margin_fraction": 80,
      "market_config": {
        "market_margin_mode": 0,
        "trading_hours": "",
        "hidden": false,
        "force_reduce_only": false
      }
    },
    {
      "symbol": "XAU",
      "market_id": 92,
      "market_type": "perp",
      "base_asset_id": 0,
      "quote_asset_id": 0,
      "status": "active",
      "taker_fee": "0.0000",
      "maker_fee": "0.0000",
      "min_base_amount": "0.0015",
      "min_quote_amount": "10.000000",
      "order_quote_limit": "5000000.000000",
      "supported_size_decimals": 4,
      "supported_price_decimals": 2,
      "supported_quote_decimals": 6,
      "size_decimals": 4,
      "price_decimals": 2,
      "end_timestamp": 0,
      "settlement_type": 0,
      "outcome": 0,
      "is_frozen": false,
      "market_deployer": "lighter",
      "default_initial_margin_fraction": 666,
      "min_initial_margin_fraction": 400,
      "maintenance_margin_fraction": 240,
      "closeout_margin_fraction": 160,
      "market_config": {
        "market_margin_mode": 0,
        "trading_hours": "",
        "hidden": false,
        "force_reduce_only": false
      }
    }
  ],
  "spot_order_book_details": [
    {
      "symbol": "XAUT/USDC",
      "market_id": 2056,
      "market_type": "spot",
      "base_asset_id": 11,
      "quote_asset_id": 3,
      "status": "active",
      "taker_fee": "0.0000",
      "maker_fee": "0.0000",
      "min_base_amount": "0.0015",
      "min_quote_amount": "10.000000",
      "order_quote_limit": "281474976.710655",
      "supported_size_decimals": 4,
      "supported_price_decimals": 2,
      "supported_quote_decimals": 6,
      "size_decimals": 4,
      "price_decimals": 2,
      "end_timestamp": 0,
      "settlement_type": 0,
      "outcome": 0,
      "is_frozen": false,
      "market_deployer": "lighter"
    }
  ]
} as const;

/** Environment identity of the fixture catalog (the mainnet values, as captured). */
export const LIGHTER_FIXTURE_ENVIRONMENT: LighterEnvironmentIdentity = { networkId: LIGHTER_MAINNET.networkId, contractAddress: LIGHTER_MAINNET.contractAddress };

export interface LighterCatalogSource {
  environment(): Promise<LighterEnvironmentIdentity>;
  markets(): Promise<LighterMarket[]>;
}

export const lighterFixtureCatalog = (): LighterCatalogSource => ({
  environment: async () => LIGHTER_FIXTURE_ENVIRONMENT,
  markets: async () => parseLighterOrderBookDetails(LIGHTER_FIXTURE_ORDER_BOOK_DETAILS)
});

const pow10neg = (n: number) => new Decimal(1).div(new Decimal(10).pow(n)).toFixed();

/** The catalog market → instrument trading rules. */
export function lighterInstrumentSpec(m: LighterMarket, maxLeverage: number) {
  return {
    exchangeSymbol: m.symbol,
    exchangeMarketId: m.marketId,
    base: m.symbol,
    quote: LIGHTER_MAINNET.settlementCurrency,
    contractMultiplier: '1',
    qtyStep: pow10neg(m.sizeDecimals),
    minQty: m.minBaseAmount,
    minNotional: m.minQuoteAmount,
    priceTick: pow10neg(m.priceDecimals),
    // Eligibility requires the catalog fee to be 0 (the unit of a non-zero value is undocumented).
    takerFeeRate: '0',
    leverageChoices: leverageChoicesFor(maxLeverage, 1)
  };
}

export type LighterImportSource = 'LIGHTER_PUBLIC' | 'FIXTURE';

/**
 * Validates a Lighter market against the official catalog of the Ethereum mainnet and adds or
 * refreshes it as a DISABLED instrument. Source: the public Lighter API in a deployed app, the
 * captured fixture elsewhere (PAIR_VALIDATION_SOURCE, as for MEXC and Bitunix pairs). A catalog
 * that cannot be read is an error: nothing falls back to fixtures or to another exchange.
 */
export async function addLighterInstrument(
  db: Db,
  actorId: string,
  input: string,
  o: { env?: Record<string, string | undefined>; catalog?: LighterCatalogSource; correlationId?: string } = {}
) {
  const env = o.env ?? process.env;
  const live = pairContractSource(env) === 'MEXC_PUBLIC';
  const catalog = o.catalog ?? (live ? new LighterPublicClient({ baseUrl: env.LIGHTER_PUBLIC_BASE_URL || undefined }) : lighterFixtureCatalog());
  let markets: LighterMarket[];
  try {
    assertLighterMainnet(await catalog.environment());
    markets = await catalog.markets();
  } catch (e) {
    if (e instanceof LighterPublicError && e.kind === 'WRONG_ENVIRONMENT') throw new DomainError(409, ErrorCode.CONFLICT, e.message);
    if (e instanceof LighterPublicError) throw new DomainError(503, ErrorCode.EXCHANGE_UNAVAILABLE, `The Lighter market catalog could not be read (${e.kind}). Nothing was added; try again later.`);
    throw e;
  }
  const r = findLighterMarket(markets, input);
  if (!r.ok) throw new DomainError(r.reason === 'INVALID_INPUT' ? 400 : r.reason === 'UNKNOWN_MARKET' ? 404 : 409, r.reason === 'INVALID_INPUT' ? ErrorCode.VALIDATION_FAILED : r.reason === 'UNKNOWN_MARKET' ? ErrorCode.NOT_FOUND : ErrorCode.CONFLICT, r.message);
  const spec = { ...lighterInstrumentSpec(r.market, r.maxLeverage), isFixture: !live && !o.catalog };
  const row = await db.transaction(async (tx) => {
    const [existing] = await tx.select().from(instruments).where(and(eq(instruments.exchange, 'LIGHTER'), eq(instruments.symbol, r.market.symbol)));
    if (existing && existing.exchangeMarketId !== r.market.marketId) {
      throw new DomainError(409, ErrorCode.CONFLICT, `Lighter ${r.market.symbol} is registered as market ${existing.exchangeMarketId} but the catalog now lists market ${r.market.marketId}. Nothing was changed; review the market before re-registering it.`);
    }
    const [saved] = existing
      ? await tx
          .update(instruments)
          .set({ ...spec, revision: existing.revision + 1, updatedAt: new Date() })
          .where(eq(instruments.id, existing.id))
          .returning()
      : await tx
          .insert(instruments)
          .values({ exchange: 'LIGHTER', symbol: r.market.symbol, status: 'DISABLED', liveAllowed: false, suggestedStopPct: '1.5', suggestedTakeProfitPct: '3', suggestedTrailingEnabled: false, suggestedTrailingPct: '1', ...spec })
          .returning();
    await recordAudit(tx, {
      actorUserId: actorId,
      action: 'ADMIN_INSTRUMENT_LIGHTER_UPSERT',
      targetType: 'instrument',
      targetId: saved!.id,
      result: 'SUCCESS',
      metadata: { marketId: r.market.marketId, symbol: r.market.symbol, settlement: r.settlementCurrency, environment: LIGHTER_MAINNET.environment, source: live ? 'LIGHTER_PUBLIC' : 'FIXTURE', ...spec, leverageChoices: spec.leverageChoices.join(',') },
      correlationId: o.correlationId ?? 'lighter'
    });
    return saved!;
  });
  return { instrument: row, market: r.market, settlementCurrency: r.settlementCurrency, maxLeverage: r.maxLeverage, environment: LIGHTER_MAINNET.environment, source: (live ? 'LIGHTER_PUBLIC' : 'FIXTURE') as LighterImportSource };
}
