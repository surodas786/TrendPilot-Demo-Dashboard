import { AppShell } from '@/components/layout/AppShell';
import { requirePageRole } from '@/server/pageSession';

export const dynamic = 'force-dynamic';

export default async function InvestorLayout({ children }: { children: React.ReactNode }) {
  const { user } = await requirePageRole('INVESTOR');
  return (
    <AppShell role="INVESTOR" name={user.name}>
      {children}
    </AppShell>
  );
}
