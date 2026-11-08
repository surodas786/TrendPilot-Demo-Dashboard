import React, { useState } from 'react';
import { PlusIcon } from 'lucide-react';
import { toast } from 'sonner';
import { useDemo } from '../../contexts/DemoContext';
import { Button } from '../ui/Button';
import { Switch } from '../ui/Switch';
import { CopyButton } from '../ui/CopyButton';
import { FilterSelect } from '../ui/FilterSelect';
import { RadioCard } from '../ui/RadioCard';
import { SegmentedControl } from '../ui/SegmentedControl';
import {
  ACTION_LABELS,
  ALL_ACTIONS,
  newRouteDraft,
  ROUTE_ENDPOINT_NOTE,
  ROUTE_TIMEFRAME_LABELS,
  ROUTE_TIMEFRAMES,
  routeTriggerName,
  routeTriggerType,
  routeUsage,
  strategyIdFor,
  USAGE_DESCRIPTIONS,
  USAGE_LABELS } from
'../../data/signalRoutes';
import { buildPayload, defaultSignalInput } from '../../utils/signalPayload';
import { simNow } from '../../utils/clock';
import type { RouteTriggerType, RouteUsage, SignalAction, SignalRoute } from '../../types/signals';

const inputCls = 'h-9 rounded-lg border border-line bg-inset px-3 text-sm text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/60';

/** Saved signal routes. Changes apply to new signals only; history and trade snapshots are never rewritten. */
export function RouteSettings() {
  const { state } = useDemo();
  const [selectedId, setSelectedId] = useState(state.routes[0]?.id ?? '');
  const [creating, setCreating] = useState<SignalRoute | null>(null);
  const saved = state.routes.find((r) => r.id === selectedId) ?? state.routes[0];

  const startNew = () => setCreating(newRouteDraft(simNow(), state.routes[0]));

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <div className="w-full max-w-sm">
          <FilterSelect
            label="Signal route"
            value={creating ? '__new' : saved.id}
            onChange={(v) => {
              setCreating(null);
              setSelectedId(v);
            }}
            options={[...(creating ? [{ value: '__new', label: 'New route (unsaved)' }] : []), ...state.routes.map((r) => ({ value: r.id, label: `${r.label} · ${r.timeframe}` }))]} />
          
        </div>
        <Button icon={PlusIcon} onClick={startNew} disabled={!!creating}>
          Add Route
        </Button>
      </div>
      <RouteEditor
        key={creating ? creating.id : saved.id}
        saved={creating ?? saved}
        isNew={!!creating}
        onSaved={(id) => {
          setCreating(null);
          setSelectedId(id);
        }}
        onCancelNew={() => setCreating(null)} />
      
    </div>);

}

