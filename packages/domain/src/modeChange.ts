/**
 * Trading mode of an order block: who may choose Live, and when an existing block may switch.
 * Shared by the Trade Settings editor (New Entry and Edit) and the server, so the reason the
 * investor sees is the one the server enforces.
 */
export type BlockMode = 'PAPER' | 'LIVE';

export const MODE_LABELS: Record<BlockMode, string> = { PAPER: 'Paper', LIVE: 'Live (MEXC)' };

/**
 * The New Entry rule for Live settings: the investor's own MEXC connection is verified.
 * Returns why Live is unavailable, or null when it is available.
 */
export function liveUnavailableReason(connectionStatus: string | null | undefined): string | null {
  switch (connectionStatus) {
    case 'VERIFIED':
      return null;
    case 'FAILED':
      return 'Your MEXC connection failed its read-only check. Fix it on the Live Trading page (Save and check) to use Live.';
    case 'PENDING':
      return 'Your MEXC connection has not been checked yet. Finish Save and check on the Live Trading page to use Live.';
    default:
      return 'Connect and verify your MEXC account on the Live Trading page to use Live.';
  }
}

export type ModeChangeBlocker =
  /** Live is not available to this investor (same rule as New Entry). */
  | { code: 'LIVE_UNAVAILABLE'; message: string }
  /** One block per pair and mode: the investor already has one in the destination mode. */
  | { code: 'DESTINATION_EXISTS'; message: string; destinationBlockId: string }
  /** The block manages an open position or an unfinished order, which must stay in its mode. */
  | { code: 'BLOCK_IN_USE'; message: string; openPositions: number; pendingOrders: number };

export interface ModeChangeFacts {
  from: BlockMode;
  to: BlockMode;
  pair: string;
  liveConnectionStatus: string | null | undefined;
  /** The investor's block for the same pair in the destination mode, if any. */
  destinationBlockId: string | null;
  /** Open positions and unfinished orders (intents not yet filled, rejected or cancelled) of this block. */
  openPositions: number;
  pendingOrders: number;
}

/**
 * Why `from` → `to` is not possible for this block, or null when it is. Checked in this order:
 * Live availability, an existing destination block (edit that one instead), then activity on
 * this block (copy the settings into a separate block instead).
 */
export function modeChangeBlocker(f: ModeChangeFacts): ModeChangeBlocker | null {
  if (f.from === f.to) return null;
  const to = MODE_LABELS[f.to];
  const from = MODE_LABELS[f.from];
  if (f.to === 'LIVE') {
    const reason = liveUnavailableReason(f.liveConnectionStatus);
    if (reason) return { code: 'LIVE_UNAVAILABLE', message: reason };
  }
  if (f.destinationBlockId) {
    return { code: 'DESTINATION_EXISTS', message: `You already have a ${to} entry for ${f.pair}. Edit that entry instead.`, destinationBlockId: f.destinationBlockId };
  }
  if (f.openPositions > 0 || f.pendingOrders > 0) {
    const what = [f.openPositions > 0 ? `${f.openPositions} open position${f.openPositions === 1 ? '' : 's'}` : '', f.pendingOrders > 0 ? `${f.pendingOrders} pending order${f.pendingOrders === 1 ? '' : 's'}` : '']
      .filter(Boolean)
      .join(' and ');
    return {
      code: 'BLOCK_IN_USE',
      message: `This entry is managing ${what} in ${from}, which stay${f.openPositions + f.pendingOrders === 1 ? 's' : ''} in ${from}. Copy its settings into a separate ${to} entry instead.`,
      openPositions: f.openPositions,
      pendingOrders: f.pendingOrders
    };
  }
  return null;
}
