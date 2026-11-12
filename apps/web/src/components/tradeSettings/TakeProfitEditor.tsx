'use client';

import React from 'react';
import { PlusIcon, Trash2Icon } from 'lucide-react';
import { Decimal, exitAllocation, isDecimalString, type TakeProfitMode } from '@trendpilot/domain';
import { cn } from '@/lib/cn';
import { Button } from '../ui/Button';
import { DecimalField } from '../ui/DecimalField';
import { SegmentedControl } from '../ui/SegmentedControl';
import { MAX_TARGETS, newTargetId, type Draft } from './draft';

interface Props {
  draft: Draft;
  /** Inline message for a field path (shown once the field was left or Save was pressed). */
  err: (path: string) => string | undefined;
  /** Marks a field as left (blur), so its message shows. */
  commit: (path: string) => void;
  onChange: (patch: Partial<Draft>) => void;
}

const pct = <span className="pr-2 text-xs text-subtle">%</span>;

function sharesTotal(d: Draft): string {
  return d.targets.reduce((s, t) => (isDecimalString(t.closePct.trim()) ? s.plus(t.closePct.trim()) : s), new Decimal(0)).toFixed();
}

/** "Take Profit 60% · Trailing take profit 40%" — shared by the editor and its tests. */
export function allocationText(d: Draft): string {
  const a = exitAllocation({ takeProfit: { mode: d.tpMode }, trailing: { enabled: d.trailingEnabled, closePct: d.trailingClosePct } });
  const parts = [`Take profit ${a.takeProfitPct}%`];
  if (d.trailingEnabled) parts.push(`Trailing take profit ${a.trailingPct}%`);
  if (a.unallocatedPct !== '0') parts.push(`${a.unallocatedPct}% unallocated (stop loss and signal closes only)`);
  return parts.join(' · ');
}

/**
 * Adapted from the MagicPatterns TakeProfitEditor: Fixed, Split (2–3 targets) or Off (CFG-03).
 * How much of the position Take Profit manages is set in Trailing take profit ("Position to
 * close (%)"); split targets divide the Take Profit share between them.
 */
export function TakeProfitEditor({ draft, err, commit, onChange }: Props) {
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

  const total = sharesTotal(draft);
  const splitOk = total === '100';

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
        hint={
          draft.tpMode === 'OFF'
            ? 'No take-profit target. The stop loss still applies.'
            : 'Reaching a target only arms it. A later pullback through the target closes its quantity at market (Long: back below, Short: back above); fill price may differ.'
        }
      />

      {draft.tpMode === 'FIXED' && (
        <DecimalField
          label="Target — price move"
          value={draft.targets[0]?.movePct ?? ''}
          onChange={(v) => setTarget(0, { movePct: v })}
          onCommit={() => commit('takeProfit.levels.0.movePct')}
          error={err('takeProfit.levels.0.movePct') ?? err('takeProfit.levels')}
          hint="One target for the whole Take Profit share."
          trailing={pct}
        />
      )}

      {draft.tpMode === 'SPLIT' && (
        <>
          <ol className="space-y-3">
            {draft.targets.map((t, i) => (
              <li key={t.id} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] items-start gap-2">
                <DecimalField
                  label={`Target ${i + 1} — move`}
                  value={t.movePct}
                  onChange={(v) => setTarget(i, { movePct: v })}
                  onCommit={() => commit(`takeProfit.levels.${i}.movePct`)}
                  error={err(`takeProfit.levels.${i}.movePct`)}
                  trailing={pct}
                />
                <DecimalField
                  label="Share of TP"
                  value={t.closePct}
                  onChange={(v) => setTarget(i, { closePct: v })}
                  onCommit={() => commit(`takeProfit.levels.${i}.closePct`)}
                  error={err(`takeProfit.levels.${i}.closePct`)}
                  trailing={pct}
                />
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
            <p className={cn('text-sm tabular-nums', splitOk ? 'text-gain' : 'text-warn')} aria-live="polite" data-testid="split-shares">
              Shares {total}% of 100% of the Take Profit quantity
            </p>
          </div>
          {(err('takeProfit') ?? err('takeProfit.levels')) && <p className="text-xs text-loss">{err('takeProfit') ?? err('takeProfit.levels')}</p>}
        </>
      )}

      <p className="text-xs text-subtle" data-testid="exit-allocation" aria-live="polite">
        Of the confirmed opening quantity: {allocationText(draft)}.
      </p>
    </div>
  );
}
