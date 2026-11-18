// The feed process's Lighter switch: auto by default (starts when a Lighter market is published),
// Ethereum-mainnet endpoints only (testnet and Robinhood Chain refused), local endpoints for tests.
import { describe, expect, it } from 'vitest';
import { feedConfig } from '../src/feed';

describe('Lighter feed config', () => {
  it('is auto by default on the mainnet endpoints; MEXC and Bitunix settings are unchanged', () => {
    const c = feedConfig({});
    expect(c.lighter).toEqual({ enabled: true, mode: 'auto', wsUrl: 'wss://mainnet.zklighter.elliot.ai/stream', baseUrl: 'https://mainnet.zklighter.elliot.ai' });
    expect(c.bitunix).toMatchObject({ enabled: true, mode: 'auto' });
    expect(c).toMatchObject({ tickerSource: 'ws', wsUrl: 'wss://contract.mexc.com/edge' });
  });

  it('can be turned off or on; refuses other environments and bad values', () => {
    expect(feedConfig({ LIGHTER_PUBLIC_WS: 'off' }).lighter).toMatchObject({ enabled: false, mode: 'off' });
    expect(feedConfig({ LIGHTER_PUBLIC_WS: 'ON' }).lighter).toMatchObject({ enabled: true, mode: 'on' });
    expect(() => feedConfig({ LIGHTER_PUBLIC_WS: 'yes' })).toThrow(/LIGHTER_PUBLIC_WS/);
    expect(() => feedConfig({ LIGHTER_PUBLIC_WS_URL: 'wss://testnet.zklighter.elliot.ai/stream' })).toThrow(/mainnet stream/);
    expect(() => feedConfig({ LIGHTER_PUBLIC_WS_URL: 'wss://api.rh.lighter.xyz/stream' })).toThrow(/mainnet stream/);
    expect(() => feedConfig({ LIGHTER_PUBLIC_BASE_URL: 'https://api.rh.lighter.xyz' })).toThrow(/LIGHTER_PUBLIC_BASE_URL/);
    expect(() => feedConfig({ NODE_ENV: 'production', LIGHTER_PUBLIC_WS_URL: 'ws://127.0.0.1:9999/stream' })).toThrow(/mainnet stream/);
    expect(feedConfig({ LIGHTER_PUBLIC_WS_URL: 'ws://127.0.0.1:9999/stream', LIGHTER_PUBLIC_BASE_URL: 'http://localhost:9998/' }).lighter).toMatchObject({ wsUrl: 'ws://127.0.0.1:9999/stream', baseUrl: 'http://localhost:9998' });
  });
});
