import { getDb, setInstrumentLiveAllowed } from '@trendpilot/db';
import { json, readJson, route } from '@/server/http';
import { requireAdmin } from '@/server/session';

export const dynamic = 'force-dynamic';

/** POST { allowed }: adds or removes a contract from the Live allowlist. */
export const POST = route<{ id: string }>(async (req, { correlationId, params }) => {
  const { user } = await requireAdmin(req);
  const b = (await readJson(req)) as Record<string, unknown>;
  await setInstrumentLiveAllowed(getDb(), user.id, params.id, b.allowed === true, correlationId);
  return json(correlationId, { id: params.id, liveAllowed: b.allowed === true });
});
