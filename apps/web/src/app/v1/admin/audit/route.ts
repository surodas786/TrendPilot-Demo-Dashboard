import { getDb, listAudit } from '@trendpilot/db';
import { json, route } from '@/server/http';
import { requireAdmin } from '@/server/session';

export const dynamic = 'force-dynamic';

/** OPS-04 audit history: actor, time and action. Cursor-paginated. */
export const GET = route(async (req, { correlationId }) => {
  await requireAdmin(req);
  const url = new URL(req.url);
  const limit = Number(url.searchParams.get('limit') ?? 50);
  return json(
    correlationId,
    await listAudit(getDb(), {
      cursor: url.searchParams.get('cursor') ?? undefined,
      limit: Number.isFinite(limit) ? limit : 50,
      actionPrefix: url.searchParams.get('action') ?? undefined
    })
  );
});
