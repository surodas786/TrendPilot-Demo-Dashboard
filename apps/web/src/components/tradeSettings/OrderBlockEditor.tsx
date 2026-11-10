'use client';

import React, { useMemo, useState } from 'react';
import { CalculatorIcon, InfoIcon, LockIcon, RotateCcwIcon } from 'lucide-react';
import { toast } from 'sonner';
import {
  Decimal,
  directionPermitted,
  isDecimalString,
  NO_DAYS_WARNING,
  TRADING_DAYS_HELP,
  WEEKDAY_LABELS,
  WEEKDAYS,
  type Direction,
  type MarginMode,
  type OrderBlockDto,
  type PriceBasis,
  type StopType,
  type Weekday
} from '@trendpilot/domain';
import type { InstrumentDto, StrategyVersionDto } from '@trendpilot/db';
import { api, type ApiFailure } from '@/lib/api';
import { Button } from '../ui/Button';
import { ChipCheckboxGroup } from '../ui/ChipCheckboxGroup';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { FilterSelect } from '../ui/FilterSelect';
import { SegmentedControl } from '../ui/SegmentedControl';
import { Switch } from '../ui/Switch';
import { TextField } from '../ui/TextField';
import { MultipleEntriesSection } from './MultipleEntriesSection';
import { PreviewPanel, type PreviewResult } from './PreviewPanel';
import { RiskSection } from './RiskSection';
import { TakeProfitEditor } from './TakeProfitEditor';
import {
  BASIS_LABELS,
  defaultLeverage,
  DIRECTION_LABELS,
  draftFromBlock,
  errorMap,
  exitDefaults,
  newDraft,
  OPPOSITE_LABELS,
  pairLabel,
  settingsPayload,
  validateDraft,
  versionChoices,
  versionLabel,
  type Draft
} from './draft';

const pct = <span className="pr-2 text-xs text-subtle">%</span>;

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-4 border-b border-line pb-5 last:border-b-0">
      <h3 className="text-sm font-semibold text-ink">{title}</h3>
      {children}
    </section>
  );
}

const formatUsdt = (v: Decimal) => `${v.toDecimalPlaces(2).toFixed(2)} USDT`;

interface Props {
  existing?: OrderBlockDto;
  instruments: InstrumentDto[];
  versions: StrategyVersionDto[];
  /** Instruments that already have a Paper block (new blocks cannot reuse them). */
  takenInstrumentIds: string[];
  timezone: string;
  onDone: (saved?: OrderBlockDto) => void;
}

