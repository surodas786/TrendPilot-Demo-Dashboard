import { getDb, pilotForInvestor, pilotReadiness } from '@trendpilot/db';
import { json, route } from '@/server/http';
import { requireInvestor } from '@/server/session';

export const dynamic = 'force-dynamic';

/** The live pilot offered to the signed-in investor, or null. Never shows another investor's pilot. */
export const GET = route(async (req, { correlationId }) => {
  const { user } = await requireInvestor(req);
  const p = await pilotForInvestor(getDb(), user.id);
  if (!p) return json(correlationId, { pilot: null, liveOrderSubmission: 'disabled' });
  return json(correlationId, {
    pilot: {
      id: p.id,
      status: p.status,
      instrumentId: p.instrumentId,
      exchangeAccountRef: p.exchangeAccountRef,
      limits: { maxOrderContracts: p.maxOrderContracts, maxOrderNotionalUsdt: p.maxOrderNotionalUsdt, maxLeverage: p.maxLeverage, maxExposureUsdt: p.maxExposureUsdt },
      allowAdds: false,
      allowReversal: false,
      approvedAt: p.approvedAt,
      investorActivatedAt: p.investorActivatedAt,
      entriesHalted: p.entriesHalted,
      haltReason: p.haltReason
    },
    readyForFirstTrade: pilotReadiness(p).readyForFirstTrade,
    liveOrderSubmission: 'disabled'
  });
});
