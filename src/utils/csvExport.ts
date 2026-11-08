import { formatDateTime, simNow } from './clock';
import { downloadCsv } from './tradeCsv';

export type CsvCell = string | number | null | undefined;

/**
 * Escapes a cell. Text that a spreadsheet would treat as a formula (= + - @ tab CR)
 * is prefixed with an apostrophe; plain numbers are left as numbers.
 */
export function csvCell(v: CsvCell): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : '';
  let s = v;
  if (/^[=+\-@\t\r]/.test(s) && !/^[-+]?\d+(\.\d+)?$/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export interface CsvMeta {
  report: string;
  timezone: string;
  filters: string[];
  completeness: string;
  scope: string;
}

/** Separate [metadata] and [data] sections so data rows stay parseable. */
export function buildCsv(meta: CsvMeta, columns: string[], rows: CsvCell[][]): string {
  const metaRows: CsvCell[][] = [
  ['Report', `${meta.report} — TrendPilot demo, simulated paper data`],
  ['Scope', meta.scope],
  ['Reporting timezone', meta.timezone],
  ['Currency', 'USDT'],
  ['Filters', meta.filters.join('; ') || 'none'],
  ['Generated', `${formatDateTime(simNow())} (simulation clock)`],
  ['Data completeness', meta.completeness],
  ['Rows', rows.length]];

  return [
  '[metadata]',
  'Key,Value',
  ...metaRows.map((r) => r.map(csvCell).join(',')),
  '',
  '[data]',
  columns.map(csvCell).join(','),
  ...rows.map((r) => r.map(csvCell).join(','))].
  join('\n');
}

export function exportCsv(filename: string, meta: CsvMeta, columns: string[], rows: CsvCell[][]): void {
  downloadCsv(filename, buildCsv(meta, columns, rows));
}