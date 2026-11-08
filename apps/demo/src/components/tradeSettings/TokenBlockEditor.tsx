import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { LockIcon, RotateCcwIcon } from 'lucide-react';
import { toast } from 'sonner';
import { useTokenBlockForm } from '../../hooks/useTokenBlockForm';
import { leverageChoices, LEVERAGE_NOTE } from '../../data/leverageChoices';
import { DIRECTION_LABELS, OPPOSITE_LABELS, timeframeShort, trendFilterShort } from '../../utils/platformText';
import { BOTH_MODES_NOTE, formatUsdt } from '../../utils/tokenBlocks';
import { PERCENT_NOTE } from '../platform/PairDefaultsFields';
import { Button } from '../ui/Button';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { FilterSelect } from '../ui/FilterSelect';
import { SegmentedControl } from '../ui/SegmentedControl';
import { Switch } from '../ui/Switch';
import { TextField } from '../ui/TextField';
import { ChipCheckboxGroup } from '../ui/ChipCheckboxGroup';
import { DAY_LABELS, TRADING_DAYS_HELP } from '../../utils/tradingDays';
import { TakeProfitEditor } from './TakeProfitEditor';
import { MultipleEntriesSection } from './MultipleEntriesSection';
import type { MarginMode, TokenBlock, TradingMode } from '../../types/tradeSettings';

const pct = <span className="pr-2 text-xs text-subtle">%</span>;

function Section({ title, children }: {title: string;children: React.ReactNode;}) {
  return (
    <section className="space-y-4 border-b border-line pb-5 last:border-b-0">
      <h3 className="text-sm font-semibold text-ink">{title}</h3>
      {children}
    </section>);

}

