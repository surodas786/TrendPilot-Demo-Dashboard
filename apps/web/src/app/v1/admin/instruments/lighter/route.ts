import { addLighterInstrument, getDb } from '@trendpilot/db';
import { json, readJson, route } from '@/server/http';
import { requireAdmin } from '@/server/session';

export const dynamic = 'force-dynamic';

/**
 * POST { market }: validates a Lighter market (exact native symbol, e.g. "XAU", or market ID, e.g.
 * "92") against the official catalog of the Ethereum-based Lighter mainnet and adds or refreshes it
 * as a Lighter instrument. Only active, Lighter-deployed USDC perpetuals are accepted. A new
 * instrument starts DISABLED and not allowed for Live; publish it as any pair. Lighter trading
 * (connection, prices, orders) is not available yet. Read-only towards Lighter.
 */
export const POST = route(async (req, { correlationId }) => {
  const { user } = await requireAdmin(req);
  const b = (await readJson(req)) as Record<string, unknown>;
  const raw = typeof b.market === 'string' ? b.market : typeof b.market === 'number' ? String(b.market) : '';
  const r = await addLighterInstrument(getDb(), user.id, raw, { correlationId });
  const i = r.instrument;
  return json(correlationId, {
    instrument: { id: i.id, exchange: i.exchange, symbol: i.symbol, exchangeSymbol: i.exchangeSymbol, marketId: i.exchangeMarketId, base: i.base, quote: i.quote, qtyStep: i.qtyStep, minQty: i.minQty, minNotional: i.minNotional, priceTick: i.priceTick, contractMultiplier: i.contractMultiplier, leverageChoices: i.leverageChoices, status: i.status, liveAllowed: i.liveAllowed, isFixture: i.isFixture },
    market: { marketId: r.market.marketId, symbol: r.market.symbol, marketType: r.market.marketType, status: r.market.status, settlementCurrency: r.settlementCurrency, environment: r.environment, sizeDecimals: r.market.sizeDecimals, priceDecimals: r.market.priceDecimals, minBaseAmount: r.market.minBaseAmount, minQuoteAmount: r.market.minQuoteAmount, maxLeverage: r.maxLeverage },
    source: r.source
  });
});
