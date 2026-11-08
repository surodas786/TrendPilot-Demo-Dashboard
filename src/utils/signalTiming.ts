import type { CentralSignal, Delivery } from '../types/signals';

export interface Stage {
  id: string;
  label: string;
  at: number | null;
}

export function signalStages(c: CentralSignal, d?: Delivery): Stage[] {
  return [
  { id: 'candle', label: 'Candle close', at: c.candleCloseAt },
  { id: 'created', label: 'Signal creation', at: c.createdAt },
  { id: 'receipt', label: 'Gateway receipt', at: c.receivedAt },
  { id: 'validated', label: 'Validation completion', at: c.validatedAt },
  { id: 'evaluated', label: 'Account evaluation', at: d?.evaluatedAt ?? null },
  { id: 'submitted', label: 'Order submission', at: d?.submittedAt ?? null },
  { id: 'ack', label: 'Acknowledgement', at: d?.ackAt ?? null },
  { id: 'first', label: 'First fill', at: d?.firstFillAt ?? null },
  { id: 'final', label: 'Final fill', at: d?.finalFillAt ?? null }];

}

export interface Latency {
  /** Candle close → signal creation (strategy/alert side). */
  creationDelayMs: number;
  /** Signal creation → gateway receipt (transport). */
  transportMs: number;
  /** Candle close → gateway receipt. Excluded from platform latency. */
  upstreamMs: number;
  /** Gateway receipt → last recorded platform stage. Excludes candle duration and upstream delay. */
  platformMs: number | null;
  platformEndLabel: string | null;
}

export function signalLatency(c: CentralSignal, d?: Delivery): Latency {
  const end = d?.finalFillAt ?? d?.firstFillAt ?? d?.ackAt ?? d?.evaluatedAt ?? c.validatedAt;
  const label = d?.finalFillAt ? 'final fill' : d?.firstFillAt ? 'first fill' : d?.ackAt ? 'acknowledgement' : d?.evaluatedAt ? 'account evaluation' : 'validation';
  return {
    creationDelayMs: c.createdAt - c.candleCloseAt,
    transportMs: c.receivedAt - c.createdAt,
    upstreamMs: c.receivedAt - c.candleCloseAt,
    platformMs: Number.isFinite(end) ? end - c.receivedAt : null,
    platformEndLabel: label
  };
}

export function formatMs(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return '—';
  if (Math.abs(ms) < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

export function deliveryCounts(c: CentralSignal) {
  const by = (states: Delivery['state'][]) => c.deliveries.filter((d) => states.includes(d.state)).length;
  return {
    eligible: c.deliveries.length,
    submitted: c.deliveries.filter((d) => d.submittedAt !== undefined).length,
    executed: by(['executed']),
    partial: by(['partially-filled']),
    skipped: by(['skipped', 'rejected']),
    failed: by(['failed', 'unknown'])
  };
}