export function TokenBlockEditor({ existing, onDone }: {existing?: TokenBlock;onDone: () => void;}) {
  const f = useTokenBlockForm(existing);
  const { draft, errors, touched } = f;
  const [confirmRestore, setConfirmRestore] = useState(false);
  const cost = Number(draft.orderCost);
  const value = cost > 0 && draft.leverage ? cost * draft.leverage : null;

  const submit = (activate: boolean) => {
    const saved = f.save(activate);
    if (!saved) return;
    toast.success(activate ? 'Saved & activated — waiting for signal' : 'Token settings saved', { description: activate ? 'No position opens until a matching signal arrives.' : saved.active ? 'Still active.' : 'Block is paused until you activate it.' });
    onDone();
  };

  return (
    <div className="flex h-full flex-col">
      <div className="scrollbar-thin flex-1 space-y-5 overflow-y-auto px-5 py-4">
        <Section title="Token and strategy">
          {f.locked &&
          <p className="flex items-start gap-2 text-xs text-muted">
              <LockIcon className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
              Pair, mode and account are locked while this block has open positions. Other changes apply to future entries only.
            </p>
          }
          <FilterSelect label="Trading pair" value={draft.symbol} onChange={f.changePair} options={f.pairOptions} disabled={f.locked} />
          {touched && errors.symbol && <p className="-mt-2 text-xs text-loss">{errors.symbol}</p>}
          <FilterSelect label="Strategy package" value={draft.packageId} onChange={(v) => f.update({ packageId: v })} options={f.packageOptions} />
          {touched && errors.packageId && <p className="-mt-2 text-xs text-loss">{errors.packageId}</p>}
          {f.pkg &&
          <p className="rounded-lg bg-inset px-3 py-2 text-xs text-muted">
              <span className="text-ink">{DIRECTION_LABELS[f.pkg.direction]}</span> · {timeframeShort(f.pkg.timeframe)} · {trendFilterShort(f.pkg.trendFilter)} · Opposite signal: {OPPOSITE_LABELS[f.pkg.opposite]}. Packages are managed by the administrator.
            </p>
          }
          <SegmentedControl<TradingMode>
            label="Trading mode"
            value={draft.mode}
            onChange={(v) => !f.locked && f.update({ mode: v })}
            options={[
            { value: 'paper', label: 'Paper' },
            { value: 'live', label: 'Live — simulated' }]
            } />
          
          <p className="text-xs text-muted">Trades with My Account ({draft.mode === 'live' ? 'Live — simulated' : 'Paper'}).</p>
          <ChipCheckboxGroup
            label={
            <span className="flex flex-wrap items-baseline gap-x-2">
                Trading days <span className="text-xs font-normal text-subtle">Timezone: {f.timezone}</span>
              </span>
            }
            description={TRADING_DAYS_HELP}
            options={DAY_LABELS.map((d, i) => ({ value: String(i), label: d }))}
            value={draft.tradingDays.map(String)}
            onChange={(v) => f.update({ tradingDays: v.map(Number) })}
            error={errors.tradingDays} />
          
          {draft.mode === 'live' &&
          <p className="text-xs text-muted">
              {f.connection ?
            <>
                  Uses <span className="text-ink">{f.connection.name}</span> ({f.connection.status === 'connected' ? 'Connected — simulated' : 'Disconnected — activation blocked'}).{' '}
                </> :

            'No exchange connection yet — you can save, but activation is blocked. '
            }
              <Link to="/exchange-connections" className="font-semibold text-accent hover:underline">
                Exchange Connections
              </Link>
            </p>
          }
          <p className="text-xs text-subtle">{BOTH_MODES_NOTE}</p>
        </Section>

        <Section title="Order size">
          <TextField label="Order cost (USDT)" inputMode="decimal" value={draft.orderCost} onChange={(v) => f.update({ orderCost: v })} hint="The margin allocated to each new entry, before fees." error={touched ? errors.orderCost : undefined} />
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <FilterSelect
                label="Leverage"
                value={draft.leverage ? String(draft.leverage) : ''}
                onChange={(v) => f.update({ leverage: Number(v) })}
                options={[...(draft.leverage ? [] : [{ value: '', label: 'Select leverage' }]), ...leverageChoices(draft.symbol).map((l) => ({ value: String(l), label: `${l}×` }))]} />
              
              {errors.leverage && (touched || draft.leverage === null) && <p className="mt-1 text-xs text-loss">{errors.leverage}</p>}
            </div>
            <SegmentedControl<MarginMode>
              label="Margin mode"
              value={draft.marginMode}
              onChange={(v) => f.update({ marginMode: v })}
              options={[
              { value: 'isolated', label: 'Isolated' },
              { value: 'cross', label: 'Cross' }]
              } />
            
          </div>
          <p className="text-xs text-subtle">{LEVERAGE_NOTE}</p>
          <dl className="grid grid-cols-3 gap-2 rounded-lg bg-inset px-3 py-2.5 text-xs tabular-nums">
            <div>
              <dt className="text-subtle">Margin per entry</dt>
              <dd className="mt-0.5 text-sm text-ink">{cost > 0 ? formatUsdt(cost) : '—'}</dd>
            </div>
            <div>
              <dt className="text-subtle">Leverage</dt>
              <dd className="mt-0.5 text-sm text-ink">{draft.leverage ? `${draft.leverage}×` : '—'}</dd>
            </div>
            <div>
              <dt className="text-subtle">Est. position value</dt>
              <dd className="mt-0.5 text-sm font-semibold text-ink">{value ? formatUsdt(value) : '—'}</dd>
            </div>
          </dl>
        </Section>

        <Section title="Exits">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs text-subtle">{PERCENT_NOTE}</p>
            <Button size="sm" variant="ghost" icon={RotateCcwIcon} onClick={() => setConfirmRestore(true)} disabled={!f.pair}>
              Restore Admin Defaults
            </Button>
          </div>
          <TextField label="Stop loss" inputMode="decimal" value={draft.stopLossPct} onChange={(v) => f.updateExits({ stopLossPct: v })} hint="Applied against the position: below entry for longs, above entry for shorts." error={touched ? errors.stopLossPct : undefined} trailing={pct} />
          <TakeProfitEditor draft={draft} errors={errors} showErrors={touched} onChange={f.updateExits} />
          <Switch label="Trailing stop" description="Follows the best price since entry — highest for longs, lowest for shorts — and never moves backward." checked={draft.trailingEnabled} onChange={(v) => f.updateExits({ trailingEnabled: v })} />
          {draft.trailingEnabled && <TextField label="Trailing distance" inputMode="decimal" value={draft.trailingPct} onChange={(v) => f.updateExits({ trailingPct: v })} error={touched ? errors.trailingPct : undefined} trailing={pct} />}
        </Section>

        <MultipleEntriesSection draft={draft} pkg={f.pkg} errors={errors} showErrors={touched} onChange={f.update} />
      </div>

      <footer className="space-y-2 border-t border-line px-5 py-4">
        {f.blocker && <p className="text-xs text-warn">Activation unavailable: {f.blocker}</p>}
        {touched && f.invalid && <p className="text-xs text-loss">Fix the highlighted fields before saving.</p>}
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button onClick={onDone}>Cancel</Button>
          <Button onClick={() => submit(false)}>Save</Button>
          <Button variant="primary" onClick={() => submit(true)} disabled={Boolean(f.blocker)}>
            Save &amp; Activate
          </Button>
        </div>
      </footer>

      <ConfirmDialog
        open={confirmRestore}
        title="Restore admin defaults?"
        description={`Replace this draft's stop loss, take profit and trailing stop with the administrator's current ${draft.symbol} defaults. Nothing is saved until you press Save.`}
        confirmLabel="Restore defaults"
        onConfirm={() => {
          f.restoreDefaults();
          setConfirmRestore(false);
        }}
        onCancel={() => setConfirmRestore(false)} />
      
    </div>);

}