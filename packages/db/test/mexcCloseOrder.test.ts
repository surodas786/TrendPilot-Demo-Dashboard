// The single MEXC close-order serializer and the rejection classifier (incident 14 Nov 2026:
// XAU_USDT trailing take profit, CLOSE SHORT 12 contracts, MEXC 2001 on every attempt).
import { describe, expect, it } from 'vitest';
import { buildMexcCloseOrder, classifyCloseRejection, exitHaltText, type MexcCloseInput } from '../src';

const base = (o: Partial<MexcCloseInput> = {}): MexcCloseInput => ({
  symbol: 'XAU_USDT',
  clientOrderId: '0123456789abcdef0123456789abcdef',
  positionSide: 'SHORT',
  accountMode: 'ONE_WAY',
  exchangePosition: { positionId: '771234567', side: 'SHORT', contracts: '12', marginMode: 'ISOLATED' },
  contracts: '12',
  qtyStep: '1',
  quote: { bid: '4049.9', ask: '4050.1' },
  ...o
});

describe('buildMexcCloseOrder: exact serialized request', () => {
  it('Short, one-way, isolated: close-short side 2, reduceOnly, positionMode 2, MEXC positionId, contracts', () => {
    const r = buildMexcCloseOrder(base());
    expect(r).toEqual({
      ok: true,
      vol: '12',
      body: { symbol: 'XAU_USDT', price: '4050.1', vol: '12', side: 2, type: 5, openType: 1, externalOid: '0123456789abcdef0123456789abcdef', positionId: 771234567, reduceOnly: true, positionMode: 2 }
    });
    // Key order is part of the signed JSON body: keep it stable.
    expect(JSON.stringify((r as { body: object }).body)).toBe(
      '{"symbol":"XAU_USDT","price":"4050.1","vol":"12","side":2,"type":5,"openType":1,"externalOid":"0123456789abcdef0123456789abcdef","positionId":771234567,"reduceOnly":true,"positionMode":2}'
    );
  });

  it('Long, one-way: close-long side 4 at the bid', () => {
    const r = buildMexcCloseOrder(base({ positionSide: 'LONG', exchangePosition: { positionId: '5', side: 'LONG', contracts: '1540', marginMode: 'ISOLATED' }, contracts: '1540' }));
    expect(r).toMatchObject({ ok: true, body: { side: 4, price: '4049.9', vol: '1540', reduceOnly: true, positionMode: 2, positionId: 5 } });
  });

  for (const side of ['LONG', 'SHORT'] as const) {
    it(`${side}, hedge: close side, positionMode 1, no reduceOnly (documented for one-way only)`, () => {
      const r = buildMexcCloseOrder(base({ positionSide: side, accountMode: 'HEDGE', exchangePosition: { positionId: '9', side, contracts: '12', marginMode: 'ISOLATED' } }));
      expect(r.ok && r.body).toMatchObject({ side: side === 'LONG' ? 4 : 2, positionMode: 1 });
      expect(r.ok && 'reduceOnly' in r.body).toBe(false);
    });
  }

  it('margin mode comes from the exchange position, not TrendPilot: cross → openType 2', () => {
    expect(buildMexcCloseOrder(base({ exchangePosition: { positionId: '9', side: 'SHORT', contracts: '12', marginMode: 'CROSS' } }))).toMatchObject({ ok: true, body: { openType: 2 } });
  });

  it('never closes more than MEXC holds and rounds down to the quantity step (cannot open the other side)', () => {
    expect(buildMexcCloseOrder(base({ contracts: '20' }))).toMatchObject({ ok: true, vol: '12' });
    expect(buildMexcCloseOrder(base({ contracts: '7.9' }))).toMatchObject({ ok: true, vol: '7' });
    expect(buildMexcCloseOrder(base({ exchangePosition: { positionId: '9', side: 'SHORT', contracts: '0', marginMode: 'ISOLATED' } }))).toMatchObject({ ok: false, reason: 'REDUCE_ONLY_NO_POSITION' });
  });

  it('refuses when the exchange position is on the other side or has no usable ID (nothing is sent)', () => {
    expect(buildMexcCloseOrder(base({ exchangePosition: { positionId: '9', side: 'LONG', contracts: '12', marginMode: 'ISOLATED' } }))).toMatchObject({ ok: false, reason: 'CLOSE_POSITION_MISMATCH:SIDE' });
    expect(buildMexcCloseOrder(base({ exchangePosition: { positionId: 'undefined', side: 'SHORT', contracts: '12', marginMode: 'ISOLATED' } }))).toMatchObject({ ok: false, reason: 'CLOSE_POSITION_MISMATCH:POSITION_ID' });
  });

  it('the externalOid is the stored client order ID unchanged (≤ 32 characters)', () => {
    const r = buildMexcCloseOrder(base());
    expect(r.ok && String(r.body.externalOid).length).toBeLessThanOrEqual(32);
  });
});

describe('classifyCloseRejection', () => {
  it('2001 and other request errors are deterministic: never retried automatically', () => {
    for (const r of ['MEXC_2001', 'MEXC_2002', 'MEXC_2022', 'MEXC_600', 'MEXC_2015', 'MEXC_2030', 'CLIENT_ORDER_ID_TOO_LONG', 'CAPABILITY_UNVERIFIED:REDUCE_ONLY_CLOSE', 'CLOSE_POSITION_MISMATCH:SIDE'])
      expect(classifyCloseRejection(r)).toBe('DETERMINISTIC');
  });
  it('a missing position is reconciled from exchange state, not retried', () => {
    for (const r of ['MEXC_2008', 'MEXC_2009', 'REDUCE_ONLY_NO_POSITION']) expect(classifyCloseRejection(r)).toBe('POSITION_GONE');
  });
  it('rate limits and unavailability are transient (spaced, capped)', () => {
    for (const r of ['MEXC_510', 'VENUE_UNAVAILABLE: x', 'MEXC_NETWORK']) expect(classifyCloseRejection(r)).toBe('TRANSIENT');
  });
  it('2001 has an actionable message for the investor', () => {
    expect(exitHaltText('MEXC_2001 on TRAILING_TAKE_PROFIT abc')).toMatch(/2001.*paused.*stop loss is still in place/s);
  });
});
