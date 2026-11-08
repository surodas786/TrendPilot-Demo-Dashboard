import { tokenOnlySchema } from '@trendpilot/domain';
import { checkLink } from '@/server/accounts';
import { json, parseBody, route } from '@/server/http';

export const dynamic = 'force-dynamic';

/** Validates an invite link (token posted from the URL fragment) without consuming it. */
export const POST = route(async (req, { correlationId }) => {
  const { token } = await parseBody(req, tokenOnlySchema);
  return json(correlationId, await checkLink(token, 'INVITE'));
});
