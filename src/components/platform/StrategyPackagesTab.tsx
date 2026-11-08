import React, { useState } from 'react';
import { PackageIcon, PencilIcon, PlusIcon } from 'lucide-react';
import { toast } from 'sonner';
import { usePlatform } from '../../contexts/PlatformContext';
import { DIRECTION_LABELS, OPPOSITE_SHORT, reversalLimited, timeframeShort, trendFilterShort } from '../../utils/platformText';
import { Button } from '../ui/Button';
import { EmptyState } from '../ui/EmptyState';
import { StatusPill } from '../ui/StatusPill';
import { PackageFormModal } from './PackageFormModal';

export function StrategyPackagesTab() {
  const { platform } = usePlatform();
  const [editing, setEditing] = useState<string | 'new' | null>(null);
  const pkg = editing && editing !== 'new' ? platform.packages.find((p) => p.id === editing) : undefined;

  return (
    <div className="space-y-3">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <p className="max-w-2xl text-sm text-muted">Reusable opening packages for common signals. Seeded examples are demo examples, not recommended trading strategies.</p>
        <Button variant="primary" icon={PlusIcon} onClick={() => setEditing('new')}>
          Create Package
        </Button>
      </div>
      {platform.packages.length === 0 ?
      <EmptyState icon={PackageIcon} title="No strategy packages yet" body="Create a package to define entry direction and opposite-signal behavior." /> :

      <ul className="divide-y divide-line rounded-xl border border-line bg-surface">
          {platform.packages.map((p) =>
        <li key={p.id} className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:gap-4">
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-center gap-2 font-medium text-ink">
                  {p.name}
                  {p.example && <StatusPill tone="neutral">Demo example</StatusPill>}
                </p>
                <p className="mt-0.5 text-sm text-muted">
                  {DIRECTION_LABELS[p.direction]} · <span className={p.timeframe ? undefined : 'text-warn'}>{timeframeShort(p.timeframe)}</span> · {trendFilterShort(p.trendFilter)} · Opposite signal: {OPPOSITE_SHORT[p.opposite]}
                  {reversalLimited(p) && <span className="text-subtle"> (no reverse entry — {DIRECTION_LABELS[p.direction].toLowerCase()})</span>}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <StatusPill tone={p.status === 'active' ? 'gain' : 'neutral'}>{p.status === 'active' ? 'Active' : 'Inactive'}</StatusPill>
                <Button size="sm" variant="ghost" icon={PencilIcon} onClick={() => setEditing(p.id)} aria-label={`Edit ${p.name}`}>
                  Edit
                </Button>
              </div>
            </li>
        )}
        </ul>
      }
      <PackageFormModal
        open={editing !== null}
        pkg={pkg}
        onClose={() => setEditing(null)}
        onSaved={(name, isNew) => {
          setEditing(null);
          toast.success(isNew ? 'Package created' : 'Package saved', { description: name });
        }} />
      
    </div>);

}