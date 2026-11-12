import { describe, expect, it } from 'vitest';
import { liveUnavailableReason, modeChangeBlocker } from '../src/modeChange';

const base = { from: 'PAPER' as const, to: 'LIVE' as const, pair: 'BTC/USDT', liveConnectionStatus: 'VERIFIED', destinationBlockId: null, openPositions: 0, pendingOrders: 0 };

describe('Live availability (the New Entry rule)', () => {
  it('needs a verified MEXC connection and says why otherwise', () => {
    expect(liveUnavailableReason('VERIFIED')).toBeNull();
    expect(liveUnavailableReason(null)).toMatch(/Connect and verify your MEXC account/);
    expect(liveUnavailableReason('REVOKED')).toMatch(/Connect and verify/);
    expect(liveUnavailableReason('FAILED')).toMatch(/failed its read-only check/);
    expect(liveUnavailableReason('PENDING')).toMatch(/not been checked yet/);
  });
});

describe('modeChangeBlocker', () => {
  it('allows an eligible, idle block in either direction', () => {
    expect(modeChangeBlocker(base)).toBeNull();
    expect(modeChangeBlocker({ ...base, from: 'LIVE', to: 'PAPER', liveConnectionStatus: null })).toBeNull();
    expect(modeChangeBlocker({ ...base, to: 'PAPER' })).toBeNull(); // same mode: nothing to check
  });

  it('Live unavailable comes first, then an existing destination block, then activity', () => {
    const all = { ...base, liveConnectionStatus: null, destinationBlockId: 'b2', openPositions: 1, pendingOrders: 1 };
    expect(modeChangeBlocker(all)?.code).toBe('LIVE_UNAVAILABLE');
    expect(modeChangeBlocker({ ...all, liveConnectionStatus: 'VERIFIED' })).toMatchObject({ code: 'DESTINATION_EXISTS', destinationBlockId: 'b2' });
    expect(modeChangeBlocker({ ...all, liveConnectionStatus: 'VERIFIED', destinationBlockId: null })).toMatchObject({ code: 'BLOCK_IN_USE', openPositions: 1, pendingOrders: 1 });
  });

  it('names what is in use and offers the separate entry', () => {
    expect(modeChangeBlocker({ ...base, openPositions: 1 })?.message).toBe(
      'This entry is managing 1 open position in Paper, which stays in Paper. Copy its settings into a separate Live (MEXC) entry instead.'
    );
    expect(modeChangeBlocker({ ...base, pendingOrders: 2 })?.message).toMatch(/2 pending orders in Paper, which stay in Paper/);
    expect(modeChangeBlocker({ ...base, destinationBlockId: 'x' })?.message).toBe('You already have a Live (MEXC) entry for BTC/USDT. Edit that entry instead.');
  });
});
