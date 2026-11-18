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
      scope="Signals are stored and routed to each destination's order blocks. Whether an order is sent is decided per destination (contract status, mode, Live eligibility)."
    >
      <SignalsAdmin
        ingress={first ? { ...first, urlTemplate: `${appBaseUrl()}/v1/webhooks/tradingview/<token>` } : null}
        routes={routes}
        // All contracts: a DISABLED contract may still be a route's TradingView signal source (it takes
        // no entries). Target pickers offer published contracts only.
        instruments={instruments}
        packages={packages}
        events={events}
        rejections={rejections}
        timezone={user.timezone}
      />
    </PageContainer>
  );
}
