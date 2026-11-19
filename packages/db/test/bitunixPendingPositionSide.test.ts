// 19 Nov 2026 incident: every Bitunix sync for connection 5c7804dc failed with
//   PARSE: position 403163326623575343: unknown position side "SELL"
// get_pending_positions is documented with side LONG/SHORT, but in HEDGE mode production sends the
// leg's opening direction (SELL = the Short leg). The private WebSocket `position` channel sent
// "SHORT" for the same leg, and order / trade / TP-SL rows use BUY/SELL as the TRADE direction (a
// reduce-only SELL closes a Long leg). The fix is endpoint-specific: only a pending-position row that
// states its position mode maps BUY/SELL to a leg; order sides stay raw. Fixture: sanitized
// production response (see the fixture's _source / _synthetic notes).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { normalizeBitunixHistoryPosition, normalizeBitunixOrder, normalizeBitunixPosition, normalizeBitunixTrade, readPendingPositions, takeBitunixSnapshot, type TaggedRequester } from '../src/live/bitunixAccount';
import { BitunixPrivateError } from '../src/live/bitunixPrivate';
import { parseBitunixPrivateFrame } from '../src/live/bitunixPrivateWs';

const FX = JSON.parse(readFileSync(new URL('./fixtures/bitunix-private/pending-positions-hedge-sell-2026-11-19.json', import.meta.url), 'utf8')) as {
  positionMode: unknown;
  pendingPositions: Record<string, unknown>[];
  pendingOrders: unknown;
  pendingTpsl: Record<string, unknown>[];
  openingOrder: Record<string, unknown>;
  earlierReduceOnlyClose: Record<string, unknown>;
  openingTrade: Record<string, unknown>;
};
const [shortLeg, longLeg] = FX.pendingPositions as [Record<string, unknown>, Record<string, unknown>];

/** Serves the fixture as the production endpoints answered, tagged with the account's own ID. */
function fixtureRequester(positions = FX.pendingPositions): TaggedRequester {
  return {
    accountTag: '891435181',
    async get<T>(path: string): Promise<T> {
      switch (path) {
        case '/api/v1/futures/account/position_mode':
          return FX.positionMode as T;
        case '/api/v1/futures/account':
          return [{ marginCoin: 'USDT', available: '317.2168318886987807', frozen: '0', margin: '4.9144305622104541', transfer: '317.2168318886987807', positionMode: 'HEDGE', crossUnrealizedPNL: '0', isolationUnrealizedPNL: '0.1755', bonus: '0' }] as T;
        case '/api/v1/futures/position/get_pending_positions':
          return positions as T;
        case '/api/v1/futures/trade/get_pending_orders':
          return FX.pendingOrders as T;
        case '/api/v1/futures/tpsl/get_pending_orders':
          return FX.pendingTpsl as T;
        default:
          throw new Error(`unexpected ${path}`);
      }
    }
  };
}

