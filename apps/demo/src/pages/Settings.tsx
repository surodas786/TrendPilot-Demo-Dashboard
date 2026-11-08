import React from 'react';
import { SendIcon } from 'lucide-react';
import { toast } from 'sonner';
import { useDemo } from '../contexts/DemoContext';
import { prefsFor } from '../contexts/financeReducer';
import { PageContainer } from '../components/layout/PageContainer';
import { Button } from '../components/ui/Button';
import { Switch } from '../components/ui/Switch';
import { CATEGORY_LABELS, CRITICAL_CATEGORIES } from '../data/financeConfig';
import { simNow } from '../utils/clock';
import type { NotificationCategory } from '../types/finance';

const CATEGORIES = Object.keys(CATEGORY_LABELS) as NotificationCategory[];

/** Notification preferences for the selected subscriber. Email delivery is simulated only. */
export function Settings() {
  const { state, currentUser, accounts, account: selected, dispatchFinance, notificationGroups } = useDemo();
  const account = accounts.length > 0 ? selected : undefined;
  const prefs = prefsFor(state, currentUser.id);
  const emailFailing = state.emailFailWindows.some((w) => w.to === null);
  const recentEmail = notificationGroups.filter((g) => g.email).slice(0, 5);

  const set = (channel: 'inApp' | 'email', cat: NotificationCategory, on: boolean) =>
  dispatchFinance({ type: 'setNotificationPrefs', userId: currentUser.id, prefs: { ...prefs, [channel]: { ...prefs[channel], [cat]: on }, updatedAt: simNow() } });

  const sendTest = () => {
    dispatchFinance({ type: 'sendTestNotification', userId: currentUser.id, accountId: account?.id ?? null, category: 'test', title: 'Test notification', at: simNow() });
    toast.success('Test notification created', { description: 'Check the bell. No real email is sent.' });
  };

  return (
    <PageContainer title="Settings" description="Choose which events notify you in the app and by simulated email." scope={`${currentUser.name} · ${currentUser.email}`}>
      <section className="rounded-xl border border-line bg-surface">
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-3">
          <h3 className="text-sm font-semibold text-ink">Notifications</h3>
          <Button size="sm" icon={SendIcon} onClick={sendTest}>
            Send test notification
          </Button>
        </header>
        <div className="scrollbar-thin overflow-x-auto">
          <table className="w-full min-w-[480px] text-sm">
            <thead>
              <tr className="border-b border-line text-left text-xs text-subtle">
                <th scope="col" className="px-4 py-2 font-medium">Event</th>
                <th scope="col" className="px-4 py-2 font-medium">In-app</th>
                <th scope="col" className="px-4 py-2 font-medium">Simulated email</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {CATEGORIES.map((c) => {
                const locked = CRITICAL_CATEGORIES.includes(c);
                return (
                  <tr key={c}>
                    <td className="px-4 py-2.5 text-ink">
                      {CATEGORY_LABELS[c]}
                      {locked && <span className="block text-xs text-subtle">Always shown in-app</span>}
                    </td>
                    <td className="px-4 py-2.5">
                      <Switch checked={locked || prefs.inApp[c]} disabled={locked} onChange={(v: boolean) => set('inApp', c, v)} label="In-app" />
                    </td>
                    <td className="px-4 py-2.5">
                      <Switch checked={prefs.email[c]} onChange={(v: boolean) => set('email', c, v)} label="Email" />
                    </td>
                  </tr>);

              })}
            </tbody>
          </table>
        </div>
      </section>

      <section className="rounded-xl border border-line bg-surface p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold text-ink">Simulated email delivery</h3>
            <p className="mt-0.5 text-xs text-muted">Demo switch. Delivery failures never block closing actions or protective management.</p>
          </div>
          <Switch checked={emailFailing} onChange={(v: boolean) => dispatchFinance({ type: 'setEmailFailing', on: v, at: simNow() })} label="Make email delivery fail" />
        </div>
        <ul className="mt-3 divide-y divide-line text-sm">
          {recentEmail.length === 0 && <li className="py-2 text-muted">No simulated emails yet.</li>}
          {recentEmail.map((g) =>
          <li key={g.key} className="flex flex-wrap justify-between gap-2 py-2">
              <span className="text-ink">{g.title}</span>
              <span className="text-xs text-subtle">{g.email}</span>
            </li>
          )}
        </ul>
      </section>
    </PageContainer>);

}