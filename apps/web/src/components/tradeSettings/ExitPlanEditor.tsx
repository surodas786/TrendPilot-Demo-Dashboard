'use client';

import React from 'react';
import { TakeProfitEditor } from './TakeProfitEditor';
import { TrailingEditor } from './TrailingEditor';
import { TP_SIDES, type ExitDraft, type TpSide } from './draft';

interface Props {
  draft: ExitDraft;
  err: (path: string) => string | undefined;
  commit: (path: string) => void;
  onChange: (patch: Partial<ExitDraft>) => void;
  /** Sides the direction does not open now (still edited and saved). */
  inactiveSides?: TpSide[];
  readOnly?: boolean;
  /** Why a partial exit is not verified as protected on this exchange/mode (null = verified). */
  protectionLimitation?: string | null;
}

/**
 * The shared exit plan editor: Take Profit and Trailing Take Profit for Long and for Short, set
 * independently. Used by the investor order block (Exit Plan) and Admin → Common Exit Definition,
 * so both have the same fields and validation.
 */
export function ExitPlanEditor({ draft, err, commit, onChange, inactiveSides = [], readOnly = false, protectionLimitation = null }: Props) {
  return (
    <div className="space-y-4" data-testid="exit-plan-editor">
      {TP_SIDES.map((side) => (
        <div key={side} className="space-y-3" data-testid={`exit-side-${side}`}>
          <h4 className="text-xs font-semibold uppercase tracking-wide text-subtle">{side === 'LONG' ? 'Long positions' : 'Short positions'}</h4>
          <TakeProfitEditor side={side} draft={draft} err={err} commit={commit} onChange={onChange} inactive={inactiveSides.includes(side)} readOnly={readOnly} />
          <TrailingEditor side={side} draft={draft} err={err} commit={commit} onChange={onChange} inactive={inactiveSides.includes(side)} readOnly={readOnly} protectionLimitation={protectionLimitation} />
        </div>
      ))}
    </div>
  );
}