/** Adapted from the MagicPatterns TokenBlockEditor; persists through /v1/me/order-blocks. */
export function OrderBlockEditor({ existing, instruments, versions, takenInstrumentIds, timezone, onDone }: Props) {
  const available = instruments.filter((i) => i.status === 'PUBLISHED' && !takenInstrumentIds.includes(i.id));
  const [draft, setDraft] = useState<Draft>(() => (existing ? draftFromBlock(existing) : newDraft(available[0], available[0] ? versionChoices(versions, available[0].id)[0] : undefined)));
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [exitsTouched, setExitsTouched] = useState(Boolean(existing));
  const [touched, setTouched] = useState(false);
  const [serverIssues, setServerIssues] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmRestore, setConfirmRestore] = useState(false);

  const instrument = instruments.find((i) => i.id === draft.instrumentId);
  const version = versions.find((v) => v.id === draft.strategyVersionId);
  const issues = useMemo(() => validateDraft(draft, instrument, version), [draft, instrument, version]);
  const errors = { ...errorMap(issues), ...serverIssues };
  const err = (path: string) => (touched ? errors[path] : undefined);

  const update = (patch: Partial<Draft>) => {
    setServerIssues({});
    setPreview(null);
    setDraft((d) => ({ ...d, ...patch }));
  };
  const updateExits = (patch: Partial<Draft>) => {
    setExitsTouched(true);
    update(patch);
  };

  const changePair = (id: string) => {
    const next = instruments.find((i) => i.id === id);
    const choices = versionChoices(versions, id);
    setPreview(null);
    setDraft((d) => ({
      ...d,
      instrumentId: id,
      strategyVersionId: choices.some((v) => v.id === d.strategyVersionId) ? d.strategyVersionId : (choices[0]?.id ?? ''),
      leverage: d.leverage !== null && next?.leverageChoices.includes(d.leverage) ? d.leverage : defaultLeverage(next),
      ...(exitsTouched ? {} : exitDefaults(next))
    }));
  };

  const changeVersion = (id: string) => {
    const v = versions.find((x) => x.id === id);
    setDraft((d) => ({ ...d, strategyVersionId: id, direction: v && !directionPermitted(d.direction, v.permittedDirections) ? v.permittedDirections : d.direction }));
  };

  const strategyOptions = versionChoices(versions, draft.instrumentId, existing?.strategyVersionId);
  const newerForPinned = existing && version && !version.isLatest ? versions.find((v) => v.packageId === version.packageId && v.isLatest) : undefined;

  const runPreview = async () => {
    setTouched(true);
    setFormError(null);
    if (issues.length) return;
    setPreviewing(true);
    const r = await api.previewDraft<PreviewResult>({ ...settingsPayload(draft), instrumentId: draft.instrumentId, mode: 'PAPER' });
    setPreviewing(false);
    if (r.ok) setPreview(r.data);
    else fail(r);
  };

  const pairOptions = existing
    ? [{ value: existing.instrumentId, label: instrument ? pairLabel(instrument) : existing.symbol }]
    : available.map((i) => ({ value: i.id, label: pairLabel(i) }));

  const cost = isDecimalString(draft.orderCostUsdt.trim()) ? new Decimal(draft.orderCostUsdt.trim()) : null;
  const notional = cost && cost.gt(0) && draft.leverage ? cost.times(draft.leverage) : null;

  const fail = (f: ApiFailure) => {
    if (f.code === 'REVISION_CONFLICT') setFormError('This block was changed in another window. Close the panel and reopen it to load the latest version.');
    else if (f.issues.length) {
      setServerIssues(errorMap(f.issues));
      setFormError(f.message);
    } else setFormError(f.message);
  };

  const submit = async (activate: boolean) => {
    setTouched(true);
    setFormError(null);
    if (issues.length) return;
    setSaving(true);
    try {
      const settings = settingsPayload(draft);
      let saved: OrderBlockDto;
      if (existing) {
        const r = await api.updateBlock(existing.id, existing.revision, settings);
        if (!r.ok) return fail(r);
        saved = r.data;
      } else {
        const r = await api.createBlock({ ...settings, instrumentId: draft.instrumentId, mode: 'PAPER' });
        if (!r.ok) return fail(r);
        saved = r.data;
        if (activate) {
          const a = await api.resumeBlock(saved.id, saved.revision);
          if (!a.ok) {
            toast.error('Saved, but not activated', { description: a.message });
            onDone(saved);
            return;
          }
          saved = a.data;
        }
      }
      toast.success(activate ? 'Saved & activated — waiting for signal' : 'Order block saved', {
        description: saved.status === 'ACTIVE' ? 'No position opens until a matching signal arrives.' : 'Paused until you resume it.'
      });
      onDone(saved);
    } finally {
      setSaving(false);
    }
  };

  const noDays = draft.weekdays.length === 0;

  return (
    <div className="flex h-full flex-col">
      <div className="scrollbar-thin flex-1 space-y-5 overflow-y-auto px-5 py-4">
        <Section title="Token and strategy">
          {existing && (
            <p className="flex items-start gap-2 text-xs text-muted">
              <LockIcon className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
              Pair and mode identify this block and cannot change. Other edits apply to future entries only.
            </p>
          )}
          <FilterSelect label="Trading pair" value={draft.instrumentId} onChange={changePair} options={pairOptions.length ? pairOptions : [{ value: '', label: 'No pairs available' }]} disabled={Boolean(existing)} />
          {err('instrumentId') && <p className="-mt-2 text-xs text-loss">{err('instrumentId')}</p>}
          {instrument && (
            <p className="-mt-2 text-xs text-subtle">
              Exchange: {instrument.exchange} Futures (derived from the pair){instrument.isFixture ? ' · fixture metadata, not verified exchange limits' : ''}
            </p>
          )}
          <FilterSelect
            label="Strategy"
            value={draft.strategyVersionId}
            onChange={changeVersion}
            options={strategyOptions.length ? strategyOptions.map((v) => ({ value: v.id, label: versionLabel(v) })) : [{ value: '', label: 'No strategy is approved for this pair' }]}
          />
          {err('strategyVersionId') && <p className="-mt-2 text-xs text-loss">{err('strategyVersionId')}</p>}
          {newerForPinned && draft.strategyVersionId === existing?.strategyVersionId && (
            <p className="-mt-2 flex items-start gap-1.5 text-xs text-muted" data-testid="pinned-notice">
              <InfoIcon className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
              This block stays pinned to v{version?.version}. Version {newerForPinned.version} is published; select it above to move this block.
            </p>
          )}
          {version && (
            <p className="rounded-lg bg-inset px-3 py-2 text-xs text-muted">
              {version.timeframe} Supertrend (ATR {version.atrLength}, factor {version.atrFactor}) · EMA filter {version.emaFilter === 'OFF' ? 'off' : '200'} · Opposite signal: {OPPOSITE_LABELS[version.oppositePolicy]} · Signal max age {version.signalMaxAgeSeconds}s. Published by the administrator; a version never changes after publishing.
            </p>
          )}
          <SegmentedControl<Direction>
            label="Direction"
            value={draft.direction}
            onChange={(v) => update({ direction: v })}
            options={(['LONG_ONLY', 'SHORT_ONLY', 'BOTH'] as const).map((d) => ({ value: d, label: DIRECTION_LABELS[d], disabled: version ? !directionPermitted(d, version.permittedDirections) : false }))}
            error={err('direction')}
          />
          <SegmentedControl<'PAPER' | 'LIVE'>
            label="Trading mode"
            value="PAPER"
            onChange={() => undefined}
            options={[
              { value: 'PAPER', label: 'Paper' },
              { value: 'LIVE', label: 'Live — unavailable', disabled: true }
            ]}
            hint="Live trading is disabled in this build. Paper blocks use simulated execution only."
          />
        </Section>

        <Section title="Trading days">
          <ChipCheckboxGroup
            label={
              <span className="flex flex-wrap items-baseline gap-x-2">
                New entries allowed on <span className="text-xs font-normal text-subtle">Timezone: {timezone}</span>
              </span>
            }
            description={TRADING_DAYS_HELP}
            options={WEEKDAYS.map((d) => ({ value: d, label: WEEKDAY_LABELS[d] }))}
            value={draft.weekdays}
            onChange={(v) => update({ weekdays: v as Weekday[] })}
            error={err('weekdays')}
          />
          {noDays && (
            <p role="status" className="rounded-lg border border-warn/40 bg-warn/10 px-3 py-2 text-xs text-warn">
              {NO_DAYS_WARNING}
            </p>
          )}
        </Section>

        <Section title="Order size">
          <TextField
            label="Order cost (USDT)"
            inputMode="decimal"
            value={draft.orderCostUsdt}
            onChange={(v) => update({ orderCostUsdt: v })}
            hint="The margin allocated to each new entry, before fees."
            error={err('orderCostUsdt')}
          />
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <FilterSelect
                label="Leverage"
                value={draft.leverage ? String(draft.leverage) : ''}
                onChange={(v) => update({ leverage: v ? Number(v) : null })}
                options={[...(draft.leverage ? [] : [{ value: '', label: 'Select leverage' }]), ...(instrument?.leverageChoices ?? []).map((l) => ({ value: String(l), label: `${l}×` }))]}
              />
              {err('leverage') && <p className="mt-1 text-xs text-loss">{err('leverage')}</p>}
            </div>
            <SegmentedControl<MarginMode>
              label="Margin mode"
              value={draft.marginMode}
              onChange={(v) => update({ marginMode: v })}
              options={[
                { value: 'ISOLATED', label: 'Isolated' },
                { value: 'CROSS', label: 'Cross' }
              ]}
            />
          </div>
          <dl className="grid grid-cols-3 gap-2 rounded-lg bg-inset px-3 py-2.5 text-xs tabular-nums">
            <div>
              <dt className="text-subtle">Margin per entry</dt>
              <dd className="mt-0.5 text-sm text-ink">{cost && cost.gt(0) ? formatUsdt(cost) : '—'}</dd>
            </div>
            <div>
              <dt className="text-subtle">Leverage</dt>
              <dd className="mt-0.5 text-sm text-ink">{draft.leverage ? `${draft.leverage}×` : '—'}</dd>
            </div>
            <div>
              <dt className="text-subtle">Target notional</dt>
              <dd className="mt-0.5 text-sm font-semibold text-ink">{notional ? formatUsdt(notional) : '—'}</dd>
            </div>
          </dl>
          <p className="text-xs text-subtle">Estimate before fees and contract rounding. A full order preview arrives with sizing (EXE-01).</p>
        </Section>

        <Section title="Exits">
          {existing?.trailingConversionRequired && (
            <div role="status" data-testid="trailing-conversion-banner" className="flex gap-2 rounded-lg border border-warn/40 bg-warn/10 p-3 text-xs text-ink">
              <InfoIcon className="mt-0.5 h-4 w-4 shrink-0 text-warn" aria-hidden />
              <p>
                <span className="font-semibold">New entries are on hold.</span> This block was saved with the old Trailing Stop, which is replaced by Trailing take
                profit. Enter Activate after profit (%) — it is not taken from the old trailing distance — or turn trailing off, then save. Open positions keep the
                behaviour they were opened with.
              </p>
            </div>
          )}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs text-subtle">Percentages are price movement from entry.</p>
            <Button size="sm" variant="ghost" icon={RotateCcwIcon} onClick={() => setConfirmRestore(true)} disabled={!instrument}>
              Restore suggested values
            </Button>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <SegmentedControl<StopType>
              label="Stop type"
              value={draft.stopType}
              onChange={(v) => updateExits({ stopType: v })}
              options={[
                { value: 'PERCENT', label: 'Percent' },
                { value: 'PRICE', label: 'Price' }
              ]}
            />
            <FilterSelect
              label="Stop trigger basis"
              value={draft.stopBasis}
              onChange={(v) => updateExits({ stopBasis: v as PriceBasis })}
              options={(['MARK', 'LAST'] as const).map((b) => ({ value: b, label: BASIS_LABELS[b] }))}
            />
          </div>
          <TextField
            label="Stop loss"
            inputMode="decimal"
            value={draft.stopPct}
            onChange={(v) => updateExits({ stopPct: v })}
            hint={
              draft.stopType === 'PERCENT'
                ? 'Required. Distance from entry: below for longs, above for shorts. Sent with the opening order; protects the whole position before and after Trailing take profit activates.'
                : 'Required. Absolute trigger price. Must be below entry for longs and above for shorts — check the preview.'
            }
            error={err('stop')}
            trailing={draft.stopType === 'PERCENT' ? pct : <span className="pr-2 text-xs text-subtle">USDT</span>}
          />
          <TakeProfitEditor draft={draft} errors={errors} showErrors={touched} onChange={updateExits} />
          <div className="space-y-3 rounded-lg border border-line p-3" data-testid="trailing-take-profit">
            <Switch
              label="Trailing take profit"
              description="Locks in profit after a favourable move: it arms only once price has moved by Activate after profit, then closes its quantity at market when price pulls back by Trail distance from the best price since activation."
              checked={draft.trailingEnabled}
              onChange={(v) => updateExits({ trailingEnabled: v })}
            />
            {draft.trailingEnabled && (
              <>
                <div className="grid gap-3 sm:grid-cols-3">
                  <TextField
                    label="Activate after profit (%)"
                    inputMode="decimal"
                    value={draft.trailingActivationPct}
                    onChange={(v) => updateExits({ trailingActivationPct: v })}
                    error={err('trailing.activationPct')}
                    hint="Required. Long: price rises this much; Short: price falls this much."
                    trailing={pct}
                  />
                  <TextField
                    label="Trail distance (%)"
                    inputMode="decimal"
                    value={draft.trailingPct}
                    onChange={(v) => updateExits({ trailingPct: v })}
                    error={err('trailing.distancePct')}
                    hint="Required. Pullback from the highest (Long) or lowest (Short) price."
                    trailing={pct}
                  />
                  <FilterSelect label="Trigger basis" value={draft.trailingBasis} onChange={(v) => updateExits({ trailingBasis: v as PriceBasis })} options={(['MARK', 'LAST'] as const).map((b) => ({ value: b, label: BASIS_LABELS[b] }))} />
                </div>
                <p className="text-xs text-subtle">
                  Both percentages are price movement from the confirmed average entry, before fees and leverage. Until it activates it does nothing. The stop loss above
                  stays in place for the whole position before and after activation.
                </p>
                {err('trailing') && <p className="text-xs text-loss">{err('trailing')}</p>}
              </>
            )}
          </div>
        </Section>

        <MultipleEntriesSection draft={draft} errors={errors} showErrors={touched} onChange={update} />
        <RiskSection draft={draft} errors={errors} showErrors={touched} onChange={update} />

        <section className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-semibold text-ink">Order preview</h3>
            <Button size="sm" icon={CalculatorIcon} onClick={runPreview} loading={previewing}>
              Preview order
            </Button>
          </div>
          {preview ? <PreviewPanel preview={preview} /> : <p className="text-xs text-subtle">Shows contracts, margin, fees, stop and targets from fixture prices. Nothing is sent to an exchange.</p>}
        </section>
      </div>

      <footer className="space-y-2 border-t border-line px-5 py-4">
        {touched && issues.length > 0 && <p className="text-xs text-loss">Fix the highlighted fields before saving.</p>}
        {formError && (
          <p role="alert" className="text-xs text-loss">
            {formError}
          </p>
        )}
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button onClick={() => onDone()}>Cancel</Button>
          <Button onClick={() => submit(false)} loading={saving}>
            Save
          </Button>
          {!existing && (
            <Button variant="primary" onClick={() => submit(true)} loading={saving}>
              Save &amp; Activate
            </Button>
          )}
        </div>
      </footer>

      <ConfirmDialog
        open={confirmRestore}
        title="Restore suggested values?"
        description={`Replace this draft's stop loss, take profit and Trailing take profit with the administrator's current ${instrument ? pairLabel(instrument) : ''} suggestions. Nothing is saved until you press Save.`}
        confirmLabel="Restore"
        onConfirm={() => {
          updateExits(exitDefaults(instrument));
          setConfirmRestore(false);
        }}
        onCancel={() => setConfirmRestore(false)}
      />
    </div>
  );
}
