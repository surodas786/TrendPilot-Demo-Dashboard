import { dayTimeToMs } from '../utils/clock';
import { makeOrder } from '../utils/orders';
import { formatNumber } from '../utils/format';
import type { AccountSim, CloseBehavior, FixtureId, OrderRecord } from '../types/execution';
import type { ActivityEvent, ClosedTrade, Direction, Position, PositionExitSnapshot } from '../types/trading';

export const DEFAULT_ACCOUNT_SIM: AccountSim = { closeBehavior: 'fill', behaviorByPosition: {}, protectionReplace: 'confirm', fixture: null };

export interface FixtureMeta {
  id: FixtureId;
  label: string;
  fixtureName: string;
  description: string;
}

export const FIXTURES: FixtureMeta[] = [
{ id: 'full-close', label: 'Successful full close', fixtureName: 'Fixture FC-1', description: 'One BTCUSDT long plus a working ETHUSDT entry order. Closing orders fill completely.' },
{ id: 'partial-close', label: 'Successful partial close', fixtureName: 'Fixture PC-1', description: 'One SOLUSDT long sized for a valid partial close. Closing orders fill completely.' },
{ id: 'partial-cancel', label: 'Partial fill followed by cancellation', fixtureName: 'Fixture PF-1', description: 'One ETHUSDT short. A closing order fills half, then the remainder is cancelled.' },
{ id: 'close-rejected', label: 'Closing request rejected', fixtureName: 'Fixture RJ-1', description: 'BTCUSDT closes are rejected; ETHUSDT closes fill — close-all gives a mixed result.' },
{ id: 'close-unknown', label: 'Closing result unknown, then reconciled', fixtureName: 'Fixture UK-1', description: 'BTCUSDT close returns no acknowledgement until you reconcile it; SOLUSDT fills.' },
{ id: 'protection-failed', label: 'Protective-order replacement failed', fixtureName: 'Fixture PR-1', description: 'Tightening the ETHUSDT stop fails and keeps the previous stop. SOLUSDT has a rejected stop.' },
{ id: 'external', label: 'External unmanaged position', fixtureName: 'Fixture EX-1', description: 'One managed BTCUSDT long plus an ETHUSDT short opened outside a managed strategy.' }];


export interface FixtureData {
  openingEquity: number;
  positions: Position[];
  orders: OrderRecord[];
  ledger: ClosedTrade[];
  activity: ActivityEvent[];
  sim: AccountSim;
}

interface PosSpec {
  key: string;
  pair: 'BTCUSDT' | 'ETHUSDT' | 'SOLUSDT';
  direction: Direction;
  qty: number;
  entry: number;
  mark: number;
  leverage: number;
  stop: number | null;
  target: number | null;
  openedAt: string;
  stopState?: OrderRecord['state'];
  managed?: boolean;
  snapshot?: PositionExitSnapshot;
}

const META = {
  BTCUSDT: { base: 'BTC', pd: 1, qd: 4 },
  ETHUSDT: { base: 'ETH', pd: 2, qd: 2 },
  SOLUSDT: { base: 'SOL', pd: 2, qd: 1 }
} as const;

const FEE_RATE = 0.0005;
const r2 = (v: number) => Math.round(v * 100) / 100;

const FIXED_PLAN: PositionExitSnapshot = { planLabel: 'Fixture plan · Fixed target v1', mode: 'A. Fixed target', partialTarget: null, closePct: null, trailing: null, bestPrice: null, oppositeExit: true };