function RouteEditor({ saved, isNew, onSaved, onCancelNew }: {saved: SignalRoute;isNew: boolean;onSaved: (id: string) => void;onCancelNew: () => void;}) {
  const { state, updateRoute, addRoute } = useDemo();
  const [draft, setDraft] = useState<SignalRoute>({ ...saved, triggerType: routeTriggerType(saved), usage: routeUsage(saved), triggerName: saved.triggerName ?? '' });
  const [touched, setTouched] = useState(false);
  const pair = Object.values(saved.symbolMap)[0];
  const sample = JSON.stringify(buildPayload(defaultSignalInput(saved, pair, 'open-long', state.paperPrices[pair] ?? 0, simNow()), saved), null, 2);

  const ageInvalid = !(draft.maxSignalAgeSec > 0) || !(draft.closeMaxSignalAgeSec > 0);
  const nameError = !draft.label.trim() ? 'Route name is required.' : state.routes.some((r) => r.id !== draft.id && r.label.trim().toLowerCase() === draft.label.trim().toLowerCase()) ? 'Another route already uses this name.' : undefined;
  const triggerError = draft.triggerType === 'custom' && !draft.triggerName?.trim() ? 'Name the indicator or alert condition.' : undefined;
  const actionsError = draft.allowedActions.length === 0 ? 'Allow at least one action.' : undefined;
  const invalid = !!(ageInvalid || nameError || triggerError || actionsError);
  const dirty = isNew || JSON.stringify(draft) !== JSON.stringify({ ...saved, triggerType: routeTriggerType(saved), usage: routeUsage(saved), triggerName: saved.triggerName ?? '' });

  const toggleAction = (a: SignalAction) =>
  setDraft((d) => ({ ...d, allowedActions: d.allowedActions.includes(a) ? d.allowedActions.filter((x) => x !== a) : [...d.allowedActions, a] }));

  const setTrigger = (t: RouteTriggerType) => setDraft((d) => ({ ...d, triggerType: t, strategyId: strategyIdFor(t, d.triggerName ?? '') }));

  const save = () => {
    setTouched(true);
    if (invalid) return;
    const type = draft.triggerType ?? 'supertrend';
    const name = type === 'custom' ? draft.triggerName!.trim() : undefined;
    // Existing routes keep their strategy identifier so earlier signals stay linked; only a trigger-type change updates it.
    const strategyId = !isNew && type === routeTriggerType(saved) ? saved.strategyId : strategyIdFor(type, name ?? '');
    const next: SignalRoute = { ...draft, label: draft.label.trim(), triggerName: name, strategyId };
    if (isNew) addRoute(next);else
    updateRoute(next);
    toast.success(isNew ? 'Signal route added' : 'Route saved', { description: 'Applies to new signals only.' });
    onSaved(next.id);
  };

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
      <section className="space-y-4 rounded-xl border border-line bg-surface p-4">
        <div>
          <h3 className="text-sm font-semibold text-ink">{isNew ? 'New signal route' : `${saved.label}`}</h3>
          <p className="mt-0.5 font-mono text-xs text-subtle">{draft.id}</p>
          <p className="mt-0.5 text-xs text-muted">{ROUTE_ENDPOINT_NOTE}.{routeTriggerType(draft) === 'supertrend' ? ' Supertrend indicator parameters are read-only.' : ''}</p>
        </div>
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-subtle">Route name</span>
          <input value={draft.label} onChange={(e) => setDraft({ ...draft, label: e.target.value })} className={inputCls} />
          {(touched || !isNew) && nameError && <span className="text-xs text-loss">{nameError}</span>}
        </label>
        <SegmentedControl<string>
          label="Timeframe"
          value={draft.timeframe}
          onChange={(v) => setDraft({ ...draft, timeframe: v })}
          options={ROUTE_TIMEFRAMES.map((t) => ({ value: t, label: ROUTE_TIMEFRAME_LABELS[t] }))} />
        
        <div className="space-y-2">
          <SegmentedControl<RouteTriggerType>
            label="Alert trigger"
            value={draft.triggerType ?? 'supertrend'}
            onChange={setTrigger}
            hint="Identifies which TradingView alert this route is for. TradingView decides when that alert fires."
            options={[
            { value: 'supertrend', label: 'Supertrend' },
            { value: 'custom', label: 'Other TradingView alert' }]
            } />
          
          {draft.triggerType === 'custom' &&
          <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-subtle">Indicator or alert condition</span>
              <input value={draft.triggerName ?? ''} onChange={(e) => setDraft({ ...draft, triggerName: e.target.value })} placeholder="e.g. EMA 9/21 cross" className={inputCls} />
              {touched && triggerError && <span className="text-xs text-loss">{triggerError}</span>}
            </label>
          }
        </div>
        <fieldset className="space-y-2">
          <legend className="text-xs font-medium text-subtle">How to use this signal</legend>
          {(['trade', 'info'] as RouteUsage[]).map((u) =>
          <RadioCard key={u} name={`usage-${draft.id}`} value={u} checked={(draft.usage ?? 'trade') === u} onChange={(v) => setDraft({ ...draft, usage: v as RouteUsage })} label={USAGE_LABELS[u]} description={USAGE_DESCRIPTIONS[u]} />
          )}
        </fieldset>
        <Switch label="Route enabled" checked={draft.enabled} onChange={(v) => setDraft({ ...draft, enabled: v })} />
        <Switch label="Accept new entry signals" description="Turning this off never stops protective management." checked={draft.acceptEntries} onChange={(v) => setDraft({ ...draft, acceptEntries: v })} />
        <Switch label="Accept close signals" checked={draft.acceptCloses} onChange={(v) => setDraft({ ...draft, acceptCloses: v })} />
        <Switch label="Require completed-candle confirmation" checked={draft.requireConfirmed} onChange={(v) => setDraft({ ...draft, requireConfirmed: v })} />
        <div className="grid grid-cols-2 gap-3">
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-subtle">Max entry signal age (s)</span>
            <input inputMode="numeric" value={draft.maxSignalAgeSec} onChange={(e) => setDraft({ ...draft, maxSignalAgeSec: Number(e.target.value) })} className={`${inputCls} tabular-nums`} />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-subtle">Max close signal age (s)</span>
            <input inputMode="numeric" value={draft.closeMaxSignalAgeSec} onChange={(e) => setDraft({ ...draft, closeMaxSignalAgeSec: Number(e.target.value) })} className={`${inputCls} tabular-nums`} />
          </label>
        </div>
        {ageInvalid && <p className="text-xs text-loss">Signal ages must be greater than 0.</p>}
        <fieldset>
          <legend className="text-xs font-medium text-subtle">Allowed actions</legend>
          <div className="mt-1.5 flex flex-wrap gap-3">
            {ALL_ACTIONS.map((a) =>
            <label key={a} className="flex items-center gap-1.5 text-sm text-ink">
                <input type="checkbox" checked={draft.allowedActions.includes(a)} onChange={() => toggleAction(a)} className="h-4 w-4" />
                {ACTION_LABELS[a]}
              </label>
            )}
          </div>
          {actionsError && <p className="mt-1 text-xs text-loss">{actionsError}</p>}
        </fieldset>
        <p className="text-xs text-subtle">
          Source {draft.sourceExchange} · mapping {Object.entries(draft.symbolMap).map(([s, p]) => `${s}→${p}`).join(', ')}
        </p>
        <div className="flex gap-2">
          <Button variant="primary" onClick={save} disabled={!dirty || touched && invalid}>
            {isNew ? 'Save route' : 'Save'}
          </Button>
          <Button onClick={() => isNew ? onCancelNew() : setDraft({ ...saved, triggerType: routeTriggerType(saved), usage: routeUsage(saved), triggerName: saved.triggerName ?? '' })} disabled={!dirty}>
            Cancel
          </Button>
        </div>
      </section>
      <section className="space-y-2 self-start rounded-xl border border-line bg-surface p-4">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-sm font-semibold text-ink">Sample payload</h3>
          {!isNew && <CopyButton text={sample} label="Copy JSON" />}
        </div>
        {isNew ?
        <p className="text-xs text-muted">Save the route to generate its sample payload.</p> :

        <>
            <pre className="scrollbar-thin overflow-x-auto rounded-lg border border-line bg-inset p-3 font-mono text-xs text-ink">{sample}</pre>
            <p className="text-xs text-subtle">
              {routeTriggerName(saved)} · {saved.timeframe} · {USAGE_LABELS[routeUsage(saved)]}. Generated from the simulation clock. Contains no exchange keys or secrets.
            </p>
          </>
        }
      </section>
    </div>);

}