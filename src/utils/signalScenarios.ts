import { defaultSignalInput } from './signalPayload';
import type { SignalInput, SignalRoute, SignalScenarioId } from '../types/signals';

/** Deterministic signal inputs for a scenario, timed from the simulation clock. */
export function scenarioInputs(id: SignalScenarioId, route: SignalRoute, prices: Record<string, number>, now: number): {pre?: SignalInput;prefill: SignalInput;} {
  const make = (pair: string, action: SignalInput['action'], back = 0) => defaultSignalInput(route, pair, action, prices[pair], now, back);
  switch (id) {
    case 'two-users':
    case 'paused-sub':
      return { prefill: make('BTCUSDT', 'open-long') };
    case 'margin':
      return { prefill: make('ETHUSDT', 'open-long') };
    case 'duplicate':{
        const pre = make('SOLUSDT', 'open-long');
        return { pre, prefill: { ...pre, receivedAt: pre.receivedAt + 1500 } };
      }
    case 'expired':{
        const s = make('BTCUSDT', 'open-long', 1);
        return { prefill: { ...s, createdAt: s.candleCloseAt + 2000, receivedAt: s.candleCloseAt + 95000 } };
      }
    case 'out-of-order':
      return { pre: make('ETHUSDT', 'open-long'), prefill: make('ETHUSDT', 'close-long', 1) };
    case 'existing-position':
      return { pre: make('BTCUSDT', 'open-long', 1), prefill: make('BTCUSDT', 'open-long') };
    case 'unknown':
      return { prefill: make('SOLUSDT', 'open-long') };
    case 'partial':
      return { prefill: make('ETHUSDT', 'open-long') };
    case 'protection-fail':
      return { prefill: make('BTCUSDT', 'open-short') };
    default:
      return { prefill: make('BTCUSDT', 'open-long') };
  }
}