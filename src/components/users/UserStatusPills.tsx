import React from 'react';
import { CheckIcon, CircleDotIcon, ClockIcon, MailIcon, PauseCircleIcon } from 'lucide-react';
import { StatusPill } from '../ui/StatusPill';
import type { DemoUser } from '../../types/signals';

export function AccountStatusPill({ status }: {status: DemoUser['status'];}) {
  if (status === 'active') return <StatusPill tone="gain" icon={CircleDotIcon}>Active</StatusPill>;
  if (status === 'suspended') return <StatusPill tone="loss" icon={PauseCircleIcon}>Suspended</StatusPill>;
  return <StatusPill tone="accent" icon={MailIcon}>Invited</StatusPill>;
}

export function InvitationPill({ invitation }: {invitation: DemoUser['invitation'];}) {
  return invitation === 'accepted' ?
  <StatusPill tone="neutral" icon={CheckIcon}>Accepted</StatusPill> :

  <StatusPill tone="warn" icon={ClockIcon}>Pending</StatusPill>;

}