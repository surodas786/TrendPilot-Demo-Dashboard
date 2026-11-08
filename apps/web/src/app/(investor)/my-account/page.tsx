import { FlaskConicalIcon, KeyRoundIcon, PlugZapIcon, UserRoundIcon, type LucideIcon } from 'lucide-react';
import { PageContainer } from '@/components/layout/PageContainer';
import { SecurityPanel } from '@/components/account/SecurityPanel';
import { StatusPill } from '@/components/ui/StatusPill';
import { requirePageRole } from '@/server/pageSession';

export const dynamic = 'force-dynamic';

function Card({ icon: Icon, title, children }: { icon: LucideIcon; title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-line bg-surface p-5">
      <h3 className="flex items-center gap-2 text-sm font-semibold text-ink">
        <Icon className="h-4 w-4 text-subtle" aria-hidden />
        {title}
      </h3>
      <div className="mt-4">{children}</div>
    </section>
  );
}

function Field({ label, value, testId }: { label: string; value: React.ReactNode; testId?: string }) {
  return (
    <div>
      <dt className="text-xs text-subtle">{label}</dt>
      <dd className="mt-0.5 text-sm text-ink" data-testid={testId}>
        {value}
      </dd>
    </div>
  );
}

/**
 * UI-02 My Account: the fixed signed-in scope. The profile comes from the server-side
 * session only; there is no account selector and no way to view another investor.
 */
export default async function MyAccountPage() {
  const { user } = await requirePageRole('INVESTOR');
  return (
    <PageContainer title="My Account" description="Your profile and account setup. Everything here belongs to the signed-in investor only." scope={`${user.name} · My Account`}>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card icon={UserRoundIcon} title="Profile">
          <dl className="grid gap-4 sm:grid-cols-2">
            <Field label="Name" value={user.name} testId="profile-name" />
            <Field label="Email" value={user.email} testId="profile-email" />
            <Field label="Role" value="Investor" />
            <Field label="Status" value={<StatusPill tone={user.status === 'ACTIVE' ? 'gain' : 'warn'}>{user.status === 'ACTIVE' ? 'Active' : user.status}</StatusPill>} />
            <Field label="Reporting timezone" value={user.timezone} testId="profile-timezone" />
          </dl>
          <p className="mt-4 text-xs text-subtle">Profile details are managed by your administrator.</p>
        </Card>

        <Card icon={KeyRoundIcon} title="Security">
          <SecurityPanel mfaEnabled={user.mfaEnabled} timezone={user.timezone} />
        </Card>

        <Card icon={FlaskConicalIcon} title="Paper trading">
          <p className="text-sm text-muted">Order blocks in Trade Settings use Paper mode. Paper execution starts in the next milestone; no orders are placed yet.</p>
        </Card>

        <Card icon={PlugZapIcon} title="Exchange connection">
          <div className="flex flex-wrap items-center gap-2">
            <StatusPill tone="neutral">Not connected</StatusPill>
            <StatusPill tone="warn">Live trading disabled</StatusPill>
          </div>
          <p className="mt-3 text-sm text-muted">
            Connecting your own MEXC Futures account is not part of this release. Live order submission stays disabled in this build, and no exchange credentials are stored.
          </p>
        </Card>
      </div>
    </PageContainer>
  );
}
