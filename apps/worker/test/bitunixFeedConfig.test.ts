// The feed process's Bitunix public-price switch: off by default (MEXC feed unchanged), validated
// symbols and URL when on.
import { describe, expect, it } from 'vitest';
import { feedConfig } from '../src/feed';

describe('Bitunix feed config', () => {
  it('is off by default and the MEXC settings are unchanged', () => {
    const c = feedConfig({});
    expect(c.bitunix).toEqual({ enabled: false, wsUrl: 'wss://fapi.bitunix.com/public/', symbols: ['BTCUSDT', 'XAUUSDT'] });
    expect(c).toMatchObject({ tickerSource: 'ws', wsUrl: 'wss://contract.mexc.com/edge', restFallback: { enabled: false } });
  });

  it('turns on with normalized, de-duplicated symbols (TradingView forms accepted)', () => {
    expect(feedConfig({ BITUNIX_PUBLIC_WS: 'on', BITUNIX_WS_SYMBOLS: 'BTCUSDT, BITUNIX:BTCUSDT.P,xauusdt' }).bitunix).toMatchObject({ enabled: true, symbols: ['BTCUSDT', 'XAUUSDT'] });
  });

  it('refuses bad values instead of guessing', () => {
    expect(() => feedConfig({ BITUNIX_PUBLIC_WS: 'yes' })).toThrow(/BITUNIX_PUBLIC_WS/);
    expect(() => feedConfig({ BITUNIX_WS_SYMBOLS: 'BTCUSDT,BTCUSD' })).toThrow(/invalid symbol "BTCUSD"/);
    expect(() => feedConfig({ BITUNIX_PUBLIC_WS_URL: 'http://fapi.bitunix.com/public/' })).toThrow(/wss/);
  });
});
