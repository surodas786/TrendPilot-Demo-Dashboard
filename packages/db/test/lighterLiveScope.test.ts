import { describe, expect, it } from 'vitest';
import { lighterEvidenceHash, lighterLiveRefusal, lighterLiveScope, lighterMainnetOrdersEnabled, LIGHTER_ACCOUNT_CAPABILITIES } from '../src/live/lighterLiveScope';
import { openLighterOrderTransport } from '../src/live/lighterPrivate';

const CONN = '3f0c1f2e-8b6a-4c1d-9e2f-1a2b3c4d5e6f';
const ROUTE = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
const SCOPED = { LIGHTER_MAINNET_ORDERS: 'enabled', LIGHTER_LIVE_CONNECTIONS: CONN, LIGHTER_LIVE_MARKETS: '92', LIGHTER_LIVE_ROUTES: ROUTE };
const INPUTS = { entryWorstPricePct: '0.5', stopWorstPricePct: '2', closeWorstPricePct: '1', takerFeeRate: '0.0002' };
const ALL = Object.fromEntries([...LIGHTER_ACCOUNT_CAPABILITIES, 'LIGHTER_XAU_EXECUTION'].map((c) => [c, 'VERIFIED' as const]));
const conn = { id: CONN, status: 'VERIFIED', venueEnvironment: 'MAINNET' };
const target = { connection: conn, marketId: 92, routeId: ROUTE };

describe('Lighter Live scope (default off)', () => {
  it('unset settings: no orders, empty scope; every level refuses', () => {
    const s = lighterLiveScope({});
    expect(s).toMatchObject({ mainnetOrders: false, issues: [] });
    expect(s.connections.size + s.markets.size + s.routes.size).toBe(0);
    for (const level of ['ACCOUNT', 'MARKET', 'SEND', 'ENTRY'] as const) expect(lighterLiveRefusal(s, ALL, INPUTS, target, level)).toMatch(/LIGHTER_MAINNET_ORDERS/);
    expect(lighterMainnetOrdersEnabled({})).toBe(false);
    expect(lighterMainnetOrdersEnabled({ LIGHTER_MAINNET_ORDERS: 'yes' })).toBe(false);
  });

  it('the mainnet transport needs BOTH LIVE_ORDER_TRANSPORT and LIGHTER_MAINNET_ORDERS', () => {
    expect(() => openLighterOrderTransport('MAINNET', { LIVE_ORDER_TRANSPORT: 'disabled', LIGHTER_MAINNET_ORDERS: 'enabled', NODE_ENV: 'production' })).toThrow(/LIVE_ORDER_TRANSPORT/);
    expect(() => openLighterOrderTransport('MAINNET', { LIVE_ORDER_TRANSPORT: 'enabled', NODE_ENV: 'production' })).toThrow(/LIGHTER_MAINNET_ORDERS/);
  });

  it('malformed entries are ignored (never widen the scope) and reported', () => {
    const s = lighterLiveScope({ LIGHTER_MAINNET_ORDERS: 'on', LIGHTER_LIVE_CONNECTIONS: `${CONN}, *`, LIGHTER_LIVE_MARKETS: '92,all', LIGHTER_LIVE_ROUTES: 'any' });
    expect(s.mainnetOrders).toBe(false);
    expect([...s.connections]).toEqual([CONN]);
    expect([...s.markets]).toEqual([92]);
    expect(s.routes.size).toBe(0);
    expect(s.issues).toHaveLength(4);
  });

  it('the configured account, market and route pass when every capability and input is present', () => {
    const s = lighterLiveScope(SCOPED);
    for (const level of ['ACCOUNT', 'MARKET', 'SEND', 'ENTRY'] as const) expect(lighterLiveRefusal(s, ALL, INPUTS, target, level)).toBeNull();
    // IDs compare case-insensitively.
    expect(lighterLiveRefusal(s, ALL, INPUTS, { ...target, connection: { ...conn, id: CONN.toUpperCase() }, routeId: ROUTE.toUpperCase() }, 'ENTRY')).toBeNull();
  });

  it('another account, market or route cannot use the path', () => {
    const s = lighterLiveScope(SCOPED);
    expect(lighterLiveRefusal(s, ALL, INPUTS, { ...target, connection: { ...conn, id: '00000000-0000-4000-8000-000000000001' } }, 'ENTRY')).toMatch(/LIGHTER_LIVE_CONNECTIONS/);
    expect(lighterLiveRefusal(s, ALL, INPUTS, { ...target, marketId: 1 }, 'SEND')).toMatch(/LIGHTER_LIVE_MARKETS/);
    expect(lighterLiveRefusal(s, ALL, INPUTS, { ...target, marketId: null }, 'MARKET')).toMatch(/LIGHTER_LIVE_MARKETS/);
    expect(lighterLiveRefusal(s, ALL, INPUTS, { ...target, routeId: '00000000-0000-4000-8000-000000000002' }, 'ENTRY')).toMatch(/LIGHTER_LIVE_ROUTES/);
    expect(lighterLiveRefusal(s, ALL, INPUTS, { ...target, routeId: null }, 'ENTRY')).toMatch(/LIGHTER_LIVE_ROUTES/);
    expect(lighterLiveRefusal(s, ALL, INPUTS, { ...target, connection: { ...conn, venueEnvironment: 'TESTNET' } }, 'ACCOUNT')).toMatch(/mainnet/);
    expect(lighterLiveRefusal(s, ALL, INPUTS, { ...target, connection: { ...conn, status: 'FAILED' } }, 'ACCOUNT')).toMatch(/not verified/);
    expect(lighterLiveRefusal(s, ALL, INPUTS, { ...target, connection: null }, 'ACCOUNT')).toMatch(/No Lighter connection/);
  });

  it('every account capability and the XAU execution capability are required; missing inputs refuse', () => {
    const s = lighterLiveScope(SCOPED);
    for (const c of LIGHTER_ACCOUNT_CAPABILITIES) expect(lighterLiveRefusal(s, { ...ALL, [c]: 'PENDING' }, INPUTS, target, 'ENTRY')).toMatch(new RegExp(c));
    expect(lighterLiveRefusal(s, { ...ALL, LIGHTER_XAU_EXECUTION: 'PENDING' }, INPUTS, target, 'SEND')).toMatch(/LIGHTER_XAU_EXECUTION/);
    expect(lighterLiveRefusal(s, { ...ALL, LIGHTER_XAU_EXECUTION: 'PENDING' }, INPUTS, target, 'ACCOUNT')).toBeNull(); // account-level does not need the market
    expect(lighterLiveRefusal(s, ALL, { ...INPUTS, closeWorstPricePct: null }, target, 'ACCOUNT')).toMatch(/closeWorstPricePct/);
    expect(lighterLiveRefusal(s, ALL, { ...INPUTS, takerFeeRate: null }, target, 'ENTRY')).toMatch(/takerFeeRate/);
  });

  it('evidence references are read from lighter-tx:<hash>', () => {
    expect(lighterEvidenceHash(`pilot 2026-11-20 lighter-tx:${'ab'.repeat(32)} ok`)).toBe('ab'.repeat(32));
    expect(lighterEvidenceHash('looks fine')).toBeNull();
  });
});
