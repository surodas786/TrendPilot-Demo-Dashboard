import React from 'react';
import { Area, AreaChart, CartesianGrid, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { TooltipProps } from 'recharts';
import { formatNumber } from '../../utils/format';
import type { ChartPoint } from '../../types/trading';

interface EquityChartProps {
  points: ChartPoint[];
  referenceValue?: number;
}

export function EquityChart({ points, referenceValue }: EquityChartProps) {
  const values = points.map((p) => p.equity);
  const min = Math.min(...values, referenceValue ?? Infinity);
  const max = Math.max(...values, referenceValue ?? -Infinity);
  const pad = Math.max((max - min) * 0.15, 5);

  return (
    <ResponsiveContainer width="100%" height="100%">
      <AreaChart data={points} margin={{ top: 8, right: 4, bottom: 0, left: 0 }}>
        <CartesianGrid stroke="#1E2A44" vertical={false} />
        <XAxis
          dataKey="label"
          tick={{ fill: '#8291A8', fontSize: 11 }}
          axisLine={false}
          tickLine={false}
          interval="preserveStartEnd"
          minTickGap={28} />
        
        <YAxis
          orientation="right"
          domain={[Math.floor(min - pad), Math.ceil(max + pad)]}
          tick={{ fill: '#8291A8', fontSize: 11 }}
          tickFormatter={(v: number) => formatNumber(v, 0)}
          axisLine={false}
          tickLine={false}
          width={56} />
        
        {referenceValue !== undefined &&
        <ReferenceLine
          y={referenceValue}
          stroke="#2A3A5C"
          strokeDasharray="4 4"
          label={{ value: 'Opening', position: 'insideTopLeft', fill: '#8291A8', fontSize: 11 }} />

        }
        <Tooltip content={<ChartTooltip />} cursor={{ stroke: '#2A3A5C' }} />
        <Area
          type="monotone"
          dataKey="equity"
          stroke="#2DD4BF"
          strokeWidth={2}
          fill="#2DD4BF"
          fillOpacity={0.08}
          animationDuration={280}
          activeDot={{ r: 4, fill: '#2DD4BF', stroke: '#111A2E', strokeWidth: 2 }} />
        
      </AreaChart>
    </ResponsiveContainer>);

}

function ChartTooltip({ active, payload }: TooltipProps<number, string>) {
  if (!active || !payload || payload.length === 0) return null;
  const point = payload[0].payload as ChartPoint;
  return (
    <div className="rounded-lg border border-line-strong bg-raised px-3 py-2 shadow-xl shadow-black/40">
      <p className="text-xs text-subtle">{point.fullLabel}</p>
      <p className="mt-0.5 text-sm font-semibold tabular-nums text-ink">{formatNumber(point.equity)} USDT</p>
      <p className="text-[11px] text-subtle">Simulated</p>
    </div>);

}