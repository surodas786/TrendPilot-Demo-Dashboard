// The feed process's Bitunix public-price switch: auto by default (the stream follows the Bitunix
// instruments, so a normal feed start prices published Bitunix pairs), validated symbols and URL.
import { describe, expect, it } from 'vitest';
import { feedConfig } from '../src/feed';

describe('Bitunix feed config', () => {
  it('is auto by default (Bitunix instruments only) and the MEXC settings are unchanged', () => {
    const c = feedConfig({});
    expect(c.bitunix).toEqual({ enabled: true, mode: 'auto', wsUrl: 'wss://fapi.bitunix.com/public/', symbols: [] });
    expect(c).toMatchObject({ tickerSource: 'ws', wsUrl: 'wss://contract.mexc.com/edge', restFallback: { enabled: false } });
  });

  it('turns on with normalized, de-duplicated symbols (TradingView forms accepted)', () => {
    expect(feedConfig({ BITUNIX_PUBLIC_WS: 'on', BITUNIX_WS_SYMBOLS: 'BTCUSDT, BITUNIX:BTCUSDT.P,xauusdt' }).bitunix).toMatchObject({ enabled: true, symbols: ['BTCUSDT', 'XAUUSDT'] });
  });

  it('can still be turned off explicitly; on keeps the default symbol list', () => {
    expect(feedConfig({ BITUNIX_PUBLIC_WS: 'off' }).bitunix).toMatchObject({ enabled: false, mode: 'off' });
    expect(feedConfig({ BITUNIX_PUBLIC_WS: 'on' }).bitunix).toMatchObject({ enabled: true, mode: 'on', symbols: ['BTCUSDT', 'XAUUSDT'] });
    expect(feedConfig({ BITUNIX_PUBLIC_WS: 'AUTO', BITUNIX_WS_SYMBOLS: 'XAUUSDT' }).bitunix).toMatchObject({ enabled: true, mode: 'auto', symbols: ['XAUUSDT'] });
  });

  it('refuses bad values instead of guessing', () => {
    expect(() => feedConfig({ BITUNIX_PUBLIC_WS: 'yes' })).toThrow(/BITUNIX_PUBLIC_WS/);
    expect(() => feedConfig({ BITUNIX_WS_SYMBOLS: 'BTCUSDT,BTCUSD' })).toThrow(/invalid symbol "BTCUSD"/);
    expect(() => feedConfig({ BITUNIX_PUBLIC_WS_URL: 'http://fapi.bitunix.com/public/' })).toThrow(/wss/);
  });
});

describe('Bitunix private account sync switch (worker)', () => {
  it('is on by default, can be turned off, and refuses anything else', async () => {
    const { bitunixPrivateSyncMode } = await import('../src/worker');
    expect(bitunixPrivateSyncMode({})).toBe('on');
    expect(bitunixPrivateSyncMode({ BITUNIX_PRIVATE_SYNC: 'OFF' })).toBe('off');
    expect(() => bitunixPrivateSyncMode({ BITUNIX_PRIVATE_SYNC: 'maybe' })).toThrow(/BITUNIX_PRIVATE_SYNC/);
  });
});
