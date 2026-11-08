import React from 'react';
import { Link, useLocation } from 'react-router-dom';
import { MailIcon, PlugZapIcon, ShieldOffIcon } from 'lucide-react';
import { useDemo } from '../../contexts/DemoContext';
import { EmptyState } from '../ui/EmptyState';
import { Button } from '../ui/Button';

/** Pages a subscriber without any paper account can still open (they start with empty states). */
const NO_ACCOUNT_PAGES = ['/exchange-connections', '/trade-settings', '/holdings', '/trade-history', '/funds-funding', '/reports', '/signals', '/logs', '/settings', '/demo-center'];

/**
 * Simulated subscriber access. Suspended or not-yet-activated subscribers cannot enter
 * the subscriber demo; subscribers without an account never see another user's data.
 */
export function SubscriberAccessGate({ children }: {children: React.ReactNode;}) {
  const { state, currentUser, accounts, setRole } = useDemo();
  const { pathname } = useLocation();
  if (state.role !== 'trader') return <>{children}</>;

  const wrap = (node: React.ReactNode) => <div className="mx-auto w-full max-w-2xl px-4 py-10 lg:px-6">{node}</div>;
  const backToAdmin =
  <Button variant="secondary" onClick={() => setRole('admin')}>
      Return to Administrator
    </Button>;


  if (currentUser.status === 'suspended') {
    return wrap(
      <EmptyState icon={ShieldOffIcon} title="Account suspended" body={`${currentUser.name}’s subscriber access is suspended in this demo. Ask an administrator to reactivate the account.`}>
        {backToAdmin}
      </EmptyState>
    );
  }
  if (currentUser.status === 'invited') {
    return wrap(
      <EmptyState icon={MailIcon} title="Account not activated yet" body={`${currentUser.name} has not completed account setup from the simulated invitation.`}>
        {backToAdmin}
      </EmptyState>
    );
  }
  if (accounts.length === 0 && !NO_ACCOUNT_PAGES.includes(pathname)) {
    return wrap(
      <EmptyState icon={PlugZapIcon} title="No dashboard data yet" body={`${currentUser.name} has no dashboard history. Paper trading needs no exchange connection — add a token in Trade Settings and follow results in Holdings.`}>
        <Link to="/trade-settings" className="inline-flex h-10 items-center rounded-lg bg-accent px-3.5 text-sm font-semibold text-accent-ink transition-colors duration-150 hover:bg-accent/90">
          Open Trade Settings
        </Link>
      </EmptyState>
    );
  }
  return <>{children}</>;
}