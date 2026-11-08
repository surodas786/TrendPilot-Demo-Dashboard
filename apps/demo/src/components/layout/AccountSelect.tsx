import React from 'react';
import { UserRoundIcon } from 'lucide-react';
import { exchanges } from '../../data/mockData';
import { useDemo } from '../../contexts/DemoContext';
import { connectionStatus, entryState, STATUS_LABELS } from '../../utils/connectionHealth';
import { SelectMenu } from '../ui/SelectMenu';
import { cn } from '../../utils/cn';

export function AccountSelect({ align = 'right', triggerClassName }: {align?: 'left' | 'right';triggerClassName?: string;}) {
  const { state, accounts, setAccount } = useDemo();
  if (accounts.length === 0) {
    return (
      <span className={cn('inline-flex h-9 items-center gap-2 rounded-lg border border-line bg-inset px-3 text-sm text-muted', triggerClassName)}>
        <UserRoundIcon className="h-4 w-4 text-subtle" aria-hidden />
        No trading account
      </span>);

  }
  return (
    <SelectMenu
      label="Account"
      heading="Trading accounts"
      icon={UserRoundIcon}
      align={align}
      value={state.accountId}
      onChange={setAccount}
      triggerClassName={triggerClassName}
      options={accounts.map((a) => ({
        value: a.id,
        label: a.name,
        description: `${exchanges.find((e) => e.id === a.exchangeId)?.name ?? ''} · ${a.environment === 'live' ? 'Live — simulated' : 'Paper'} · ${a.environment === 'live' ? STATUS_LABELS[connectionStatus(a)] : 'Paper account simulation'} · Entries ${entryState(a).label.toLowerCase()}`
      }))} />);


}