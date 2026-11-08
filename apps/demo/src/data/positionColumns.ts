export type PositionColumnId = 'account' | 'strategy' | 'allocated' | 'margin' | 'leverage' | 'qty' | 'entry' | 'mark' | 'notional' | 'pnl' | 'stop' | 'exits';

/** Optional Managed Positions columns. Pair, protection and actions are always shown. */
export const positionColumns: {id: PositionColumnId;label: string;defaultVisible: boolean;numeric: boolean;}[] = [
{ id: 'account', label: 'Exchange / account', defaultVisible: false, numeric: false },
{ id: 'strategy', label: 'Strategy · version', defaultVisible: true, numeric: false },
{ id: 'allocated', label: 'Original entry cost', defaultVisible: false, numeric: true },
{ id: 'margin', label: 'Current margin', defaultVisible: true, numeric: true },
{ id: 'leverage', label: 'Leverage · mode', defaultVisible: false, numeric: false },
{ id: 'qty', label: 'Remaining qty', defaultVisible: true, numeric: true },
{ id: 'entry', label: 'Avg entry', defaultVisible: true, numeric: true },
{ id: 'mark', label: 'Mark (sim.)', defaultVisible: true, numeric: true },
{ id: 'notional', label: 'Current notional', defaultVisible: false, numeric: true },
{ id: 'pnl', label: 'Unrealized (USDT)', defaultVisible: true, numeric: true },
{ id: 'stop', label: 'Effective stop', defaultVisible: true, numeric: true },
{ id: 'exits', label: 'Take profit / trailing', defaultVisible: false, numeric: false }];