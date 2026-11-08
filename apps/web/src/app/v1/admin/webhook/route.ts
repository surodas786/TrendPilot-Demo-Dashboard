import { getDb, listIngress } from '@trendpilot/db';
import { json, route } from '@/server/http';
import { appBaseUrl } from '@/server/mail';
import { requireAdmin } from '@/server/session';

export const dynamic = 'force-dynamic';

/** Webhook metadata. The token is never returned here, only a short hint. */
export const GET = route(async (req, { correlationId }) => {
  await requireAdmin(req);
  const items = (await listIngress(getDb())).map((i) => ({ ...i, urlTemplate: `${appBaseUrl()}/v1/webhooks/tradingview/<token>` }));
  return json(correlationId, { items });
});
