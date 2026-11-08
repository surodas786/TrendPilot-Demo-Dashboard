import { formatNumber } from './format';
import { isWorking } from './orders';
import type { OrderRecord } from '../types/execution';
import type { Position } from '../types/trading';

/** Take-profit / trailing summary from working order records and the trailing state. */
export function exitSummary(p: Position, orders: OrderRecord[]): string {
  if (p.managed === false) return 'No TrendPilot exit plan';
  const tps = orders.filter((o) => o.positionId === p.id && o.purpose === 'take-profit' && isWorking(o) && o.price !== null);
  const tpText = tps.length ? tps.map((o, i) => `${tps.length > 1 ? `TP${i + 1}` : 'TP'} ${formatNumber(o.price as number, p.priceDecimals)}`).join(' · ') : 'No working target';
  const trailing = /not configured|not used|not recorded/i.test(p.trailingState) ? '' : ` · ${p.trailingState}`;
  return `${tpText}${trailing}`;
}