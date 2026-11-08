import React from 'react';
import { Switch } from '../ui/Switch';
import { TextField } from '../ui/TextField';

export interface DefaultsDraft {
  stopLossPct: string;
  takeProfitPct: string;
  trailingEnabled: boolean;
  trailingPct: string;
  enabled: boolean;
}

export const PERCENT_NOTE = 'Percentages refer to price movement from entry, not leveraged return on margin. Trailing distance follows the best price reached after entry.';

function pctError(v: string): string | undefined {
  const n = Number(v);
  if (!v.trim() || Number.isNaN(n)) return 'Enter a number.';
  if (n <= 0 || n >= 100) return 'Must be greater than 0 and below 100.';
  return undefined;
}

export function defaultsErrors(d: DefaultsDraft) {
  return { stopLossPct: pctError(d.stopLossPct), takeProfitPct: pctError(d.takeProfitPct), trailingPct: d.trailingEnabled ? pctError(d.trailingPct) : undefined };
}

export function hasErrors(e: ReturnType<typeof defaultsErrors>): boolean {
  return Boolean(e.stopLossPct || e.takeProfitPct || e.trailingPct);
}

const pctSuffix = <span className="pr-2 text-xs text-subtle">%</span>;

export function PairDefaultsFields({ draft, onChange, showErrors }: {draft: DefaultsDraft;onChange: (d: DefaultsDraft) => void;showErrors: boolean;}) {
  const e = showErrors ? defaultsErrors(draft) : {};
  return (
    <div className="space-y-4">
      <Switch label="Pair enabled" description="Enabled pairs join the shared simulated price feed. Disabling blocks new simulated entries; it does not close existing positions." checked={draft.enabled} onChange={(v) => onChange({ ...draft, enabled: v })} />
      <div className="grid gap-3 sm:grid-cols-2">
        <TextField label="Suggested stop loss" inputMode="decimal" value={draft.stopLossPct} onChange={(v) => onChange({ ...draft, stopLossPct: v })} error={e.stopLossPct} trailing={pctSuffix} />
        <TextField label="Suggested take profit" inputMode="decimal" value={draft.takeProfitPct} onChange={(v) => onChange({ ...draft, takeProfitPct: v })} error={e.takeProfitPct} trailing={pctSuffix} />
      </div>
      <Switch label="Trailing stop" checked={draft.trailingEnabled} onChange={(v) => onChange({ ...draft, trailingEnabled: v })} />
      {draft.trailingEnabled && <TextField label="Suggested trailing distance" inputMode="decimal" value={draft.trailingPct} onChange={(v) => onChange({ ...draft, trailingPct: v })} error={e.trailingPct} trailing={pctSuffix} />}
      <p className="text-xs text-subtle">{PERCENT_NOTE} Values are illustrative defaults, not recommendations. They prefill new subscriber token blocks later; subscribers can override them, and edits here never change existing subscriber settings or open positions.</p>
    </div>);

}