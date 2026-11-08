import React, { useState } from 'react';
import { ChevronRightIcon, InfoIcon } from 'lucide-react';
import { usePlatform } from '../../contexts/PlatformContext';
import { simNow } from '../../utils/clock';
import { DIRECTION_LABELS, OPPOSITE_DESCRIPTIONS, OPPOSITE_EXAMPLES, OPPOSITE_LABELS, OPPOSITE_ORDER, reversalLimited, TIMEFRAME_LABELS, TIMEFRAMES, TREND_FILTER_LABELS } from '../../utils/platformText';
import { Button } from '../ui/Button';
import { Modal } from '../ui/Modal';
import { ModalHeader } from '../ui/ModalHeader';
import { RadioCard } from '../ui/RadioCard';
import { SegmentedControl } from '../ui/SegmentedControl';
import { TextField } from '../ui/TextField';
import type { EntryDirection, OppositeBehavior, SignalTimeframe, StrategyPackage, TrendFilter } from '../../types/platform';

interface Props {
  open: boolean;
  pkg?: StrategyPackage;
  onClose: () => void;
  onSaved: (name: string, isNew: boolean) => void;
}

export function PackageFormModal({ open, pkg, onClose, onSaved }: Props) {
  return (
    <Modal open={open} onClose={onClose} labelledBy="pkg-form-title" size="lg">
      <PackageForm key={pkg?.id ?? 'new'} pkg={pkg} onClose={onClose} onSaved={onSaved} />
    </Modal>);

}

