import React, { useMemo, useState } from 'react';
import { SearchIcon, UserPlusIcon, UsersIcon } from 'lucide-react';
import { useDemo } from '../../contexts/DemoContext';
import { useUserActions } from '../../hooks/useUserActions';
import { formatUserDate } from '../../utils/userDirectory';
import { PageContainer } from '../../components/layout/PageContainer';
import { Button } from '../../components/ui/Button';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { EmptyState } from '../../components/ui/EmptyState';
import { FilterSelect } from '../../components/ui/FilterSelect';
import { UserFormModal } from '../../components/users/UserFormModal';
import { EmailPreviewModal } from '../../components/users/EmailPreviewModal';
import { UserActionsMenu } from '../../components/users/UserActionsMenu';
import { AccountStatusPill, InvitationPill } from '../../components/users/UserStatusPills';

type StatusFilter = 'all' | 'invited' | 'active' | 'suspended';

export function Users() {
  const { state } = useDemo();
  const a = useUserActions();
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<StatusFilter>('all');

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return [...state.users].
    filter((u) => (status === 'all' || u.status === status) && (!q || u.name.toLowerCase().includes(q) || u.email.toLowerCase().includes(q))).
    sort((x, y) => y.createdAt - x.createdAt);
  }, [state.users, query, status]);

  return (
    <PageContainer
      title="Users"
      description="Create subscriber accounts, manage account status, send invitations and reset passwords."
      scope="Invitation and password-reset emails are demo simulations — nothing is sent."
      actions={
      <Button variant="primary" icon={UserPlusIcon} onClick={() => a.setCreating(true)}>
          Create User
        </Button>
      }>
      
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <label htmlFor="user-search" className="text-xs font-medium text-subtle">
            Search
          </label>
          <div className="relative">
            <SearchIcon className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-subtle" aria-hidden />
            <input
              id="user-search"
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Name or email"
              className="h-9 w-full rounded-lg border border-line bg-inset pl-9 pr-3 text-sm text-ink placeholder:text-subtle transition-colors duration-150 hover:border-line-strong focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/60" />
            
          </div>
        </div>
        <div className="sm:w-48">
          <FilterSelect
            label="Account status"
            value={status}
            onChange={(v) => setStatus(v as StatusFilter)}
            options={[
            { value: 'all', label: 'All statuses' },
            { value: 'invited', label: 'Invited' },
            { value: 'active', label: 'Active' },
            { value: 'suspended', label: 'Suspended' }]
            } />
          
        </div>
      </div>

      <p className="text-xs text-subtle" role="status" aria-live="polite">
        {rows.length} of {state.users.length} subscribers
      </p>

      {rows.length === 0 ?
      <EmptyState icon={UsersIcon} title="No matching subscribers" body="Try a different name, email or status filter." /> :

      <>
          {/* Desktop table — no overflow wrapper so the actions menu is never clipped. */}
          <div className="hidden rounded-xl border border-line bg-surface md:block">
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-subtle">
                <tr className="border-b border-line">
                  <th scope="col" className="px-4 py-2.5 font-medium">Name</th>
                  <th scope="col" className="px-4 py-2.5 font-medium">Email</th>
                  <th scope="col" className="px-4 py-2.5 font-medium">Account status</th>
                  <th scope="col" className="px-4 py-2.5 font-medium">Invitation</th>
                  <th scope="col" className="px-4 py-2.5 font-medium">Created</th>
                  <th scope="col" className="px-4 py-2.5 text-right font-medium">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {rows.map((u) =>
              <tr key={u.id}>
                    <td className="px-4 py-3 font-medium text-ink">{u.name}</td>
                    <td className="max-w-[260px] truncate px-4 py-3 text-muted">{u.email}</td>
                    <td className="px-4 py-3">
                      <AccountStatusPill status={u.status} />
                    </td>
                    <td className="px-4 py-3">
                      <InvitationPill invitation={u.invitation} />
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-muted tabular-nums">{formatUserDate(u.createdAt)}</td>
                    <td className="px-4 py-3">
                      <div className="flex justify-end">
                        <UserActionsMenu user={u} onAction={(act) => a.onAction(u, act)} />
                      </div>
                    </td>
                  </tr>
              )}
              </tbody>
            </table>
          </div>

          {/* Mobile list */}
          <ul className="divide-y divide-line rounded-xl border border-line bg-surface md:hidden">
            {rows.map((u) =>
          <li key={u.id} className="flex items-start gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <p className="font-medium text-ink">{u.name}</p>
                  <p className="truncate text-sm text-muted">{u.email}</p>
                  <div className="mt-2 flex flex-wrap items-center gap-1.5">
                    <AccountStatusPill status={u.status} />
                    <InvitationPill invitation={u.invitation} />
                    <span className="text-xs text-subtle">Created {formatUserDate(u.createdAt)}</span>
                  </div>
                </div>
                <UserActionsMenu user={u} onAction={(act) => a.onAction(u, act)} />
              </li>
          )}
          </ul>
        </>
      }

      <UserFormModal open={a.creating} onClose={() => a.setCreating(false)} onSubmit={a.create} />
      <UserFormModal open={Boolean(a.editingUser)} user={a.editingUser} onClose={a.closeEdit} onSubmit={a.saveEdit} />
      <EmailPreviewModal linkId={a.previewLinkId} onClose={a.closePreview} />
      <ConfirmDialog
        open={a.confirm?.kind === 'reset'}
        title={`Reset ${a.confirm?.user.name ?? ''}’s password?`}
        description={`A simulated password-reset link will be issued for ${a.confirm?.user.email ?? ''}. Any earlier reset link stops working. Account status stays Active.`}
        confirmLabel="Send reset link"
        onConfirm={a.confirmAction}
        onCancel={a.cancelConfirm} />
      
      <ConfirmDialog
        open={a.confirm?.kind === 'suspend'}
        title={`Suspend ${a.confirm?.user.name ?? ''}?`}
        description="The subscriber can no longer enter their account in this demo. This changes simulated account access only — it does not close any open exchange positions."
        confirmLabel="Suspend"
        tone="danger"
        onConfirm={a.confirmAction}
        onCancel={a.cancelConfirm} />
      
    </PageContainer>);

}