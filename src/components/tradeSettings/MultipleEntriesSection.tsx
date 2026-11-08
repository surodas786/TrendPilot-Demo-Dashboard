import React, { useState } from 'react';
import { ChevronDownIcon } from 'lucide-react';
import { cn } from '../../utils/cn';
import { Switch } from '../ui/Switch';
import { TextField } from '../ui/TextField';
import type { DraftErrors } from '../../utils/tokenBlocks';
import type { StrategyPackage } from '../../types/platform';
import type { TokenBlockDraft } from '../../types/tradeSettings';

interface Props {
  draft: TokenBlockDraft;
  pkg?: StrategyPackage;
  errors: DraftErrors;
  showErrors: boolean;
  onChange: (patch: Partial<TokenBlockDraft>) => void;
}

function oppositeText(d: TokenBlockDraft, pkg?: StrategyPackage): string {
  if (!pkg) return '';
  if (!d.allowSimultaneousDirections) {
    if (pkg.opposite === 'ignore') return 'This package ignores opposite signals, so no opposing position opens while one direction is held.';
    if (pkg.opposite === 'close') return 'An opposite signal closes the held position; no opposing position opens.';
    return 'An opposite signal closes the held position, then opens the new direction once the close is confirmed (if the package allows it).';
  }
  if (pkg.opposite === 'ignore') return 'With this package, an opposite signal may open the allowed opposing direction alongside the held position.';
  return `This package still ${pkg.opposite === 'close' ? 'closes the held position on an opposite signal' : 'closes, then reverses, on an opposite signal'} — it does not hold both directions.`;
}

export function MultipleEntriesSection({ draft, pkg, errors, showErrors, onChange }: Props) {
  const [open, setOpen] = useState(draft.allowAdditionalEntries || draft.allowSimultaneousDirections);
  return (
    <section className="rounded-lg border border-line">
      <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} className="flex w-full items-center justify-between gap-3 px-3 py-2.5 text-left">
        <span>
          <span className="block text-sm font-medium text-ink">Multiple Entries</span>
          <span className="block text-xs text-subtle">
            {draft.allowAdditionalEntries ? `Up to ${draft.maxEntriesPerDirection || '—'} per direction` : 'One entry per direction'}
            {draft.allowSimultaneousDirections ? ' · Long and short together' : ''}
          </span>
        </span>
        <ChevronDownIcon className={cn('h-4 w-4 text-subtle transition-transform duration-150', open && 'rotate-180')} aria-hidden />
      </button>
      {open &&
      <div className="space-y-4 border-t border-line px-3 py-3">
          <Switch
          label="Allow additional entries on new same-direction signals"
          description={draft.allowAdditionalEntries ? 'Each distinct accepted signal adds at most one entry, using the configured order cost. Duplicate signal IDs never add entries.' : 'Repeated same-direction signals cannot add another entry while that direction is open.'}
          checked={draft.allowAdditionalEntries}
          onChange={(v) => onChange({ allowAdditionalEntries: v, maxEntriesPerDirection: v ? draft.maxEntriesPerDirection : '1' })} />
        
          <TextField
          label="Maximum concurrent entries per direction"
          inputMode="numeric"
          value={draft.allowAdditionalEntries ? draft.maxEntriesPerDirection : '1'}
          onChange={(v) => onChange({ maxEntriesPerDirection: v })}
          disabled={!draft.allowAdditionalEntries}
          error={showErrors ? errors.maxEntriesPerDirection : undefined} />
        
          <Switch
          label="Allow simultaneous Long and Short positions"
          description="Demo setting. In production this would require a compatible exchange position mode."
          checked={draft.allowSimultaneousDirections}
          onChange={(v) => onChange({ allowSimultaneousDirections: v })} />
        
          {pkg && <p className="text-xs text-muted">{oppositeText(draft, pkg)}</p>}
        </div>
      }
    </section>);

}