function buildPosition(accountId: string, s: PosSpec, data: FixtureData) {
  const m = META[s.pair];
  const id = `${accountId}-fx-${s.key}`;
  const managed = s.managed !== false;
  const allocatedCost = r2(s.qty * s.entry / s.leverage);
  const opened = dayTimeToMs(s.openedAt);
  const exitSide = s.direction === 'long' ? 'Sell' : 'Buy';
  const entryFee = r2(s.qty * s.entry * FEE_RATE);
  const strategyId = managed ? 'supertrend-15m' : 'external';
  data.positions.push({
    id,
    accountId,
    exchangeId: 'mexc',
    pair: s.pair,
    baseAsset: m.base,
    direction: s.direction,
    strategyId,
    strategyVersion: managed ? '1.0' : undefined,
    subscriptionLabel: managed ? 'Fixture subscription' : undefined,
    quantity: s.qty,
    closedQuantity: 0,
    allocatedCost,
    leverage: s.leverage,
    entryPrice: s.entry,
    markPrice: s.mark,
    stopLoss: s.stop ?? Number.NaN,
    takeProfit: s.target ?? Number.NaN,
    initialStop: managed ? s.stop : null,
    trailingState: managed ? 'Not used by this plan' : 'Not recorded in this demo',
    protection: 'protected',
    marginMode: 'Isolated',
    triggerBasis: managed ? 'Mark price (simulated)' : 'Not recorded in this demo',
    openedAt: s.openedAt,
    priceDecimals: m.pd,
    quantityDecimals: m.qd,
    managed,
    exitSnapshot: managed ? s.snapshot ?? FIXED_PLAN : undefined
  });
  if (!managed) {
    data.activity.push({ id: `${id}-act-ext`, kind: 'skip', title: 'External position detected', detail: `${s.direction === 'long' ? 'Long' : 'Short'} ${s.qty} ${m.base} · not opened by a managed strategy`, accountId, strategyId, pair: s.pair, time: s.openedAt, positionId: id });
    return;
  }
  data.orders.push(
    makeOrder({ id: `${id}-ent`, accountId, positionId: id, pair: s.pair, baseAsset: m.base, purpose: 'entry', side: s.direction === 'long' ? 'Buy' : 'Sell', type: 'Market', requestedQty: s.qty, filledQty: s.qty, price: s.entry, state: 'filled', createdAt: opened - 1000, updatedAt: opened, priceDecimals: m.pd, quantityDecimals: m.qd, fills: [{ id: `${id}-fill-ent`, at: opened, price: s.entry, quantity: s.qty, fee: entryFee }], seeded: true, reduceOnly: false })
  );
  data.ledger.push({ id: `${id}-fee`, kind: 'entry-fee', positionId: id, accountId, strategyId, pair: s.pair, direction: s.direction, closedAt: s.openedAt, at: opened, grossPnl: 0, commission: entryFee, fundingPaid: 0, fundingReceived: 0 });
  data.activity.push({ id: `${id}-act-ent`, kind: 'entry', title: 'Paper entry filled', detail: `${s.direction === 'long' ? 'Long' : 'Short'} ${formatNumber(s.qty, m.qd)} ${m.base} at ${formatNumber(s.entry, m.pd)} · ${s.leverage}× · fee ${formatNumber(entryFee)} USDT`, accountId, strategyId, pair: s.pair, time: s.openedAt, positionId: id });
  if (s.stop !== null) {
    const stopState = s.stopState ?? 'submitted';
    data.orders.push(
      makeOrder({ id: `${id}-sl`, accountId, positionId: id, pair: s.pair, baseAsset: m.base, purpose: 'stop-loss', side: exitSide, type: 'Stop market', requestedQty: s.qty, price: s.stop, state: stopState, createdAt: opened + 4000, priceDecimals: m.pd, quantityDecimals: m.qd, seeded: true, note: stopState === 'rejected' ? 'Rejected by simulated venue — no resting stop' : undefined })
    );
    data.activity.push(
      stopState === 'rejected' ?
      { id: `${id}-act-sl`, kind: 'reject', title: 'Protective stop rejected', detail: `Stop ${formatNumber(s.stop, m.pd)} rejected (fixture) — position unprotected`, accountId, strategyId, pair: s.pair, time: shift(s.openedAt, 4), positionId: id } :
      { id: `${id}-act-sl`, kind: 'protection', title: 'Protective stop confirmed', detail: `Stop ${formatNumber(s.stop, m.pd)}${s.target ? ` · Target ${formatNumber(s.target, m.pd)}` : ''}`, accountId, strategyId, pair: s.pair, time: shift(s.openedAt, 4), positionId: id }
    );
  }
  if (s.target !== null) {
    data.orders.push(
      makeOrder({ id: `${id}-tp`, accountId, positionId: id, pair: s.pair, baseAsset: m.base, purpose: 'take-profit', side: exitSide, type: 'Limit', requestedQty: s.qty, price: s.target, state: 'submitted', createdAt: opened + 4000, priceDecimals: m.pd, quantityDecimals: m.qd, seeded: true })
    );
  }
}