describe('get_pending_positions side (production payload, HEDGE mode)', () => {
  it('the production Short leg (side "SELL") is SHORT with every figure exact: IDs strings, quantities decimals, ms timestamps', () => {
    expect(normalizeBitunixPosition(shortLeg)).toEqual({
      positionId: '403163326623575343',
      symbol: 'XAUUSDT',
      side: 'SHORT',
      qty: '0.026',
      avgOpenPrice: '3732.15',
      positionMode: 'HEDGE',
      marginMode: 'ISOLATION',
      leverage: 20,
      margin: '4.9144305622104541',
      unrealizedPNL: '0.1755',
      realizedPNL: '-0.0469762190907652',
      fee: '-0.04851795',
      funding: '0.0015417309092348',
      liqPrice: '3907.61',
      ctimeMs: 1795088715000,
      mtimeMs: 1795089602000
    });
  });

  it('both Hedge legs of one symbol: BUY = the Long leg, SELL = the Short leg, kept apart', async () => {
    const out = await readPendingPositions(fixtureRequester());
    expect(out.excludedSubAccountRows).toBe(0); // the own-account tag, not a sub-account
    expect(out.items.map((p) => [p.positionId, p.side, p.qty, p.avgOpenPrice, p.liqPrice])).toEqual([
      ['403163326623575343', 'SHORT', '0.026', '3732.15', '3907.61'],
      ['403163326623575344', 'LONG', '0.024', '3739.92', '3571.02']
    ]);
  });

  it('the documented LONG/SHORT form is still read, in either mode', () => {
    expect(normalizeBitunixPosition({ ...shortLeg, side: 'SHORT' }).side).toBe('SHORT');
    expect(normalizeBitunixPosition({ ...longLeg, side: 'LONG' }).side).toBe('LONG');
    expect(normalizeBitunixPosition({ ...longLeg, side: 'long', positionMode: 'ONE_WAY' }).side).toBe('LONG');
    expect(normalizeBitunixPosition({ ...longLeg, side: 'BUY', positionMode: 'ONE_WAY' }).side).toBe('LONG'); // net position direction
  });

  it('BUY/SELL on a row without a recognized position mode, or any other side, still fails the read', async () => {
    expect(() => normalizeBitunixPosition({ ...shortLeg, positionMode: undefined })).toThrow(/unknown position side "SELL" \(no positionMode on the row\)/);
    expect(() => normalizeBitunixPosition({ ...shortLeg, positionMode: 'BOTH' })).toThrow(/unknown position side "SELL"/);
    expect(() => normalizeBitunixPosition({ ...shortLeg, side: 'BOTH' })).toThrow(/unknown position side "BOTH"/);
    expect(() => normalizeBitunixPosition({ ...shortLeg, side: null })).toThrow(/unknown position side null/);
    await expect(readPendingPositions(fixtureRequester([{ ...shortLeg, side: 'CLOSE' }]))).rejects.toBeInstanceOf(BitunixPrivateError);
  });

  it('a liquidation price ≤ 0 means none; a positionId beyond 2^53 sent as a number is refused, never rounded', () => {
    expect(normalizeBitunixPosition({ ...shortLeg, liqPrice: '0' }).liqPrice).toBeNull();
    expect(() => normalizeBitunixPosition({ ...shortLeg, positionId: Number('403163326623575343') })).toThrow(/lost precision/);
  });

  it('the complete snapshot succeeds on the production account state (the read that failed every sync)', async () => {
    const s = await takeBitunixSnapshot(fixtureRequester([shortLeg]), () => 1795089605000);
    expect(s.positionMode).toBe('HEDGE');
    expect(s.positions).toEqual([expect.objectContaining({ positionId: '403163326623575343', side: 'SHORT', qty: '0.026', margin: '4.9144305622104541' })]);
    expect(s.pendingOrders).toEqual([]);
    // "Open Orders (1)" on Bitunix is this position TP/SL: stop loss 3769.34 (mark), market, the full 0.026.
    expect(s.tpsl).toEqual([expect.objectContaining({ id: '7003504849235273894', positionId: '403163326623575343', slPrice: '3769.34', slStopType: 'MARK_PRICE', slOrderType: 'MARKET', slQty: '0.026', tpPrice: null })]);
  });
});

describe('order, trade and TP/SL sides are trade directions, never converted to legs', () => {
  it('the opening SELL order and its trade keep side SELL; a reduce-only SELL (a Long close) stays a close', () => {
    expect(normalizeBitunixOrder(FX.openingOrder)).toMatchObject({ orderId: '2123382089013051392', clientId: '30c832a8930448e8a18586f933b59527', origin: 'TRENDPILOT', side: 'SELL', reduceOnly: false, status: 'FILLED', qty: '0.026', tradeQty: '0.026', requestedPrice: null, avgPrice: '3732.15', fee: '0.04851795' });
    expect(normalizeBitunixOrder(FX.earlierReduceOnlyClose)).toMatchObject({ side: 'SELL', reduceOnly: true, origin: 'EXCHANGE' });
    expect(normalizeBitunixTrade(FX.openingTrade)).toMatchObject({ tradeId: '6630292440201512116', orderId: '2123382089013051392', side: 'SELL', qty: '0.026', price: '3732.15', fee: '0.04851795' });
  });

  it('position history keeps reading BUY/SELL as the leg direction (no mode on those rows)', () => {
    expect(normalizeBitunixHistoryPosition({ positionId: '403163326623575343', symbol: 'XAUUSDT', side: 'SELL', maxQty: '0.026', entryPrice: '3732.15', mtime: '1795089602000' }).side).toBe('SHORT');
  });

  it('the private WebSocket position channel keeps its documented LONG/SHORT (what production sent for this leg)', () => {
    const frame = (side: string) => ({ ch: 'position', ts: 1795088715410, data: { event: 'OPEN', positionId: '403163326623575343', marginMode: 'ISOLATION', positionMode: 'HEDGE', side, leverage: '20', margin: '4.91', ctime: '2026-11-19T11:45:15.000Z', qty: '0.026', entryValue: '97.0359', symbol: 'XAUUSDT', realizedPNL: '0', unrealizedPNL: '0', funding: '0', fee: '0.04851795' } });
    expect(parseBitunixPrivateFrame(frame('SHORT'), new Date(), () => 1)[0]).toMatchObject({ channel: 'position', positionId: '403163326623575343', side: 'SHORT' });
  });
});
