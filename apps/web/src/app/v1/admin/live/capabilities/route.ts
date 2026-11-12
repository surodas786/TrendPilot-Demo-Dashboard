import { getDb, liveControlDto, MEXC_CAPABILITIES, recordCapabilityEvidence, type CapabilityId } from '@trendpilot/db';
import { DomainError, ErrorCode } from '@trendpilot/domain';
import { json, readJson, route } from '@/server/http';
import { requireAdmin } from '@/server/session';

export const dynamic = 'force-dynamic';

/** POST { capability, state: VERIFIED | PILOT_ACCEPTED | PENDING, evidence }: records the operator's evidence. */
export const POST = route(async (req, { correlationId }) => {
  const { user } = await requireAdmin(req);
  const b = (await readJson(req)) as Record<string, unknown>;
  const id = String(b.capability ?? '') as CapabilityId;
  if (!MEXC_CAPABILITIES.some((c) => c.id === id)) throw new DomainError(400, ErrorCode.VALIDATION_FAILED, 'Unknown capability.');
  return json(correlationId, { control: liveControlDto(await recordCapabilityEvidence(getDb(), user.id, id, String(b.state ?? '') as 'VERIFIED', String(b.evidence ?? ''), correlationId)) });
});
