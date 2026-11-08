import { tokenOnlySchema } from '@trendpilot/domain';
import { checkLink } from '@/server/accounts';
import { json, parseBody, route } from '@/server/http';

export const dynamic = 'force-dynamic';

export const POST = route(async (req, { correlationId }) => {
  const { token } = await parseBody(req, tokenOnlySchema);
  return json(correlationId, await checkLink(token, 'RESET'));
});
