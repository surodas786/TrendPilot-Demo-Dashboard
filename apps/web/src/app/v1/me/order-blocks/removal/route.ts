import { json, readJson, route, validationError } from '@/server/http';
import { removalPreview, removeBlocks } from '@/server/orderBlocks';
import { requireInvestor } from '@/server/session';

export const dynamic = 'force-dynamic';

/** GET: preview of "Remove unused" — the blocks that would be removed (deleted or archived) and why the others stay. Read-only. */
export const GET = route(async (req, { correlationId }) => {
  const { user } = await requireInvestor(req);
  return json(correlationId, await removalPreview(user));
});

const idsOf = (raw: unknown): string[] | null => {
  const ids = (raw as { ids?: unknown } | null)?.ids;
  return Array.isArray(ids) && ids.length >= 1 && ids.length <= 200 && ids.every((x) => typeof x === 'string' && x.length <= 64) ? (ids as string[]) : null;
};

/** POST { ids }: removes those blocks after rechecking ownership and eligibility for each one. */
export const POST = route(async (req, { correlationId }) => {
  const { user } = await requireInvestor(req);
  const ids = idsOf(await readJson(req));
  if (!ids) throw validationError([{ path: 'ids', message: 'Send the IDs of 1–200 order blocks to remove.' }]);
  return json(correlationId, await removeBlocks(user, ids, correlationId));
});
