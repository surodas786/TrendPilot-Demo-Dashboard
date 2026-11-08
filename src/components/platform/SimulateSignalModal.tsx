import React, { useState } from 'react';
import { SendIcon } from 'lucide-react';
import { toast } from 'sonner';
import { usePlatform } from '../../contexts/PlatformContext';
import { useDemo } from '../../contexts/DemoContext';
import { pairLabel } from '../../data/platformSeed';
import { routeTriggerName, routeUsage, USAGE_LABELS } from '../../data/signalRoutes';
import { buildAlert, TIMEFRAMES } from '../../utils/platformText';
import { simNow } from '../../utils/clock';
import { Button } from '../ui/Button';
import { FilterSelect } from '../ui/FilterSelect';
import { Modal } from '../ui/Modal';
import { ModalHeader } from '../ui/ModalHeader';
import { SegmentedControl } from '../ui/SegmentedControl';
import { TextField } from '../ui/TextField';
import type { SignalSide, SignalTimeframe } from '../../types/platform';

const UNKNOWN = 'ZZZUSDT';

export function SimulateSignalModal({ open, onClose }: {open: boolean;onClose: () => void;}) {
  return (
    <Modal open={open} onClose={onClose} labelledBy="sim-signal-title">
      <SimulateBody onClose={onClose} />
    </Modal>);

}

const num = (v: string) => v.trim() === '' ? undefined : Number(v);

function SimulateBody({ onClose }: {onClose: () => void;}) {
  const { platform, receiveSignal } = usePlatform();
  const { state } = useDemo();
  const enabled = platform.pairs.filter((p) => p.enabled);
  const disabled = platform.pairs.filter((p) => !p.enabled);
  const [routeId, setRouteId] = useState(state.routes[0]?.id ?? '');
  const route = state.routes.find((r) => r.id === routeId);
  const [symbol, setSymbol] = useState(enabled[0]?.symbol ?? '');
  const [side, setSide] = useState<SignalSide>('LONG');
  const [timeframe, setTimeframe] = useState<SignalTimeframe>(route?.timeframe as SignalTimeframe ?? '15m');
  const [testRejection, setTestRejection] = useState(false);
  const [testSymbol, setTestSymbol] = useState(disabled[0]?.symbol ?? UNKNOWN);
  const [close, setClose] = useState('');
  const [ema, setEma] = useState('');

  const target = testRejection ? testSymbol : symbol;
  const emaInvalid = [close, ema].some((v) => v.trim() !== '' && !(Number(v) > 0));
  const send = () => {
    if (!target || emaInvalid) return;
    receiveSignal(buildAlert(target, side, simNow(), timeframe, { route_id: routeId || undefined, candle_close: num(close), ema200: num(ema) }));
    toast.success('Demo signal sent', { description: 'See the result in Recent signals and the Central Signal Feed.' });
    onClose();
  };

  return (
    <>
      <ModalHeader id="sim-signal-title" title="Simulate Signal" description="Sends a demo message to the common webhook inside this browser. No external request is made." onClose={onClose} />
      <div className="space-y-4 px-5 py-5 sm:px-6">
        <FilterSelect
          label="Signal route"
          value={routeId}
          onChange={(id) => {
            setRouteId(id);
            const r = state.routes.find((x) => x.id === id);
            if (r) setTimeframe(r.timeframe as SignalTimeframe);
          }}
          options={state.routes.map((r) => ({ value: r.id, label: `${r.label} · ${r.timeframe}` }))} />
        
        {route &&
        <p className="-mt-2 text-xs text-muted">
            {routeTriggerName(route)} · {route.timeframe} · {USAGE_LABELS[routeUsage(route)]}
          </p>
        }
        {testRejection ?
        <FilterSelect
          label="Unsupported symbol (rejection test)"
          value={testSymbol}
          onChange={setTestSymbol}
          options={[...disabled.map((p) => ({ value: p.symbol, label: `${pairLabel(p)} — disabled` })), { value: UNKNOWN, label: 'ZZZ/USDT — not configured' }]} /> :

        enabled.length === 0 ?
        <p className="text-sm text-muted">No pairs are enabled. Enable one in Trading Pairs & Defaults, or test a rejection below.</p> :

        <FilterSelect label="Trading pair" value={symbol} onChange={setSymbol} options={enabled.map((p) => ({ value: p.symbol, label: pairLabel(p) }))} />
        }
        <SegmentedControl<SignalSide>
          label="Action"
          value={side}
          onChange={setSide}
          options={[
          { value: 'LONG', label: 'LONG' },
          { value: 'SHORT', label: 'SHORT' }]
          } />
        
        <SegmentedControl<SignalTimeframe>
          label="Interval sent"
          value={timeframe}
          onChange={setTimeframe}
          hint="Defaults to the route’s timeframe. Choose the other one to test a mismatch."
          options={TIMEFRAMES.map((tf) => ({ value: tf, label: tf }))} />
        
        <div className="grid gap-3 sm:grid-cols-2">
          <TextField label="Simulated candle close" inputMode="decimal" value={close} onChange={setClose} hint="Optional" />
          <TextField label="Simulated EMA 200" inputMode="decimal" value={ema} onChange={setEma} hint="Optional" error={emaInvalid ? 'Enter positive numbers or leave blank.' : undefined} />
        </div>
        <p className="-mt-2 text-xs text-subtle">Used only by packages with the EMA 200 trend filter. Blank values block those entries. In production these come from MEXC Futures candle history.</p>
        <label className="flex items-center gap-2 text-sm text-muted">
          <input type="checkbox" checked={testRejection} onChange={(e) => setTestRejection(e.target.checked)} className="h-4 w-4 accent-[#2DD4BF]" />
          Test with a disabled or unknown pair
        </label>
      </div>
      <footer className="flex flex-col-reverse gap-2 border-t border-line px-5 py-4 sm:flex-row sm:justify-end sm:px-6">
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" icon={SendIcon} onClick={send} disabled={!target || emaInvalid}>
          Send Demo Signal
        </Button>
      </footer>
    </>);

}