function PackageForm({ pkg, onClose, onSaved }: Omit<Props, 'open'>) {
  const { platform, savePackage } = usePlatform();
  const [name, setName] = useState(pkg?.name ?? '');
  const [direction, setDirection] = useState<EntryDirection>(pkg?.direction ?? 'both');
  const [opposite, setOpposite] = useState<OppositeBehavior>(pkg?.opposite ?? 'close');
  const [timeframe, setTimeframe] = useState<SignalTimeframe | null>(pkg?.timeframe ?? null);
  const [trendFilter, setTrendFilter] = useState<TrendFilter>(pkg?.trendFilter ?? 'off');
  const [status, setStatus] = useState<'active' | 'inactive'>(pkg?.status ?? 'active');
  const [touched, setTouched] = useState(false);

  const trimmed = name.trim();
  const nameError = !trimmed ? 'Enter a package name.' : platform.packages.some((p) => p.id !== pkg?.id && p.name.trim().toLowerCase() === trimmed.toLowerCase()) ? 'Another package already uses this name.' : undefined;
  const timeframeError = timeframe ? undefined : 'Select a signal timeframe.';
  const draft = { direction, opposite };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (nameError || !timeframe) return;
    const at = simNow();
    savePackage({ id: pkg?.id ?? `pkg-${at.toString(36)}`, name: trimmed, direction, opposite, timeframe, trendFilter, status, example: pkg?.example ?? false, createdAt: pkg?.createdAt ?? at, updatedAt: at });
    onSaved(trimmed, !pkg);
  };

  return (
    <form onSubmit={submit} noValidate className="flex min-h-0 flex-col">
      <ModalHeader id="pkg-form-title" title={pkg ? 'Edit package' : 'Create Package'} description="Choose which signals this package follows and how it handles open trades." onClose={onClose} />
      <div className="scrollbar-thin space-y-5 overflow-y-auto px-5 py-5 sm:px-6">
        <TextField label="Package name" value={name} onChange={setName} error={touched ? nameError : undefined} autoFocus={!pkg} />
        <SegmentedControl<EntryDirection>
          label="Entry direction"
          value={direction}
          onChange={setDirection}
          hint="Always limits new entries. Repeated signals in the same direction never add positions."
          options={(['long', 'short', 'both'] as EntryDirection[]).map((d) => ({ value: d, label: DIRECTION_LABELS[d] }))} />
        
        <fieldset className="space-y-2" aria-describedby="pkg-tf-hint">
          <legend className="text-sm font-medium text-ink">Signal timeframe</legend>
          <p id="pkg-tf-hint" className="text-xs text-subtle">This package responds only to signals from the selected timeframe.</p>
          {pkg && !pkg.timeframe && <p className="text-xs text-warn">Timeframe not set. This package keeps working as before until you select and save a timeframe.</p>}
          <div className="grid gap-2 sm:grid-cols-2">
            {TIMEFRAMES.map((tf) =>
            <RadioCard key={tf} name="timeframe" value={tf} checked={timeframe === tf} onChange={(v) => setTimeframe(v as SignalTimeframe)} label={TIMEFRAME_LABELS[tf]} />
            )}
          </div>
          {touched && timeframeError && <p className="text-xs text-loss">{timeframeError}</p>}
        </fieldset>
        <SegmentedControl<TrendFilter>
          label="Trend filter"
          value={trendFilter}
          onChange={setTrendFilter}
          hint={trendFilter === 'ema200' ? 'LONG opens only when the signal candle closes above EMA 200; SHORT only below. Exits are never blocked.' : 'No trend check on new entries.'}
          options={[
          { value: 'off', label: TREND_FILTER_LABELS.off },
          { value: 'ema200', label: TREND_FILTER_LABELS.ema200 }]
          } />
        
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium text-ink">What should happen when a signal comes in the opposite direction?</legend>
          {OPPOSITE_ORDER.map((o) =>
          <RadioCard key={o} name="opposite" value={o} checked={opposite === o} onChange={(v) => setOpposite(v as OppositeBehavior)} label={OPPOSITE_LABELS[o]} description={OPPOSITE_DESCRIPTIONS[o]} />
          )}
          {reversalLimited(draft) &&
          <p className="text-xs text-warn">
              With {DIRECTION_LABELS[direction]}, an opposite signal closes the trade but cannot open the {direction === 'long' ? 'short' : 'long'} side — it works like “{OPPOSITE_LABELS.close}”.
            </p>
          }
        </fieldset>
        <div className="rounded-lg border border-line bg-inset p-3 text-xs" aria-live="polite">
          <p className="font-medium text-ink">Example: an open LONG receives a SHORT signal</p>
          <p className="mt-1 text-muted">{OPPOSITE_EXAMPLES[opposite]}</p>
        </div>
        <SegmentedControl<'active' | 'inactive'>
          label="Status"
          value={status}
          onChange={setStatus}
          options={[
          { value: 'active', label: 'Active' },
          { value: 'inactive', label: 'Inactive' }]
          } />
        
        <p className="flex gap-2 text-xs text-subtle">
          <InfoIcon className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
          <span>Subscribers set their trade size, stop loss, take profit and trailing stop in Trade Settings.</span>
        </p>
        <details className="group rounded-lg border border-line text-xs">
          <summary className="flex min-h-[40px] cursor-pointer list-none items-center gap-1.5 px-3 font-medium text-ink">
            <ChevronRightIcon className="h-3.5 w-3.5 text-subtle transition-transform duration-150 group-open:rotate-90" aria-hidden />
            More details
          </summary>
          <ul className="list-disc space-y-1 px-3 pb-3 pl-7 text-muted">
            <li>A repeated signal ID is treated as a duplicate and never causes a second close or reversal.</li>
            <li>Signals in the same direction as an open trade don’t add to it. Extra entries are allowed only when the subscriber enables multiple entries in Trade Settings.</li>
            <li>A partial take profit reduces the remaining position. A full close cancels any remaining exits. The trailing stop acts only when enabled.</li>
            <li>The first valid exit event acts on the remaining position.</li>
            <li>The timeframe is read from the TradingView interval field (5 or 5m, 15 or 15m). Signals from another timeframe, or without one, are skipped for this package — including opposite-signal closes and reversals. Price-based exits and manual closes are not affected.</li>
          </ul>
        </details>
      </div>
      <footer className="flex flex-col-reverse gap-2 border-t border-line px-5 py-4 sm:flex-row sm:justify-end sm:px-6">
        <Button onClick={onClose}>Cancel</Button>
        <Button type="submit" variant="primary">
          {pkg ? 'Save changes' : 'Create Package'}
        </Button>
      </footer>
    </form>);

}