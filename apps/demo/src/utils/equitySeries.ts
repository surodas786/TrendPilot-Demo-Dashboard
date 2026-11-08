import { format, parseISO, subDays } from 'date-fns';
import type { ChartPoint, EquityPeriod } from '../types/trading';

const SERIES_LENGTHS: Record<EquityPeriod, number> = { today: 15, '7d': 7, '30d': 30 };

/** Flat series for accounts without history (e.g. newly created paper connections). */
export function fallbackSeries(period: EquityPeriod, value: number): number[] {
  return Array.from({ length: SERIES_LENGTHS[period] }, () => value);
}

export function buildEquityPoints(
series: number[],
period: EquityPeriod,
liveEquity: number,
reportingDate: string,
nowShort: string)
: ChartPoint[] {
  const date = parseISO(reportingDate);
  const values = series.map((v, i) => i === series.length - 1 ? liveEquity : v);

  if (period === 'today') {
    return values.map((equity, i) => {
      const last = i === values.length - 1;
      const hour = `${String(i).padStart(2, '0')}:00`;
      return {
        label: last ? 'Now' : hour,
        fullLabel: `${format(date, 'MMM d')} · ${last ? `${nowShort} (now)` : hour}`,
        equity
      };
    });
  }

  const n = values.length;
  return values.map((equity, i) => {
    const day = subDays(date, n - 1 - i);
    const last = i === n - 1;
    return {
      label: format(day, 'MMM d'),
      fullLabel: `${format(day, 'EEE, MMM d')} · ${last ? 'now' : 'daily close'}`,
      equity
    };
  });
}

export function periodRangeLabel(
period: EquityPeriod,
points: number,
reportingDate: string,
nowShort: string)
: string {
  const date = parseISO(reportingDate);
  if (period === 'today') {
    return `${format(date, 'EEE, MMM d, yyyy')} · 00:00 – ${nowShort}`;
  }
  const start = subDays(date, points - 1);
  return `${format(start, 'MMM d')} – ${format(date, 'MMM d, yyyy')} · daily closes`;
}

export function reportingDateOptions(reportingDate: string, days = 7): {value: string;label: string;}[] {
  const date = parseISO(reportingDate);
  return Array.from({ length: days }, (_, i) => {
    const d = subDays(date, i);
    return {
      value: format(d, 'yyyy-MM-dd'),
      label: i === 0 ? `Today · ${format(d, 'MMM d, yyyy')}` : format(d, 'EEE, MMM d, yyyy')
    };
  });
}