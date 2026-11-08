'use client';

import React, { useState } from 'react';
import { ChevronDownIcon } from 'lucide-react';
import { cn } from '@/lib/cn';
import { Switch } from '../ui/Switch';
import { TextField } from '../ui/TextField';
import type { Draft } from './draft';

interface Props {
  draft: Draft;
  errors: Record<string, string>;
  showErrors: boolean;
  onChange: (patch: Partial<Draft>) => void;
}

/**
 * Adapted from the MagicPatterns section. The demo's "simultaneous Long and Short"
 * option is removed: SCP-01 allows one-way exposure per contract only (conflict C4).
 */
export function MultipleEntriesSection({ draft, errors, showErrors, onChange }: Props) {
  const [open, setOpen] = useState(draft.allowAdds);
  return (
    <section className="rounded-lg border border-line">
      <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} className="flex w-full items-center justify-between gap-3 px-3 py-2.5 text-left">
        <span>
          <span className="block text-sm font-medium text-ink">Multiple entries</span>
          <span className="block text-xs text-subtle">{draft.allowAdds ? `Up to ${draft.maxAdds || '—'} additional entries` : 'Off — one entry per position'}</span>
        </span>
        <ChevronDownIcon className={cn('h-4 w-4 text-subtle transition-transform duration-150', open && 'rotate-180')} aria-hidden />
      </button>
      {open && (
        <div className="space-y-4 border-t border-line px-3 py-3">
          <Switch
            label="Allow additional entries on new same-direction signals"
            description="Each fresh qualifying signal may add one entry using the order cost above. Adds aggregate into one position per contract."
            checked={draft.allowAdds}
            onChange={(v) => onChange({ allowAdds: v, maxAdds: v ? draft.maxAdds || '1' : '1' })}
          />
          <TextField
            label="Maximum additional entries"
            inputMode="numeric"
            value={draft.allowAdds ? draft.maxAdds : '—'}
            onChange={(v) => onChange({ maxAdds: v })}
            disabled={!draft.allowAdds}
            error={showErrors ? errors.maxAdds : undefined}
            hint="Live adds stay disabled until add and target-recalculation rules are approved (EXE-05)."
          />
        </div>
      )}
    </section>
  );
}
