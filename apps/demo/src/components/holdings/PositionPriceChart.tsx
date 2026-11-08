import React from 'react';
import { formatPrice } from '../../utils/platformText';
import type { HoldingPosition, PricePoint } from '../../types/holdings';

interface Level {
  label: string;
  price: number;
  color: string;
  dash?: string;
}

const W = 440;
const H = 200;
const PAD = { l: 8, r: 92, t: 10, b: 10 };

/** Local chart from the recorded simulated price history — the same prices that drive P&L and exits. */
export function PositionPriceChart({ position, history, current }: {position: HoldingPosition;history: PricePoint[];current?: number;}) {
  const pts = history.filter((p) => p.t >= position.openedAt - 60_000).slice(-120);
  const series = pts.length >= 1 ? pts : [{ t: position.openedAt, price: position.entryPrice }];
  const levels: Level[] = [
  { label: 'Entry', price: position.entryPrice, color: '#94A3B8' },
  ...(position.status === 'open' ? [{ label: 'Stop', price: position.stopPrice, color: '#F87171', dash: '4 3' }] : []),
  ...position.targets.map((t, i) => t.state === 'open' ? { label: `TP${i + 1}`, price: t.price, color: '#34D399', dash: '4 3' } : null).filter((l): l is Level => l !== null),
  ...(position.status === 'open' && position.trailingStop !== null ? [{ label: 'Trail', price: position.trailingStop, color: '#FBBF24', dash: '2 3' }] : [])];

  const all = [...series.map((p) => p.price), ...levels.map((l) => l.price), ...(current ? [current] : [])];
  const min = Math.min(...all);
  const max = Math.max(...all);
  const span = max - min || max * 0.01 || 1;
  const y = (v: number) => PAD.t + (1 - (v - min) / span) * (H - PAD.t - PAD.b);
  const x = (i: number) => PAD.l + (series.length === 1 ? (W - PAD.l - PAD.r) / 2 : i / (series.length - 1) * (W - PAD.l - PAD.r));
  const path = series.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(p.price).toFixed(1)}`).join(' ');

  return (
    <figure className="space-y-2">
      <figcaption className="flex items-baseline justify-between gap-2">
        <span className="text-sm font-semibold text-ink">Simulated price chart</span>
        <span className="text-xs text-subtle">{series.length} recorded update{series.length === 1 ? '' : 's'}</span>
      </figcaption>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full rounded-lg border border-line bg-inset" role="img" aria-label={`Simulated ${position.symbol} price with entry, stop and target levels`}>
        {levels.map((l) =>
        <g key={l.label}>
            <line x1={PAD.l} x2={W - PAD.r} y1={y(l.price)} y2={y(l.price)} stroke={l.color} strokeWidth={1} strokeDasharray={l.dash} opacity={0.85} />
            <text x={W - PAD.r + 6} y={y(l.price) + 3.5} fontSize={10} fill={l.color}>
              {l.label} {formatPrice(l.price)}
            </text>
          </g>
        )}
        <path d={path} fill="none" stroke="#2DD4BF" strokeWidth={1.75} />
        {series.length === 1 && <circle cx={x(0)} cy={y(series[0].price)} r={3} fill="#2DD4BF" />}
        {current && <circle cx={x(series.length - 1)} cy={y(current)} r={3.5} fill="#2DD4BF" stroke="#0B1220" strokeWidth={1.5} />}
      </svg>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs tabular-nums sm:grid-cols-3">
        {current &&
        <div className="flex justify-between gap-2">
            <dt className="text-subtle">Current</dt>
            <dd className="text-ink">{formatPrice(current)}</dd>
          </div>
        }
        {levels.map((l) =>
        <div key={l.label} className="flex justify-between gap-2">
            <dt className="text-subtle">{l.label}</dt>
            <dd className="text-ink">{formatPrice(l.price)}</dd>
          </div>
        )}
      </dl>
    </figure>);

}