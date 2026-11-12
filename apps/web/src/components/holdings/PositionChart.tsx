'use client';

import React, { useEffect, useRef, useState } from 'react';
import {
  CandlestickSeries,
  createChart,
  LineSeries,
  LineStyle,
  type CandlestickData,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp
} from 'lightweight-charts';
import type { HoldingChartDto } from '@trendpilot/db';
import { request } from '@/lib/api';

/** Theme colours (tailwind.config.ts). */
const C = { text: '#94A3B8', grid: '#1E2A44', gain: '#22C55E', loss: '#F43F5E', entry: '#2DD4BF', stop: '#F43F5E', historical: '#94A3B8' };

/**
 * Chart for one position's exact exchange contract: TrendPilot's stored exchange candles
 * (TradingView Lightweight Charts, rendered locally — no position data is sent anywhere) with
 * labelled horizontal lines at the confirmed average entry and the current effective stop (the
 * last recorded stop, labelled historical, once closed). The newest bar follows the live price.
 */
export function PositionChart({ positionId, livePrice, liveAt }: { positionId: string; livePrice: string | null; liveAt: string | null }) {
  const box = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const lineRef = useRef<ISeriesApi<'Line'> | null>(null);
  const lastBar = useRef<CandlestickData<UTCTimestamp> | null>(null);
  const intervalSec = useRef(900);
  const [data, setData] = useState<HoldingChartDto | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void request<HoldingChartDto>('GET', `/v1/me/holdings/${positionId}/chart`).then((r) => {
      if (cancelled) return;
      if (r.ok) setData(r.data);
      else setError(r.message);
    });
    return () => {
      cancelled = true;
    };
  }, [positionId]);

  useEffect(() => {
    if (!data || !box.current) return;
    const chart = createChart(box.current, {
      autoSize: true,
      layout: { background: { color: 'transparent' }, textColor: C.text, attributionLogo: true },
      grid: { vertLines: { color: C.grid }, horzLines: { color: C.grid } },
      rightPriceScale: { borderColor: C.grid },
      timeScale: { borderColor: C.grid, timeVisible: true, secondsVisible: false }
    });
    chartRef.current = chart;
    intervalSec.current = Number(data.interval) * 60;
    let target: ISeriesApi<'Candlestick'> | ISeriesApi<'Line'>;
    if (data.candles.length) {
      const s = chart.addSeries(CandlestickSeries, { upColor: C.gain, downColor: C.loss, borderVisible: false, wickUpColor: C.gain, wickDownColor: C.loss });
      const bars = data.candles.map((c) => ({ time: c.time as UTCTimestamp, open: Number(c.open), high: Number(c.high), low: Number(c.low), close: Number(c.close) }));
      s.setData(bars);
      lastBar.current = bars[bars.length - 1] ?? null;
      candleRef.current = s;
      target = s;
    } else {
      const s = chart.addSeries(LineSeries, { color: C.text, lineWidth: 2 });
      s.setData(data.quoteLine.map((p) => ({ time: p.time as UTCTimestamp, value: Number(p.value) })));
      lineRef.current = s;
      target = s;
    }
    for (const l of data.lines) {
      target.createPriceLine({
        price: Number(l.price),
        color: l.kind === 'ENTRY' ? C.entry : l.historical ? C.historical : C.stop,
        lineWidth: 2,
        lineStyle: l.kind === 'ENTRY' ? LineStyle.Solid : LineStyle.Dashed,
        axisLabelVisible: true,
        title: `${l.label} ${l.price}`
      });
    }
    chart.timeScale().fitContent();
    return () => {
      chart.remove();
      chartRef.current = null;
      candleRef.current = null;
      lineRef.current = null;
      lastBar.current = null;
    };
  }, [data]);

  // The newest bar follows the live price (open positions only).
  useEffect(() => {
    if (!data || data.status !== 'OPEN' || !livePrice || !liveAt) return;
    const price = Number(livePrice);
    const t = Math.floor(Date.parse(liveAt) / 1000);
    if (candleRef.current) {
      const start = (Math.floor(t / intervalSec.current) * intervalSec.current) as UTCTimestamp;
      const prev = lastBar.current;
      if (prev && start < prev.time) return;
      const bar =
        prev && prev.time === start
          ? { ...prev, high: Math.max(prev.high, price), low: Math.min(prev.low, price), close: price }
          : { time: start, open: prev?.close ?? price, high: price, low: price, close: price };
      candleRef.current.update(bar);
      lastBar.current = bar;
    } else if (lineRef.current) {
      try {
        lineRef.current.update({ time: t as UTCTimestamp, value: price });
      } catch {
        /* an older point than the last one: ignore */
      }
    }
  }, [data, livePrice, liveAt]);

  return (
    <section className="rounded-xl border border-line bg-surface p-4" aria-label="Price chart" data-testid="position-chart">
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold text-ink">
          {data ? `${data.exchange} · ${data.exchangeSymbol} perpetual` : 'Price chart'}
          {data && <span className="ml-2 text-xs font-normal text-subtle">{data.candles.length ? `${data.interval}m candles` : 'recorded mark prices'}</span>}
        </h3>
        {data && (
          <p className="flex flex-wrap gap-3 text-xs text-muted" data-testid="chart-lines">
            {data.lines.map((l) => (
              <span key={l.kind} data-kind={l.kind} data-price={l.price} data-historical={l.historical ? 'true' : 'false'}>
                <span className="mr-1 inline-block h-0.5 w-4 align-middle" style={{ background: l.kind === 'ENTRY' ? C.entry : l.historical ? C.historical : C.stop }} />
                {l.label} {l.price}
              </span>
            ))}
          </p>
        )}
      </div>
      {error ? (
        <p className="text-sm text-loss">{error}</p>
      ) : (
        <div ref={box} className="h-[340px] w-full" />
      )}
      {data && !data.candles.length && !data.quoteLine.length && <p className="mt-2 text-xs text-subtle">No stored candles or prices for this contract yet.</p>}
      <p className="mt-2 text-xs text-subtle">Candles and prices come from TrendPilot&apos;s market feed for this exact contract. Charting: TradingView Lightweight Charts™.</p>
    </section>
  );
}
