import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowRightIcon, BellIcon, CheckCheckIcon, CheckIcon, MailIcon } from 'lucide-react';
import { useDemo } from '../../contexts/DemoContext';
import { CATEGORY_LABELS } from '../../data/financeConfig';
import { formatDateTime } from '../../utils/clock';
import { cn } from '../../utils/cn';
import { Popover } from '../ui/Popover';
import type { NotificationGroup } from '../../utils/notificationCenter';

const SEVERITY_DOT = { critical: 'bg-loss', warning: 'bg-warn', info: 'bg-accent' } as const;

export function NotificationMenu() {
  const { notificationGroups, unreadCount, dispatchFinance, selectPosition } = useDemo();
  const navigate = useNavigate();
  const [severity, setSeverity] = useState('all');
  const [category, setCategory] = useState('all');
  const visible = notificationGroups.filter((g) => g.visible);
  const shown = visible.filter((g) => (severity === 'all' || g.severity === severity) && (category === 'all' || g.category === category));
  const categories = [...new Set(visible.map((g) => g.category))];

  const open = (g: NotificationGroup, close: () => void) => {
    dispatchFinance({ type: 'markNotificationRead', key: g.key, lastAt: g.lastAt });
    navigate(g.link.to);
    if (g.link.positionId) selectPosition(g.link.positionId);
    close();
  };

  return (
    <Popover
      triggerLabel={unreadCount > 0 ? `Notifications, ${unreadCount} unread` : 'Notifications'}
      panelClassName="w-[min(26rem,calc(100vw-1.5rem))] p-0"
      triggerClassName="relative flex h-9 w-9 items-center justify-center rounded-lg border border-line bg-inset text-muted transition-colors duration-150 hover:text-ink"
      triggerContent={
      <>
          <BellIcon className="h-4 w-4" aria-hidden />
          {unreadCount > 0 && <span className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-loss px-1 text-[10px] font-bold text-white">{unreadCount}</span>}
        </>
      }>
      
      {(close) =>
      <div>
          <div className="flex items-center justify-between gap-2 border-b border-line px-4 py-3">
            <div>
              <p className="text-sm font-semibold text-ink">Notifications · {unreadCount} unread</p>
              <p className="text-xs text-subtle">Simulated in-app alerts · reading does not resolve an issue</p>
            </div>
            <button
            type="button"
            onClick={() => dispatchFinance({ type: 'markAllNotificationsRead', items: visible.map((g) => ({ key: g.key, lastAt: g.lastAt })) })}
            disabled={unreadCount === 0}
            className="flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-accent transition-colors duration-150 hover:bg-inset disabled:cursor-not-allowed disabled:text-subtle">
            
              <CheckCheckIcon className="h-3.5 w-3.5" aria-hidden />
              Mark all read
            </button>
          </div>
          <div className="grid grid-cols-2 gap-2 border-b border-line px-4 py-2.5">
            <select aria-label="Severity" value={severity} onChange={(e) => setSeverity(e.target.value)} className="h-8 rounded-md border border-line bg-inset px-2 text-xs text-ink">
              <option value="all">All severities</option>
              <option value="critical">Critical</option>
              <option value="warning">Warning</option>
              <option value="info">Info</option>
            </select>
            <select aria-label="Category" value={category} onChange={(e) => setCategory(e.target.value)} className="h-8 rounded-md border border-line bg-inset px-2 text-xs text-ink">
              <option value="all">All categories</option>
              {categories.map((c) =>
            <option key={c} value={c}>
                  {CATEGORY_LABELS[c]}
                </option>
            )}
            </select>
          </div>
          {shown.length === 0 ?
        <p className="px-4 py-8 text-center text-sm text-muted">No notifications match these filters.</p> :

        <ul className="scrollbar-thin max-h-[26rem] divide-y divide-line overflow-y-auto">
              {shown.map((g) =>
          <li key={g.key} className="flex gap-3 px-4 py-3">
                  <span className={cn('mt-1.5 h-2 w-2 shrink-0 rounded-full', g.read ? 'bg-line-strong' : SEVERITY_DOT[g.severity])} aria-hidden />
                  <div className="min-w-0 flex-1">
                    <p className={cn('text-sm', g.read ? 'text-muted' : 'font-semibold text-ink')}>
                      {g.title}
                      {g.occurrences.length > 1 && <span className="ml-1.5 rounded bg-inset px-1.5 text-[11px] font-medium text-muted">×{g.occurrences.length}</span>}
                      {!g.read && <span className="sr-only"> (unread)</span>}
                    </p>
                    <p className="mt-0.5 text-xs text-subtle">{g.detail}</p>
                    <p className="mt-1 text-[11px] text-subtle">
                      {g.occurrences.length > 1 ? `First ${formatDateTime(g.firstAt)} · last ${formatDateTime(g.lastAt)}` : formatDateTime(g.lastAt)}
                      {g.issue !== 'none' && <span className={cn('ml-1.5 font-medium', g.issue === 'open' ? 'text-loss' : 'text-gain')}>· Issue {g.issue === 'open' ? 'open' : 'resolved'}</span>}
                      {g.email &&
                <span className={cn('ml-1.5 inline-flex items-center gap-0.5', g.email === 'Failed in simulation' ? 'text-loss' : 'text-subtle')}>
                          <MailIcon className="h-3 w-3" aria-hidden /> {g.email}
                        </span>
                }
                    </p>
                    <div className="mt-1.5 flex gap-3">
                      <button type="button" onClick={() => open(g, close)} className="inline-flex items-center gap-1 text-xs font-semibold text-accent hover:underline">
                        {g.link.label} <ArrowRightIcon className="h-3 w-3" aria-hidden />
                      </button>
                      {!g.read &&
                <button type="button" onClick={() => dispatchFinance({ type: 'markNotificationRead', key: g.key, lastAt: g.lastAt })} className="inline-flex items-center gap-1 text-xs text-muted hover:text-ink">
                          <CheckIcon className="h-3 w-3" aria-hidden /> Mark as read
                        </button>
                }
                    </div>
                  </div>
                </li>
          )}
            </ul>
        }
        </div>
      }
    </Popover>);

}