function shift(time: string, seconds: number): string {
  const [h, m, s] = time.split(':').map(Number);
  const total = h * 3600 + m * 60 + s + seconds;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(Math.floor(total / 3600))}:${pad(Math.floor(total % 3600 / 60))}:${pad(total % 60)}`;
}

/** Builds a deterministic, internally consistent fixture for one account. */
export function buildFixture(accountId: string, fixture: FixtureId): FixtureData {
  const data: FixtureData = { openingEquity: 5000, positions: [], orders: [], ledger: [], activity: [], sim: { ...DEFAULT_ACCOUNT_SIM, behaviorByPosition: {}, fixture } };
  const add = (s: PosSpec) => buildPosition(accountId, s, data);
  const behave = (key: string, b: CloseBehavior) => {
    data.sim.behaviorByPosition[`${accountId}-fx-${key}`] = b;
  };

  switch (fixture) {
    case 'full-close':{
        add({ key: 'btc', pair: 'BTCUSDT', direction: 'long', qty: 0.01, entry: 60000, mark: 61200, leverage: 5, stop: 58800, target: 64000, openedAt: '12:00:04' });
        const created = dayTimeToMs('13:45:02');
        data.orders.push(
          makeOrder({ id: `${accountId}-fx-eth-entry`, accountId, positionId: null, pair: 'ETHUSDT', baseAsset: 'ETH', purpose: 'entry', side: 'Buy', type: 'Limit', requestedQty: 0.2, price: 2400, state: 'submitted', createdAt: created, priceDecimals: 2, quantityDecimals: 2, leverage: 5, stopRisk: 9.6, reduceOnly: false, note: 'Working entry · reserves 96.00 USDT margin' })
        );
        break;
      }
    case 'partial-close':
      add({ key: 'sol', pair: 'SOLUSDT', direction: 'long', qty: 4, entry: 150, mark: 156, leverage: 5, stop: 144, target: 165, openedAt: '12:30:04' });
      break;
    case 'partial-cancel':
      add({ key: 'eth', pair: 'ETHUSDT', direction: 'short', qty: 0.5, entry: 2600, mark: 2560, leverage: 5, stop: 2680, target: 2450, openedAt: '11:00:04' });
      data.sim.closeBehavior = 'partial-then-cancel';
      break;
    case 'close-rejected':
      add({ key: 'btc', pair: 'BTCUSDT', direction: 'long', qty: 0.01, entry: 60000, mark: 60900, leverage: 5, stop: 58800, target: 64000, openedAt: '10:00:04' });
      add({ key: 'eth', pair: 'ETHUSDT', direction: 'long', qty: 0.2, entry: 2400, mark: 2430, leverage: 5, stop: 2340, target: 2520, openedAt: '11:15:04' });
      behave('btc', 'reject');
      break;
    case 'close-unknown':
      add({ key: 'btc', pair: 'BTCUSDT', direction: 'short', qty: 0.01, entry: 61000, mark: 60400, leverage: 5, stop: 62200, target: 58600, openedAt: '10:30:04' });
      add({ key: 'sol', pair: 'SOLUSDT', direction: 'long', qty: 2, entry: 150, mark: 152, leverage: 5, stop: 144, target: 162, openedAt: '12:45:04' });
      behave('btc', 'unknown');
      break;
    case 'protection-failed':
      add({ key: 'eth', pair: 'ETHUSDT', direction: 'long', qty: 0.3, entry: 2400, mark: 2460, leverage: 5, stop: 2340, target: 2520, openedAt: '09:30:04' });
      add({ key: 'sol', pair: 'SOLUSDT', direction: 'long', qty: 2, entry: 150, mark: 149, leverage: 5, stop: 144, target: null, openedAt: '13:00:04', stopState: 'rejected' });
      data.sim.protectionReplace = 'fail';
      break;
    case 'external':
      add({ key: 'btc', pair: 'BTCUSDT', direction: 'long', qty: 0.01, entry: 60000, mark: 60600, leverage: 5, stop: 58800, target: 64000, openedAt: '10:00:04' });
      add({ key: 'ext-eth', pair: 'ETHUSDT', direction: 'short', qty: 0.3, entry: 2500, mark: 2480, leverage: 5, stop: null, target: null, openedAt: '11:20:00', managed: false });
      break;
  }
  return data;
}