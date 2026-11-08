'use client';

import React, { useState } from 'react';
import { ChevronDownIcon } from 'lucide-react';
import { PLATFORM_CEILINGS } from '@trendpilot/domain';
import { cn } from '@/lib/cn';
import { TextField } from '../ui/TextField';
import { RISK_FIELDS, type Draft } from './draft';

interface Props {
  draft: Draft;
  errors: Record<string, string>;
  showErrors: boolean;
  onChange: (patch: Partial<Draft>) => void;
}

/** CFG-03 optional stricter caps. Blank uses the platform ceiling shown as the placeholder. */
export function RiskSection({ draft, errors, showErrors, onChange }: Props) {
  const set = Object.values(draft.risk).filter((v) => v.trim() !== '').length;
  const [open, setOpen] = useState(set > 0);
  return (
    <section className="rounded-lg border border-line">
      <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} className="flex w-full items-center justify-between gap-3 px-3 py-2.5 text-left">
        <span>
          <span className="block text-sm font-medium text-ink">Risk limits</span>
          <span className="block text-xs text-subtle">{set ? `${set} stricter limit${set === 1 ? '' : 's'} set` : 'Platform ceilings apply'}</span>
        </span>
        <ChevronDownIcon className={cn('h-4 w-4 text-subtle transition-transform duration-150', open && 'rotate-180')} aria-hidden />
      </button>
      {open && (
        <div className="space-y-3 border-t border-line px-3 py-3">
          <p className="text-xs text-subtle">Optional. Leave blank to use the platform ceiling. You can only make limits stricter. Limits block new entries; exits always continue.</p>
          <div className="grid gap-3 sm:grid-cols-2">
            {RISK_FIELDS.map((f) => (
              <TextField
                key={f.key}
                label={f.label}
                inputMode={f.integer ? 'numeric' : 'decimal'}
                value={draft.risk[f.key]}
                placeholder={`Ceiling ${PLATFORM_CEILINGS[f.key]}`}
                onChange={(v) => onChange({ risk: { ...draft.risk, [f.key]: v } })}
                error={showErrors ? errors[`risk.${f.key}`] : undefined}
                trailing={f.unit ? <span className="pr-2 text-xs text-subtle">{f.unit}</span> : undefined}
              />
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
