'use client';

import React from 'react';
import { PlusIcon, Trash2Icon } from 'lucide-react';
import { Decimal, exitAllocation, isDecimalString, type TakeProfitMode } from '@trendpilot/domain';
import { cn } from '@/lib/cn';
import { Button } from '../ui/Button';
import { DecimalField } from '../ui/DecimalField';
import { SegmentedControl } from '../ui/SegmentedControl';
import { MAX_TARGETS, newTargetId, TP_KEY, type Draft, type SideTakeProfit, type TpSide } from './draft';

interface Props {
  draft: Draft;
  /** Which side's Take Profit this section edits. */
  side: TpSide;
  /** Inline message for a field path (shown once the field was left or Save was pressed). */
  err: (path: string) => string | undefined;
  /** Marks a field as left (blur), so its message shows. */
  commit: (path: string) => void;
  onChange: (patch: Partial<Draft>) => void;
}

const pct = <span className="pr-2 text-xs text-subtle">%</span>;

function sharesTotal(t: SideTakeProfit): string {
  return t.targets.reduce((s, x) => (isDecimalString(x.closePct.trim()) ? s.plus(x.closePct.trim()) : s), new Decimal(0)).toFixed();
}

/** "Take Profit 60% · Trailing take profit 40%" for one side — shared by the editor and its tests. */
export function allocationText(d: Draft, side: TpSide = 'LONG'): string {
  const a = exitAllocation({ takeProfit: { mode: d.tp[side].mode }, trailing: { enabled: d.trailingEnabled, closePct: d.trailingClosePct } });
  const parts = [`Take profit ${a.takeProfitPct}%`];
  if (d.trailingEnabled) parts.push(`Trailing take profit ${a.trailingPct}%`);
  if (a.unallocatedPct !== '0') parts.push(`${a.unallocatedPct}% unallocated (stop loss and signal closes only)`);
  return parts.join(' · ');
}

/**
 * Adapted from the MagicPatterns TakeProfitEditor: Fixed, Split (2–3 targets) or Off (CFG-03),
 * for ONE position side. Long and Short are configured independently; the side of the actual
 * entry selects one, saved with the position. How much of the position Take Profit manages is
 * set in Trailing take profit ("Position to close (%)"); split targets divide that share.
 */
export function TakeProfitEditor({ draft, side, err, commit, onChange }: Props) {
  const tp = draft.tp[side];
  const key = TP_KEY[side];
  const long = side === 'LONG';
  const setSide = (next: SideTakeProfit) => onChange({ tp: { ...draft.tp, [side]: next } });
  const setTarget = (i: number, patch: Partial<SideTakeProfit['targets'][number]>) => setSide({ ...tp, targets: tp.targets.map((t, j) => (j === i ? { ...t, ...patch } : t)) });

  const setMode = (mode: TakeProfitMode) => {
    if (mode === tp.mode) return;
    const first = tp.targets[0] ?? { id: newTargetId(), movePct: '', closePct: '100' };
    if (mode === 'SPLIT') {
      const further = isDecimalString(first.movePct) ? new Decimal(first.movePct).times(2).toFixed() : '';
      setSide({ mode, targets: [{ ...first, closePct: '50' }, { id: newTargetId(), movePct: further, closePct: '50' }] });
    } else {
      setSide({ mode, targets: [{ ...first, closePct: '100' }] });
    }
  };

  const total = sharesTotal(tp);
  const splitOk = total === '100';
  const label = long ? 'Long take profit' : 'Short take profit';

  return (
    <div className="space-y-3 rounded-lg border border-line p-3" data-testid={`tp-${side}`} role="group" aria-label={label}>
      <SegmentedControl<TakeProfitMode>
        label={label}
        value={tp.mode}
        onChange={setMode}
        options={[
          { value: 'FIXED', label: 'Fixed' },
          { value: 'SPLIT', label: 'Split' },
          { value: 'OFF', label: 'Off' }
        ]}
        hint={
          tp.mode === 'OFF'
            ? `No take-profit target for ${long ? 'Long' : 'Short'} positions. The stop loss still applies.`
            : long
              ? 'Targets are above the confirmed average entry. Reaching one only arms it; a later move back down through it closes its quantity at market (fill price may differ).'
              : 'Targets are below the confirmed average entry. Reaching one only arms it; a later rebound back up through it closes its quantity at market (fill price may differ).'
        }
      />

      {tp.mode === 'FIXED' && (
        <DecimalField
          label={`${long ? 'Long' : 'Short'} target — price move`}
          value={tp.targets[0]?.movePct ?? ''}
          onChange={(v) => setTarget(0, { movePct: v })}
          onCommit={() => commit(`${key}.levels.0.movePct`)}
          error={err(`${key}.levels.0.movePct`) ?? err(`${key}.levels`)}
          hint={`One target for the whole Take Profit share, ${long ? 'above' : 'below'} entry.`}
          trailing={pct}
        />
      )}

      {tp.mode === 'SPLIT' && (
        <>
          <ol className="space-y-3">
            {tp.targets.map((t, i) => (
              <li key={t.id} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] items-start gap-2">
                <DecimalField
                  label={`${long ? 'Long' : 'Short'} target ${i + 1} — move`}
                  value={t.movePct}
                  onChange={(v) => setTarget(i, { movePct: v })}
                  onCommit={() => commit(`${key}.levels.${i}.movePct`)}
                  error={err(`${key}.levels.${i}.movePct`)}
                  trailing={pct}
                />
                <DecimalField
                  label="Share of TP"
                  value={t.closePct}
                  onChange={(v) => setTarget(i, { closePct: v })}
                  onCommit={() => commit(`${key}.levels.${i}.closePct`)}
                  error={err(`${key}.levels.${i}.closePct`)}
                  trailing={pct}
                />
                <button
                  type="button"
                  onClick={() => setSide({ ...tp, targets: tp.targets.filter((_, j) => j !== i) })}
                  disabled={tp.targets.length <= 2}
                  aria-label={`Remove ${long ? 'Long' : 'Short'} target ${i + 1}`}
                  className="mt-7 flex h-10 w-10 items-center justify-center rounded-lg text-subtle transition-colors duration-150 hover:bg-inset hover:text-loss disabled:pointer-events-none disabled:opacity-40"
                >
                  <Trash2Icon className="h-4 w-4" aria-hidden />
                </button>
              </li>
            ))}
          </ol>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Button size="sm" icon={PlusIcon} disabled={tp.targets.length >= MAX_TARGETS} onClick={() => setSide({ ...tp, targets: [...tp.targets, { id: newTargetId(), movePct: '', closePct: '' }] })}>
              Add {long ? 'Long' : 'Short'} target
            </Button>
            <p className={cn('text-sm tabular-nums', splitOk ? 'text-gain' : 'text-warn')} aria-live="polite" data-testid="split-shares">
              Shares {total}% of 100% of the Take Profit quantity
            </p>
          </div>
          {(err(key) ?? err(`${key}.levels`)) && <p className="text-xs text-loss">{err(key) ?? err(`${key}.levels`)}</p>}
        </>
      )}

      <p className="text-xs text-subtle" data-testid="exit-allocation" aria-live="polite">
        Of a {long ? 'Long' : 'Short'} position&apos;s confirmed opening quantity: {allocationText(draft, side)}.
      </p>
    </div>
  );
}
