import { getDb, listAllInstruments, listIngress, listPackages, listRecentRejections, listRecentSignalEvents, listSignalRoutes } from '@trendpilot/db';
import { SignalsAdmin } from '@/components/admin/SignalsAdmin';
import { PageContainer } from '@/components/layout/PageContainer';
import { appBaseUrl } from '@/server/mail';
import { requirePageRole } from '@/server/pageSession';

export const dynamic = 'force-dynamic';

export default async function AdminSignalsPage() {
  const { user } = await requirePageRole('ADMIN');
  const db = getDb();
  const [ingress, routes, instruments, packages, events, rejections] = await Promise.all([
    listIngress(db),
    listSignalRoutes(db),
    listAllInstruments(db),
    listPackages(db),
    listRecentSignalEvents(db, 50),
    listRecentRejections(db, 30)
  ]);
  const first = ingress[0];
  return (
    <PageContainer
      title="TradingView Webhook & Signal Routes"
      description="The central webhook, alert message templates, routes from TradingView charts to approved contracts and strategy lineages, and recent signal activity."
      scope="Signals are stored and routed to each investor's Paper order blocks. No orders are placed in this release."
    >
      <SignalsAdmin
        ingress={first ? { ...first, urlTemplate: `${appBaseUrl()}/v1/webhooks/tradingview/<token>` } : null}
        routes={routes}
        instruments={instruments.filter((i) => i.status === 'PUBLISHED')}
        packages={packages}
        events={events}
        rejections={rejections}
        timezone={user.timezone}
      />
    </PageContainer>
  );
}
