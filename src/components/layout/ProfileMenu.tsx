import React from 'react';
import { CheckIcon, ChevronDownIcon, InfoIcon, LockIcon, RotateCcwIcon, UserIcon } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { useDemo } from '../../contexts/DemoContext';
import { useDemoGuide } from '../../contexts/DemoGuideContext';
import { ownerOf } from '../../data/demoUsers';
import { Popover } from '../ui/Popover';
import type { PreviewRole } from '../../types/trading';

const roles: {value: PreviewRole;label: string;description: string;}[] = [
{ value: 'admin', label: 'Administrator', description: 'Users, common signals, strategy packages and pair defaults' },
{ value: 'trader', label: 'Subscriber', description: 'Own exchange connection, trade settings and holdings' }];


const itemClass = 'flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors duration-150 hover:bg-inset';

export function ProfileMenu() {
  const { state, currentUser, setRole, setTraderUser } = useDemo();
  const { requestReset } = useDemoGuide();
  const navigate = useNavigate();
  const current = roles.find((r) => r.value === state.role) ?? roles[1];
  const who = state.role === 'admin' ? 'Platform administrator' : currentUser.name;

  return (
    <Popover
      triggerLabel={`Account menu, demo role ${current.label}, ${who}`}
      panelClassName="w-80"
      triggerClassName="flex h-9 items-center gap-2 rounded-lg border border-line bg-inset pl-1.5 pr-2 text-sm text-ink transition-colors duration-150 hover:border-line-strong"
      triggerContent={
      <>
          <span className="flex h-6 w-6 items-center justify-center rounded-full border border-accent/50 bg-accent/10 text-accent">
            <UserIcon className="h-3.5 w-3.5" aria-hidden />
          </span>
          <span className="hidden whitespace-nowrap font-medium xl:inline">
            {state.role === 'admin' ? 'Administrator' : `Subscriber · ${currentUser.name.split(' ')[0]}`}
          </span>
          <ChevronDownIcon className="hidden h-4 w-4 text-subtle sm:block" aria-hidden />
        </>
      }>
      
      {(close) =>
      <div role="menu" aria-label="Profile">
          <p className="px-2.5 pb-1 pt-1.5 text-xs font-medium text-subtle">Demo role</p>
          {roles.map((role) =>
        <button
          key={role.value}
          type="button"
          role="menuitemradio"
          aria-checked={state.role === role.value}
          onClick={() => {
            if (role.value !== state.role) {
              setRole(role.value);
              navigate('/');
            }
            close();
          }}
          className={itemClass}>
          
              <span className="mt-0.5 flex h-4 w-4 items-center justify-center">{state.role === role.value && <CheckIcon className="h-4 w-4 text-accent" aria-hidden />}</span>
              <span>
                <span className="block text-sm text-ink">{role.label}</span>
                <span className="block text-xs text-subtle">{role.description}</span>
              </span>
            </button>
        )}
          <div className="my-1.5 h-px bg-line" />
          <p className="px-2.5 pb-1 pt-1 text-xs font-medium text-subtle">Demo subscriber</p>
          {state.users.map((u) => {
          const count = state.accounts.filter((a) => ownerOf(a) === u.id).length;
          return (
            <button
              key={u.id}
              type="button"
              role="menuitemradio"
              aria-checked={state.traderUserId === u.id}
              onClick={() => {
                setTraderUser(u.id);
                close();
                if (u.id !== state.traderUserId) toast(`Viewing as ${u.name}`, { description: 'Subscriber pages now show only this subscriber’s records.' });
              }}
              className={itemClass}>
              
                <span className="mt-0.5 flex h-4 w-4 items-center justify-center">{state.traderUserId === u.id && <CheckIcon className="h-4 w-4 text-accent" aria-hidden />}</span>
                <span>
                  <span className="block text-sm text-ink">{u.name}</span>
                  <span className="block text-xs text-subtle">
                    {count} paper account{count === 1 ? '' : 's'}
                    {u.status === 'suspended' ? ' · Suspended' : u.status === 'invited' ? ' · Invited' : ''}
                  </span>
                </span>
              </button>);

        })}
          <p className="mx-2.5 mt-1 flex gap-2 rounded-md border border-line bg-inset px-2.5 py-2 text-xs text-muted">
            <InfoIcon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-subtle" aria-hidden />
            The demo role switch simulates roles for interface purposes. It is not production authentication or access enforcement.
          </p>
          <div className="my-1.5 h-px bg-line" />
          <div className="flex items-start gap-2.5 px-2.5 py-2 text-left" aria-disabled="true">
            <LockIcon className="mt-0.5 h-4 w-4 text-subtle" aria-hidden />
            <span>
              <span className="block text-sm text-muted">Live trading</span>
              <span className="block text-xs text-subtle">Unavailable in this prototype</span>
            </span>
          </div>
          <div className="my-1.5 h-px bg-line" />
          <button
          type="button"
          role="menuitem"
          onClick={() => {
            close();
            requestReset();
          }}
          className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm text-ink transition-colors duration-150 hover:bg-inset">
          
            <RotateCcwIcon className="h-4 w-4 text-subtle" aria-hidden />
            Reset demo
          </button>
        </div>
      }
    </Popover>);

}