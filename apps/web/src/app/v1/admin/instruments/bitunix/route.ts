import { addBitunixInstrument, getDb } from '@trendpilot/db';
import { json, readJson, route } from '@/server/http';
import { requireAdmin } from '@/server/session';

export const dynamic = 'force-dynamic';

/**
 * POST { symbol }: validates a Bitunix Futures contract (open, API-enabled, USDT) and adds or
 * refreshes it as a Bitunix instrument (contract multiplier 1, base-coin quantity step, minimum
 * opening and maximum market quantity, price tick, leverage choices). A new instrument starts
 * DISABLED and not allowed for Live; publish and allow it as for any contract.
 */
export const POST = route(async (req, { correlationId }) => {
  const { user } = await requireAdmin(req);
  const b = (await readJson(req)) as Record<string, unknown>;
  const r = await addBitunixInstrument(getDb(), user.id, typeof b.symbol === 'string' ? b.symbol : '', { correlationId });
  return json(correlationId, { instrument: { id: r.instrument.id, exchange: r.instrument.exchange, symbol: r.instrument.symbol, exchangeSymbol: r.instrument.exchangeSymbol, qtyStep: r.instrument.qtyStep, minQty: r.instrument.minQty, maxQty: r.instrument.maxQty, priceTick: r.instrument.priceTick, contractMultiplier: r.instrument.contractMultiplier, leverageChoices: r.instrument.leverageChoices, status: r.instrument.status, liveAllowed: r.instrument.liveAllowed, isFixture: r.instrument.isFixture }, warnings: r.warnings, source: r.source });
});
