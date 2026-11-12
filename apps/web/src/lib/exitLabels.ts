export const EXIT_LABEL: Record<string, string> = {
  STOP_LOSS: 'Stop loss',
  TAKE_PROFIT: 'Take profit',
  TRAILING_TAKE_PROFIT: 'Trailing take profit',
  TRAILING_STOP: 'Trailing stop (legacy)',
  SIGNAL_CLOSE: 'Close signal',
  OPPOSITE_SIGNAL_CLOSE: 'Opposite signal',
  REVERSAL_CLOSE: 'Close and reverse',
  MANUAL_CLOSE: 'Manual close',
  PROTECTION_FAILURE: 'Emergency close (stop not confirmed)',
  EXTERNAL_CLOSE: 'Closed on MEXC',
  LIQUIDATION: 'Liquidated'
};

export const signedUsdt = (v: string) => `${Number(v) > 0 ? '+' : ''}${Number(v).toLocaleString('en-US', { maximumFractionDigits: 4 })} USDT`;

export const TARGET_STATUS_LABEL: Record<string, string> = {
  PENDING: 'Waiting',
  REQUESTED: 'Close sent',
  PARTIAL: 'Partly filled',
  DONE: 'Filled',
  CANCELLED: 'Cancelled'
};

/** "1 of 2 targets filled" style summary. */
export const targetSummary = (targets: { status: string }[]) =>
  targets.length === 0 ? null : `${targets.filter((t) => t.status === 'DONE').length} of ${targets.length} target${targets.length === 1 ? '' : 's'} filled`;

/** Name of a position's trailing exit: Trailing take profit, or the legacy trailing stop kept by older positions. */
export const trailingName = (kind: string) => (kind === 'STOP' ? 'Trailing stop (legacy)' : 'Trailing take profit');

/** Investor-facing trailing state: Waiting for activation, Active, or Done. */
export const TRAILING_STATUS_LABEL: Record<string, string> = {
  WAITING: 'Waiting for activation',
  ACTIVE: 'Active',
  DONE: 'Done'
};
