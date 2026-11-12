import { PageContainer } from '@/components/layout/PageContainer';
import { LiveTradingClient } from '@/components/live/LiveTradingClient';
import { liveStatusFor } from '@/server/live';
import { requirePageRole } from '@/server/pageSession';

export const dynamic = 'force-dynamic';

/** Live Trading: the investor's own MEXC connection, activation (default Off) and halt control. */
export default async function LiveTradingPage() {
  const { user } = await requirePageRole('INVESTOR');
  return (
    <PageContainer
      title="Live Trading"
      description="Connect your own MEXC Futures account and switch Live on or off. Live uses the same strategy rules and prices as Paper, with a separate balance, orders and positions."
      scope={`${user.name} · Live Trading`}
    >
      <LiveTradingClient initial={await liveStatusFor(user.id)} />
    </PageContainer>
  );
}
