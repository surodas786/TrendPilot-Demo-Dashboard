import { getDb, getMyPaperAccount, listMyLedger } from '@trendpilot/db';
import { json, route } from '@/server/http';
import { requireInvestor } from '@/server/session';

export const dynamic = 'force-dynamic';

/** GET /v1/me/ledger: the investor's own paper balance movements. */
export const GET = route(async (req, { correlationId }) => {
  const { user } = await requireInvestor(req);
  const db = getDb();
  return json(correlationId, { account: await getMyPaperAccount(db, user.id), items: await listMyLedger(db, user.id) });
});
