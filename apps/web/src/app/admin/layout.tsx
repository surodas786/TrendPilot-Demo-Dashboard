import { AppShell } from '@/components/layout/AppShell';
import { requirePageRole } from '@/server/pageSession';

export const dynamic = 'force-dynamic';

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const { user } = await requirePageRole('ADMIN');
  return (
    <AppShell role="ADMIN" name={user.name}>
      {children}
    </AppShell>
  );
}
