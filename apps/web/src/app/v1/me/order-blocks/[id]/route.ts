import { DomainError, ErrorCode, notFound } from '@trendpilot/domain';
import { etag, json, readJson, requireRevision, route } from '@/server/http';
import { getBlock, removeBlocks, updateBlock } from '@/server/orderBlocks';
import { requireInvestor } from '@/server/session';

export const dynamic = 'force-dynamic';

type Params = { id: string };

/** Unknown and unowned IDs both answer 404 NOT_FOUND (§10.1). */
export const GET = route<Params>(async (req, { correlationId, params }) => {
  const { user } = await requireInvestor(req);
  const block = await getBlock(user, params.id);
  return json(correlationId, block, 200, { etag: etag(block.revision) });
});

/**
 * DELETE: removes one paused, unused block (Trade Settings → Remove). Rechecked on the server:
 * a block with an open position, an unfinished order or a pending reversal is kept (409 with the
 * reasons). A block with history is archived, not deleted.
 */
export const DELETE = route<Params>(async (req, { correlationId, params }) => {
  const { user } = await requireInvestor(req);
  const r = await removeBlocks(user, [params.id], correlationId);
  const kept = r.kept[0];
  if (kept && !kept.symbol) throw notFound();
  if (kept) throw new DomainError(409, ErrorCode.CONFLICT, `${kept.symbol} is kept: ${kept.reasons.map((x) => x.text).join(' ')}`);
  return json(correlationId, r.removed[0]);
});

/** PATCH with If-Match revision; edits apply to future entries (CFG-05). */
export const PATCH = route<Params>(async (req, { correlationId, params }) => {
  const { user } = await requireInvestor(req);
  const revision = requireRevision(req);
  const block = await updateBlock(user, params.id, revision, await readJson(req), correlationId);
  return json(correlationId, block, 200, { etag: etag(block.revision) });
});
