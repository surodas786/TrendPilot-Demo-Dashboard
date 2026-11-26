'use client';

import React from 'react';
import { PlusIcon, Trash2Icon } from 'lucide-react';
import { Decimal, exitAllocation, isDecimalString, MAX_TP_LEVELS, type TakeProfitMode } from '@trendpilot/domain';
import { cn } from '@/lib/cn';
import { Button } from '../ui/Button';
import { DecimalField } from '../ui/DecimalField';
import { SegmentedControl } from '../ui/SegmentedControl';
import { MAX_TARGETS, newTargetId, TP_KEY, type ExitDraft, type SideTakeProfit, type TpSide } from './draft';

interface Props {
  draft: ExitDraft;
  /** Which side's Take Profit this section edits. */
  side: TpSide;
  /** Inline message for a field path (shown once the field was left or Save was pressed). */
  err: (path: string) => string | undefined;
  /** Marks a field as left (blur), so its message shows. */
  commit: (path: string) => void;
  onChange: (patch: Partial<ExitDraft>) => void;
  /** The pair's direction does not currently open this side; its settings are still edited and saved. */
  inactive?: boolean;
  /** Inherited from the admin Common Exit Definition: shown, not editable. */
  readOnly?: boolean;
}

const pct = <span className="pr-2 text-xs text-subtle">%</span>;

function sharesTotal(t: SideTakeProfit): string {
  return t.targets.reduce((s, x) => (isDecimalString(x.closePct.trim()) ? s.plus(x.closePct.trim()) : s), new Decimal(0)).toFixed();
}

/** "Take Profit 60% · Trailing take profit pool 40%" for one side — shared by the editor and its tests. */
export function allocationText(d: ExitDraft, side: TpSide = 'LONG'): string {
  const tp = d.tp[side];
  const tr = d.trailing[side];
  const a = exitAllocation({ takeProfit: { mode: tp.mode, allocationPct: isDecimalString(tp.allocationPct.trim()) ? tp.allocationPct.trim() : null }, trailing: { enabled: tr.enabled } });
  const parts = [`Take profit ${a.takeProfitPct}%`];
  if (tr.enabled) parts.push(`Trailing take profit pool ${a.trailingPct}%`);
  if (a.unallocatedPct !== '0') parts.push(`${a.unallocatedPct}% unallocated (stop loss and signal closes only)`);
  return parts.join(' · ');
}

/**
 * Fixed, Split (2–5 targets) or Off for ONE position side, plus its overall Take Profit allocation
 * (share of the confirmed opening quantity the targets manage; split shares divide it). Long and
 * Short are configured independently; the side of the actual entry selects one, saved with the
 * position. Target IDs are stable, so editing or reordering never re-fires a completed target.
 */
