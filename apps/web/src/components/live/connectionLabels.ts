import type { PillTone } from '../ui/StatusPill';

/** One wording for the investor's MEXC connection, shared by Live Trading and My Account. */
export function connectionStatusLabel(status: string | null | undefined): { text: string; tone: PillTone } {
  switch (status) {
    case 'VERIFIED':
      return { text: 'Verified', tone: 'gain' };
    case 'FAILED':
      return { text: 'Check failed', tone: 'loss' };
    case 'PENDING':
      return { text: 'Pending', tone: 'neutral' };
    default:
      return { text: 'Not connected', tone: 'neutral' };
  }
}

/**
 * The position mode MEXC reported for this connection. One-way and Hedge are both supported (the
 * order builder follows the verified mode); only an unchecked mode blocks new entries.
 */
export function positionModeLabel(mode: string | null | undefined): { text: string; tone: PillTone } {
  if (mode === 'ONE_WAY') return { text: 'One-way', tone: 'gain' };
  if (mode === 'HEDGE') return { text: 'Hedge', tone: 'gain' };
  return { text: 'Not checked yet', tone: 'neutral' };
}
