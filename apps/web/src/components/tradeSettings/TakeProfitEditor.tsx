'use client';

import React from 'react';
import { PlusIcon, Trash2Icon } from 'lucide-react';
import { Decimal, isDecimalString, type TakeProfitMode } from '@trendpilot/domain';
import { cn } from '@/lib/cn';
import { Button } from '../ui/Button';
import { SegmentedControl } from '../ui/SegmentedControl';
import { TextField } from '../ui/TextField';
import { MAX_TARGETS, newTargetId, type Draft } from './draft';

interface Props {
  draft: Draft;
  errors: Record<string, string>;
  showErrors: boolean;
  onChange: (patch: Partial<Draft>) => void;
}

const pct = <span className="pr-2 text-xs text-subtle">%</span>;

function allocated(d: Draft): string {
  const total = d.targets.reduce((s, t) => (isDecimalString(t.closePct.trim()) ? s.plus(t.closePct.trim()) : s), new Decimal(0));
  return total.toFixed();
}

/** Adapted from the MagicPatterns TakeProfitEditor: Fixed, Split (2–3 targets) or Off (CFG-03). */
export function TakeProfitEditor({ draft, errors, showErrors, onChange }: Props) {
  const err = (path: string) => (showErrors ? errors[path] : undefined);
  const setTarget = (i: number, patch: Partial<Draft['targets'][number]>) => onChange({ targets: draft.targets.map((t, j) => (j === i ? { ...t, ...patch } : t)) });

  const setMode = (mode: TakeProfitMode) => {
    if (mode === draft.tpMode) return;
    const first = draft.targets[0] ?? { id: newTargetId(), movePct: '', closePct: '100' };
    if (mode === 'SPLIT') {
      const further = isDecimalString(first.movePct) ? new Decimal(first.movePct).times(2).toFixed() : '';
      onChange({ tpMode: mode, targets: [{ ...first, closePct: '50' }, { id: newTargetId(), movePct: further, closePct: '50' }] });
    } else {
      onChange({ tpMode: mode, targets: [{ ...first, closePct: '100' }] });
    }
  };

  const total = allocated(draft);

  return (
    <div className="space-y-3">
      <SegmentedControl<TakeProfitMode>
        label="Take profit"
        value={draft.tpMode}
        onChange={setMode}
        options={[
          { value: 'FIXED', label: 'Fixed' },
          { value: 'SPLIT', label: 'Split' },
          { value: 'OFF', label: 'Off' }
        ]}
        hint={draft.tpMode === 'OFF' ? 'No take-profit target. Stop loss and any trailing stop still apply.' : 'A target crossing submits a market close; fill price may differ.'}
      />

      {draft.tpMode === 'FIXED' && (
        <TextField
          label="Target — price move"
          inputMode="decimal"
          value={draft.targets[0]?.movePct ?? ''}
          onChange={(v) => setTarget(0, { movePct: v })}
          error={err('takeProfit.levels.0.movePct') ?? err('takeProfit.levels')}
          hint="Single target closing 100% of the position."
          trailing={pct}
        />
      )}

      {draft.tpMode === 'SPLIT' && (
        <>
          <ol className="space-y-3">
            {draft.targets.map((t, i) => (
              <li key={t.id} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] items-start gap-2">
                <TextField label={`Target ${i + 1} — move`} inputMode="decimal" value={t.movePct} onChange={(v) => setTarget(i, { movePct: v })} error={err(`takeProfit.levels.${i}.movePct`)} trailing={pct} />
                <TextField label="Close" inputMode="decimal" value={t.closePct} onChange={(v) => setTarget(i, { closePct: v })} error={err(`takeProfit.levels.${i}.closePct`)} trailing={pct} />
                <button
                  type="button"
                  onClick={() => onChange({ targets: draft.targets.filter((_, j) => j !== i) })}
                  disabled={draft.targets.length <= 2}
                  aria-label={`Remove target ${i + 1}`}
                  className="mt-7 flex h-10 w-10 items-center justify-center rounded-lg text-subtle transition-colors duration-150 hover:bg-inset hover:text-loss disabled:pointer-events-none disabled:opacity-40"
                >
                  <Trash2Icon className="h-4 w-4" aria-hidden />
                </button>
              </li>
            ))}
          </ol>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Button size="sm" icon={PlusIcon} disabled={draft.targets.length >= MAX_TARGETS} onClick={() => onChange({ targets: [...draft.targets, { id: newTargetId(), movePct: '', closePct: '' }] })}>
              Add target
            </Button>
            <p className={cn('text-sm tabular-nums', total === '100' ? 'text-gain' : 'text-warn')} aria-live="polite">
              Allocated {total}% of 100%
            </p>
          </div>
          {(err('takeProfit') ?? err('takeProfit.levels')) && <p className="text-xs text-loss">{err('takeProfit') ?? err('takeProfit.levels')}</p>}
        </>
      )}
    </div>
  );
}
