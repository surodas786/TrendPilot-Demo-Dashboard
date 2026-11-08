import React from "react";
import { EyeIcon, KeyRoundIcon, MailIcon, MoreHorizontalIcon, PauseCircleIcon, PencilIcon, PlayCircleIcon, BoxIcon } from "lucide-react";
import { Popover } from "../ui/Popover";
import { cn } from "../../utils/cn";
import { DemoUser } from "../../types/signals";
export type UserMenuAction = 'edit' | 'resend' | 'reset' | 'suspend' | 'reactivate' | 'preview';
interface Item {
  id: UserMenuAction;
  label: string;
  icon: BoxIcon;
  danger?: boolean;
}
function itemsFor(user: DemoUser): Item[] {
  const items: Item[] = [{
    id: 'edit',
    label: 'View / Edit',
    icon: PencilIcon
  }];
  if (user.status === 'invited') items.push({
    id: 'resend',
    label: 'Resend Invitation',
    icon: MailIcon
  });
  if (user.status === 'active') {
    items.push({
      id: 'preview',
      label: 'Preview Subscriber Account',
      icon: EyeIcon
    });
    items.push({
      id: 'reset',
      label: 'Reset Password',
      icon: KeyRoundIcon
    });
    items.push({
      id: 'suspend',
      label: 'Suspend',
      icon: PauseCircleIcon,
      danger: true
    });
  }
  if (user.status === 'suspended') items.push({
    id: 'reactivate',
    label: 'Reactivate',
    icon: PlayCircleIcon
  });
  return items;
}
export function UserActionsMenu({
  user,
  onAction



}: {user: DemoUser;onAction: (a: UserMenuAction) => void;}) {
  return <Popover triggerLabel={`Actions for ${user.name}`} panelClassName="w-60" triggerClassName="flex h-9 w-9 items-center justify-center rounded-lg border border-line bg-inset text-muted transition-colors duration-150 hover:border-line-strong hover:text-ink" triggerContent={<MoreHorizontalIcon className="h-4 w-4" aria-hidden />}>
      {(close) => <div role="menu" aria-label={`Actions for ${user.name}`}>
          {itemsFor(user).map((it) => {
        const Icon = it.icon;
        return <button key={it.id} type="button" role="menuitem" onClick={() => {
          close();
          onAction(it.id);
        }} className={cn('flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm transition-colors duration-150 hover:bg-inset', it.danger ? 'text-loss' : 'text-ink')}>
                <Icon className={cn('h-4 w-4', it.danger ? 'text-loss' : 'text-subtle')} aria-hidden />
                {it.label}
              </button>;
      })}
        </div>}
    </Popover>;
}