import React from 'react';
import { PlusIcon, Trash2Icon } from 'lucide-react';
import { allocationTotal, MAX_TARGETS } from '../../utils/tokenBlocks';
import type { DraftErrors } from '../../utils/tokenBlocks';
import { cn } from '../../utils/cn';
import { Button } from '../ui/Button';
import { Switch } from '../ui/Switch';
import { TextField } from '../ui/TextField';
import type { TokenBlockDraft } from '../../types/tradeSettings';

interface Props {
  draft: TokenBlockDraft;
  errors: DraftErrors;
  showErrors: boolean;
  onChange: (patch: Partial<TokenBlockDraft>) => void;
}

const pct = <span className="pr-2 text-xs text-subtle">%</span>;

export function TakeProfitEditor({ draft, errors, showErrors, onChange }: Props) {
  const setTarget = (i: number, patch: Partial<TokenBlockDraft['targets'][number]>) => onChange({ targets: draft.targets.map((t, j) => j === i ? { ...t, ...patch } : t) });
  const total = allocationTotal(draft);

  const toggleSplit = (split: boolean) => {
    if (split) {
      const first = draft.targets[0] ?? { movePct: '', closePct: '100' };
      const further = String((Number(first.movePct) || 1) * 2);
      onChange({ split, targets: [{ movePct: first.movePct, closePct: '50' }, { movePct: further, closePct: '50' }] });
    } else {
      onChange({ split, targets: [{ movePct: draft.targets[0]?.movePct ?? '', closePct: '100' }] });
    }
  };

  if (!draft.split) {
    return (
      <div className="space-y-3">
        <TextField label="Take profit" inputMode="decimal" value={draft.targets[0]?.movePct ?? ''} onChange={(v) => setTarget(0, { movePct: v })} error={showErrors ? errors.targets[0]?.movePct : undefined} hint="Single target closing 100% of the position." trailing={pct} />
        <Switch label="Split Take Profit" description="Close the position in up to three steps." checked={false} onChange={toggleSplit} />
      </div>);

  }

  return (
    <div className="space-y-3">
      <Switch label="Split Take Profit" description="Allocations refer to the original filled quantity." checked onChange={toggleSplit} />
      <ol className="space-y-3">
        {draft.targets.map((t, i) =>
        <li key={i} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] items-start gap-2">
            <TextField label={`Target ${i + 1} — move`} inputMode="decimal" value={t.movePct} onChange={(v) => setTarget(i, { movePct: v })} error={showErrors ? errors.targets[i]?.movePct : undefined} trailing={pct} />
            <TextField label="Close" inputMode="decimal" value={t.closePct} onChange={(v) => setTarget(i, { closePct: v })} error={showErrors ? errors.targets[i]?.closePct : undefined} trailing={pct} />
            <button
            type="button"
            onClick={() => onChange({ targets: draft.targets.filter((_, j) => j !== i) })}
            disabled={draft.targets.length <= 1}
            aria-label={`Remove target ${i + 1}`}
            className="mt-7 flex h-10 w-10 items-center justify-center rounded-lg text-subtle transition-colors duration-150 hover:bg-inset hover:text-loss disabled:pointer-events-none disabled:opacity-40">
            
              <Trash2Icon className="h-4 w-4" aria-hidden />
            </button>
          </li>
        )}
      </ol>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Button size="sm" icon={PlusIcon} disabled={draft.targets.length >= MAX_TARGETS} onClick={() => onChange({ targets: [...draft.targets, { movePct: '', closePct: '' }] })}>
          Add target
        </Button>
        <p className={cn('text-sm tabular-nums', total === 100 ? 'text-gain' : 'text-warn')} aria-live="polite">
          Allocated {total}% of 100%
        </p>
      </div>
      {showErrors && errors.allocation && <p className="text-xs text-loss">{errors.allocation}</p>}
    </div>);

}