export function TakeProfitEditor({ draft, side, err, commit, onChange, inactive = false, readOnly = false }: Props) {
  const tp = draft.tp[side];
  const key = TP_KEY[side];
  const long = side === 'LONG';
  const setSide = (next: SideTakeProfit) => onChange({ tp: { ...draft.tp, [side]: next } });
  const setTarget = (i: number, patch: Partial<SideTakeProfit['targets'][number]>) => setSide({ ...tp, targets: tp.targets.map((t, j) => (j === i ? { ...t, ...patch } : t)) });

  const setMode = (mode: TakeProfitMode) => {
    if (mode === tp.mode || readOnly) return;
    const first = tp.targets[0] ?? { id: newTargetId(), movePct: '', closePct: '100' };
    if (mode === 'SPLIT') {
      const further = isDecimalString(first.movePct) ? new Decimal(first.movePct).times(2).toFixed() : '';
      setSide({ ...tp, mode, targets: [{ ...first, closePct: '50' }, { id: newTargetId(), movePct: further, closePct: '50' }] });
    } else {
      setSide({ ...tp, mode, targets: [{ ...first, closePct: '100' }] });
    }
  };

  const total = sharesTotal(tp);
  const splitOk = total === '100';
  const label = long ? 'Long take profit' : 'Short take profit';

  return (
    <div className="space-y-3 rounded-lg border border-line p-3" data-testid={`tp-${side}`} data-inactive={inactive || undefined} data-readonly={readOnly || undefined} role="group" aria-label={label}>
      {inactive && (
        <p className="text-xs text-warn" data-testid={`tp-${side}-inactive`}>
          Not used while this pair opens {long ? 'Short' : 'Long'} positions only. Saved for when {long ? 'Long' : 'Short'} entries are allowed.
        </p>
      )}
      <SegmentedControl<TakeProfitMode>
        label={label}
        value={tp.mode}
        onChange={setMode}
        options={(['FIXED', 'SPLIT', 'OFF'] as const).map((m) => ({ value: m, label: m === 'FIXED' ? 'Fixed' : m === 'SPLIT' ? 'Split' : 'Off', disabled: readOnly && m !== tp.mode }))}
        hint={
          tp.mode === 'OFF'
            ? `No take-profit target for ${long ? 'Long' : 'Short'} positions. The stop loss still applies.`
            : long
              ? 'Targets are above the confirmed average entry. Reaching one only arms it; a later move back down through it closes its quantity at market (fill price may differ).'
              : 'Targets are below the confirmed average entry. Reaching one only arms it; a later rebound back up through it closes its quantity at market (fill price may differ).'
        }
      />

      {tp.mode !== 'OFF' && (
        <DecimalField
          label={`${long ? 'Long' : 'Short'} take profit allocation (%)`}
          value={tp.allocationPct}
          onChange={(v) => setSide({ ...tp, allocationPct: v })}
          onCommit={() => commit(`${key}.allocationPct`)}
          error={err(`${key}.allocationPct`)}
          readOnly={readOnly}
          hint="Share of the confirmed opening quantity the targets manage, 0-100 (each target's quantity is rounded down to the contract step and capped at what is still open). With Trailing take profit on, the rest is its pool."
          trailing={pct}
        />
      )}

      {tp.mode === 'FIXED' && (
        <DecimalField
          label={`${long ? 'Long' : 'Short'} target — price move`}
          value={tp.targets[0]?.movePct ?? ''}
          onChange={(v) => setTarget(0, { movePct: v })}
          onCommit={() => commit(`${key}.levels.0.movePct`)}
          error={err(`${key}.levels.0.movePct`) ?? err(`${key}.levels`)}
          readOnly={readOnly}
          hint={`One target for the whole Take Profit allocation, ${long ? 'above' : 'below'} entry.`}
          trailing={pct}
        />
      )}

      {tp.mode === 'SPLIT' && (
        <>
          <ol className="space-y-3">
            {tp.targets.map((t, i) => (
              <li key={t.id} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] items-start gap-2" data-testid={`tp-${side}-level`} data-level-id={t.id}>
                <DecimalField
                  label={`${long ? 'Long' : 'Short'} target ${i + 1} — move`}
                  value={t.movePct}
                  onChange={(v) => setTarget(i, { movePct: v })}
                  onCommit={() => commit(`${key}.levels.${i}.movePct`)}
                  error={err(`${key}.levels.${i}.movePct`)}
                  readOnly={readOnly}
                  trailing={pct}
                />
                <DecimalField
                  label="Share of TP"
                  value={t.closePct}
                  onChange={(v) => setTarget(i, { closePct: v })}
                  onCommit={() => commit(`${key}.levels.${i}.closePct`)}
                  error={err(`${key}.levels.${i}.closePct`)}
                  readOnly={readOnly}
                  trailing={pct}
                />
                <button
                  type="button"
                  onClick={() => setSide({ ...tp, targets: tp.targets.filter((_, j) => j !== i) })}
                  disabled={readOnly || tp.targets.length <= 2}
                  aria-label={`Remove ${long ? 'Long' : 'Short'} target ${i + 1}`}
                  className="mt-7 flex h-10 w-10 items-center justify-center rounded-lg text-subtle transition-colors duration-150 hover:bg-inset hover:text-loss disabled:pointer-events-none disabled:opacity-40"
                >
                  <Trash2Icon className="h-4 w-4" aria-hidden />
                </button>
              </li>
            ))}
          </ol>
          <div className="flex flex-wrap items-center justify-between gap-2">
            {!readOnly && (
              <Button size="sm" icon={PlusIcon} disabled={tp.targets.length >= MAX_TARGETS} onClick={() => setSide({ ...tp, targets: [...tp.targets, { id: newTargetId(), movePct: '', closePct: '' }] })}>
                Add {long ? 'Long' : 'Short'} target ({tp.targets.length} of {MAX_TP_LEVELS})
              </Button>
            )}
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
