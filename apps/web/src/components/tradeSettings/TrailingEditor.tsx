'use client';

import React from 'react';
import { Decimal, isDecimalString, type PriceBasis } from '@trendpilot/domain';
import { DecimalField } from '../ui/DecimalField';
import { FilterSelect } from '../ui/FilterSelect';
import { Switch } from '../ui/Switch';
import { BASIS_LABELS, TRAILING_KEY, type ExitDraft, type SideTrailing, type TpSide } from './draft';

const pct = <span className="pr-2 text-xs text-subtle">%</span>;

interface Props {
  draft: ExitDraft;
  side: TpSide;
  err: (path: string) => string | undefined;
  commit: (path: string) => void;
  onChange: (patch: Partial<ExitDraft>) => void;
  inactive?: boolean;
  readOnly?: boolean;
  /** Shown when a partial exit cannot be verified as protected on the selected exchange (null = verified). */
  protectionLimitation?: string | null;
}

/** Worked example for the remainder text: 10 units, close X% → closes N, N left under the stop. */
export function remainderExample(closePct: string): string | null {
  const v = closePct.trim();
  if (!isDecimalString(v)) return null;
  const p = new Decimal(v);
  if (p.lt(1) || p.gt(100)) return null;
  const closed = new Decimal(10).times(p).div(100).floor();
  return p.eq(100) ? 'Example: a pool of 10 units closes all 10.' : `Example: a pool of 10 units closes ${closed.toFixed()} (rounded down to the step) and ${new Decimal(10).minus(closed).toFixed()} stay open under the same stop loss.`;
}

/**
 * Trailing Take Profit for ONE position side: activation, retracement, close share per trigger,
 * optional one-shot target close, trigger basis — independent of the other side.
 */
export function TrailingEditor({ draft, side, err, commit, onChange, inactive = false, readOnly = false, protectionLimitation = null }: Props) {
  const tr = draft.trailing[side];
  const key = TRAILING_KEY[side];
  const long = side === 'LONG';
  const set = (patch: Partial<SideTrailing>) => !readOnly && onChange({ trailing: { ...draft.trailing, [side]: { ...tr, ...patch } } });
  const partial = isDecimalString(tr.closePct.trim()) && new Decimal(tr.closePct.trim()).lt(100);
  const example = remainderExample(tr.closePct);

  return (
    <div className="space-y-3 rounded-lg border border-line p-3" data-testid={`trailing-${side}`} data-inactive={inactive || undefined} data-readonly={readOnly || undefined} role="group" aria-label={`${long ? 'Long' : 'Short'} trailing take profit`}>
      <Switch
        label={`${long ? 'Long' : 'Short'} trailing take profit`}
        description={`Locks in profit after a favourable move: it arms once price has ${long ? 'risen' : 'fallen'} by Activate after profit, then closes its share at market when price pulls back by Retracement from the ${long ? 'highest' : 'lowest'} price since activation.`}
        checked={tr.enabled}
        onChange={(v) => set({ enabled: v })}
        disabled={readOnly}
      />
      {tr.enabled && (
        <>
          <div className="grid gap-3 sm:grid-cols-3">
            <DecimalField
              label="Activate after profit (%)"
              value={tr.activationPct}
              onChange={(v) => set({ activationPct: v })}
              onCommit={() => commit(`${key}.activationPct`)}
              error={err(`${key}.activationPct`)}
              readOnly={readOnly}
              hint={long ? 'Price rises this much from entry.' : 'Price falls this much from entry.'}
              trailing={pct}
            />
            <DecimalField
              label="Retracement (%)"
              value={tr.distancePct}
              onChange={(v) => set({ distancePct: v })}
              onCommit={() => commit(`${key}.distancePct`)}
              error={err(`${key}.distancePct`)}
              readOnly={readOnly}
              hint={`Pullback from the ${long ? 'highest' : 'lowest'} price since activation.`}
              trailing={pct}
            />
            <FilterSelect label="Trigger basis" value={tr.basis} onChange={(v) => set({ basis: v as PriceBasis })} options={(['MARK', 'LAST'] as const).map((b) => ({ value: b, label: BASIS_LABELS[b] }))} disabled={readOnly} />
          </div>
          <DecimalField
            label="Close on each trigger (%)"
            value={tr.closePct}
            onChange={(v) => set({ closePct: v })}
            onCommit={() => commit(`${key}.closePct`)}
            error={err(`${key}.closePct`)}
            readOnly={readOnly}
            hint="1-100% of the trailing pool still open when the trigger fires (the pool is the remaining quantity the take-profit targets do not reserve). The quantity is fixed when the trigger fires, rounded down to the contract step; 100% closes the whole pool."
            trailing={pct}
          />
          <div className="space-y-3 rounded-lg bg-inset px-3 py-2.5">
            <Switch
              label="Target close"
              description={`A fixed target inside trailing: when price first reaches it (${long ? 'above' : 'below'} entry) it closes its share of the pool at market, once per position, without waiting for activation or a pullback.`}
              checked={tr.targetCloseEnabled}
              onChange={(v) => set({ targetCloseEnabled: v, ...(v ? {} : { targetMovePct: '', targetClosePct: '' }) })}
              disabled={readOnly}
            />
            {tr.targetCloseEnabled && (
              <div className="grid gap-3 sm:grid-cols-2">
                <DecimalField label="Target close — price move (%)" value={tr.targetMovePct} onChange={(v) => set({ targetMovePct: v })} onCommit={() => commit(`${key}.targetClose.movePct`)} error={err(`${key}.targetClose.movePct`)} readOnly={readOnly} trailing={pct} />
                <DecimalField label="Target close — share of pool (%)" value={tr.targetClosePct} onChange={(v) => set({ targetClosePct: v })} onCommit={() => commit(`${key}.targetClose.closePct`)} error={err(`${key}.targetClose.closePct`)} readOnly={readOnly} hint="1-100%." trailing={pct} />
              </div>
            )}
            {err(`${key}.targetClose`) && <p className="text-xs text-loss">{err(`${key}.targetClose`)}</p>}
          </div>
          <div className="space-y-1 text-xs text-muted" data-testid={`trailing-${side}-remainder`}>
            <p>
              <span className="font-semibold text-ink">What stays open.</span>{' '}
              {partial
                ? `Each trigger closes ${tr.closePct.trim()}% of the pool; the rest stays open under the same stop loss at its original price (it is not moved to break-even). The trigger is recorded once. Trailing then rearms only after price makes a new ${long ? 'high' : 'low'} beyond that cycle's best price, and starts a fresh retracement from there.`
                : 'At 100% a trigger closes the whole pool through the exchange close path; nothing of the pool stays open.'}
            </p>
            {example && <p>{example} A share the exchange cannot trade (below the step or minimum, or leaving less than the minimum) is reported and not sent — it is never turned into a full close.</p>}
            <p>Percentages of price are movement from the confirmed average entry, before fees and leverage. The target close fires once per position.</p>
          </div>
          {partial && protectionLimitation && (
            <p className="rounded-lg border border-warn/40 bg-warn/10 px-3 py-2 text-xs text-warn" data-testid={`trailing-${side}-protection`}>
              Not verified as protected: {protectionLimitation}
            </p>
          )}
          {err(key) && <p className="text-xs text-loss">{err(key)}</p>}
        </>
      )}
      {!tr.enabled && err(key) && <p className="text-xs text-loss">{err(key)}</p>}
    </div>
  );
}
