import React, { useMemo, useState } from 'react';
import { formatClockShort } from '../../../utils/clock';
import { formatNumber } from '../../../utils/format';
import { SegmentedControl } from '../../ui/SegmentedControl';

export interface ChartLevel {
  label: string;
  price: number;
  tone: 'accent' | 'loss' | 'gain' | 'warn' | 'muted';
}

export interface ChartFill {
  at: number;
  price: number;
  label: string;
}

interface Props {
  seed: string;
  startMs: number;
  endMs: number;
  startPrice: number;
  endPrice: number;
  priceDecimals: number;
  levels: ChartLevel[];
  fills: ChartFill[];
}

type Timeframe = '5m' | '15m' | '1H';
const BASE_MS = 5 * 60 * 1000;
const AGG: Record<Timeframe, number> = { '5m': 1, '15m': 3, '1H': 12 };
const TONES: Record<ChartLevel['tone'], string> = { accent: '#2DD4BF', loss: '#F87171', gain: '#4ADE80', warn: '#FBBF24', muted: '#94A3B8' };

interface Candle {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
}

function rng(seedText: string) {
  let h = 2166136261;
  for (let i = 0; i < seedText.length; i++) h = Math.imul(h ^ seedText.charCodeAt(i), 16777619);
  return () => {
    h = Math.imul(h ^ h >>> 15, 2246822507);
    h = Math.imul(h ^ h >>> 13, 3266489909);
    return ((h ^= h >>> 16) >>> 0) / 4294967296;
  };
}

/** Deterministic fictional 5-minute candles from entry towards the latest simulated price. */
function baseCandles(seed: string, startMs: number, endMs: number, from: number, to: number): Candle[] {
  const n = Math.max(12, Math.floor((endMs - startMs) / BASE_MS));
  const rand = rng(seed);
  const amp = Math.abs(from) * 0.0035;
  const out: Candle[] = [];
  let prev = from;
  let drift = 0;
  for (let i = 1; i <= n; i++) {
    const line = from + (to - from) * i / n;
    drift = drift * 0.75 + (rand() - 0.5) * amp;
    const c = i === n ? to : line + drift;
    const o = prev;
    const wick = amp * 0.4;
    out.push({ t: startMs + (i - 1) * BASE_MS, o, c, h: Math.max(o, c) + rand() * wick, l: Math.min(o, c) - rand() * wick });
    prev = c;
  }
  return out;
}

export function SimulatedCandleChart({ seed, startMs, endMs, startPrice, endPrice, priceDecimals, levels, fills }: Props) {
  const [tf, setTf] = useState<Timeframe>('15m');
  const base = useMemo(() => baseCandles(seed, startMs, endMs, startPrice, endPrice), [seed, startMs, endMs, startPrice, endPrice]);
  const candles = useMemo(() => {
    const k = AGG[tf];
    const out: Candle[] = [];
    for (let i = 0; i < base.length; i += k) {
      const g = base.slice(i, i + k);
      out.push({ t: g[0].t, o: g[0].o, c: g[g.length - 1].c, h: Math.max(...g.map((x) => x.h)), l: Math.min(...g.map((x) => x.l)) });
    }
    return out;
  }, [base, tf]);

  const W = 720;
  const H = 280;
  const pad = { l: 8, r: 78, t: 12, b: 26 };
  const values = [...candles.flatMap((c) => [c.h, c.l]), ...levels.map((l) => l.price), ...fills.map((f) => f.price)];
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const y = (v: number) => pad.t + (max + span * 0.04 - v) / (span * 1.08) * (H - pad.t - pad.b);
  const plotW = W - pad.l - pad.r;
  const step = plotW / candles.length;
  const tEnd = candles[candles.length - 1].t + BASE_MS * AGG[tf];
  const x = (t: number) => pad.l + (t - candles[0].t) / (tEnd - candles[0].t) * plotW;
  const ticks = [0, Math.floor(candles.length / 2), candles.length - 1];

  return (
    <figure className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <figcaption className="text-xs font-semibold text-muted">Simulated execution-market chart · not a live TradingView chart</figcaption>
        <SegmentedControl<Timeframe>
          label="Candle timeframe"
          hideLabel
          value={tf}
          onChange={setTf}
          options={[
          { value: '5m', label: '5m' },
          { value: '15m', label: '15m' },
          { value: '1H', label: '1H' }]
          } />
        
      </div>
      <div className="rounded-lg border border-line bg-inset p-2">
        <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label={`Fictional ${tf} candles with recorded levels`}>
          {candles.map((c) => {
            const cx = x(c.t) + step / 2;
            const up = c.c >= c.o;
            const color = up ? '#4ADE80' : '#F87171';
            const bw = Math.max(1.5, step * 0.6);
            return (
              <g key={c.t}>
                <line x1={cx} x2={cx} y1={y(c.h)} y2={y(c.l)} stroke={color} strokeWidth={1} opacity={0.8} />
                <rect x={cx - bw / 2} width={bw} y={Math.min(y(c.o), y(c.c))} height={Math.max(1, Math.abs(y(c.o) - y(c.c)))} fill={color} opacity={0.85} />
              </g>);

          })}
          {levels.map((l) =>
          <g key={l.label}>
              <line x1={pad.l} x2={W - pad.r} y1={y(l.price)} y2={y(l.price)} stroke={TONES[l.tone]} strokeDasharray="5 4" strokeWidth={1.2} />
              <text x={W - pad.r + 4} y={y(l.price) + 3} fontSize={10} fill={TONES[l.tone]}>
                {l.label} {formatNumber(l.price, priceDecimals)}
              </text>
            </g>
          )}
          {fills.map((f) =>
          <g key={`${f.label}-${f.at}`}>
              <circle cx={Math.min(W - pad.r, Math.max(pad.l, x(f.at)))} cy={y(f.price)} r={4.5} fill="#0B1220" stroke="#E2E8F0" strokeWidth={1.5} />
              <title>{`${f.label} · ${formatNumber(f.price, priceDecimals)} · ${formatClockShort(f.at)}`}</title>
            </g>
          )}
          {ticks.map((i) =>
          <text key={i} x={x(candles[i].t) + step / 2} y={H - 8} fontSize={10} fill="#94A3B8" textAnchor="middle">
              {formatClockShort(candles[i].t)}
            </text>
          )}
        </svg>
      </div>
      <p className="text-xs text-subtle">
        Fictional price data. Levels and fill markers appear only where simulated records exist. Circles mark recorded fills.
      </p>
    </figure>);

}