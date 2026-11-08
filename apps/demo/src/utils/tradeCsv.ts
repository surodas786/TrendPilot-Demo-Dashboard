import { REPORTING_TIMEZONE } from '../data/mockData';
import { dhakaDate, formatClock } from './clock';
import { strategyWithVersion } from './strategies';
import type { TradeRecord } from '../types/execution';

const esc = (v: string | number) => {
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** CSV of completed paper trades with timezone, currency and active filters in the header. */
export function buildTradeCsv(trades: TradeRecord[], meta: {accountName: string;exchange: string;filters: string[];}): string {
  const header = [
  '# TrendPilot paper trade history — Demo, simulated data',
  `# Account: ${meta.accountName} · ${meta.exchange} · paper simulation`,
  `# Timezone: ${REPORTING_TIMEZONE}`,
  '# Currency: USDT',
  `# Filters: ${meta.filters.join('; ') || 'none'}`,
  `# Records: ${trades.length} completed trades`];

  const cols = ['Trade ID', 'Pair', 'Direction', 'Account', 'Exchange', 'Strategy version', 'Entry time', 'Final exit', 'Avg entry', 'Weighted avg exit', 'Original qty', 'Gross realized', 'Commissions', 'Funding received', 'Funding paid', 'Net realized', 'Exit reason'];
  const rows = trades.map((t) => [
  t.id,
  t.pair,
  t.direction === 'long' ? 'Long' : 'Short',
  meta.accountName,
  meta.exchange,
  strategyWithVersion(t.strategyId, t.strategyVersion),
  `${dhakaDate(t.exitAt)} ${t.entryTime}`,
  `${dhakaDate(t.exitAt)} ${formatClock(t.exitAt)}`,
  t.avgEntry.toFixed(t.priceDecimals),
  t.avgExit.toFixed(t.priceDecimals + 2),
  t.originalQty.toFixed(t.quantityDecimals),
  t.gross.toFixed(2),
  t.commissions.toFixed(2),
  t.fundingReceived.toFixed(2),
  t.fundingPaid.toFixed(2),
  t.net.toFixed(2),
  t.exitReason]
  );
  return [...header, cols.map(esc).join(','), ...rows.map((r) => r.map(esc).join(','))].join('\n');
}

export function downloadCsv(filename: string, content: string): void {
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}