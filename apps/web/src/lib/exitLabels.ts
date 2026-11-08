export const EXIT_LABEL: Record<string, string> = {
  STOP_LOSS: 'Stop loss',
  TAKE_PROFIT: 'Take profit',
  TRAILING_STOP: 'Trailing stop',
  SIGNAL_CLOSE: 'Close signal',
  OPPOSITE_SIGNAL_CLOSE: 'Opposite signal',
  REVERSAL_CLOSE: 'Close and reverse',
  MANUAL_CLOSE: 'Manual close'
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
