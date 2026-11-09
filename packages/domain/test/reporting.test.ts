// REP-02/03/04 reporting rules: reporting-day bounds, unrealized and funding signs, funding status.
import { describe, expect, it } from 'vitest';
import { fundingAmount, fundingSettlementsBetween, fundingStatus, localDate, netRealized, reportingDayWindow, tzOffsetMs, unrealizedPnl } from '../src';

describe('reporting day (Asia/Dhaka, UTC+6, no DST)', () => {
  it('a local day runs from 18:00 UTC the previous day to 18:00 UTC', () => {
    const w = reportingDayWindow('2026-11-08', 'Asia/Dhaka');
    expect(w.from.toISOString()).toBe('2026-11-07T18:00:00.000Z');
    expect(w.to.toISOString()).toBe('2026-11-08T18:00:00.000Z');
    expect(tzOffsetMs(new Date('2026-11-08T09:30:00Z'), 'Asia/Dhaka')).toBe(6 * 3_600_000);
  });

  it('attributes instants either side of local midnight to different days', () => {
    expect(localDate(new Date('2026-11-08T17:59:59Z'), 'Asia/Dhaka')).toBe('2026-11-08');
    expect(localDate(new Date('2026-11-08T18:00:00Z'), 'Asia/Dhaka')).toBe('2026-11-09');
  });

  it('handles a DST timezone (23- and 25-hour days)', () => {
    const spring = reportingDayWindow('2026-03-08', 'America/New_York');
    expect((spring.to.getTime() - spring.from.getTime()) / 3_600_000).toBe(23);
    const fall = reportingDayWindow('2026-11-01', 'America/New_York');
    expect((fall.to.getTime() - fall.from.getTime()) / 3_600_000).toBe(25);
    expect(() => reportingDayWindow('2026-13-01', 'Asia/Dhaka')).toThrow();
  });
});

describe('P&L and funding amounts', () => {
  it('unrealized P&L on the mark for Long and Short', () => {
    expect(unrealizedPnl('LONG', '65000', '65650', '153', '0.0001')).toBe('9.945');
    expect(unrealizedPnl('SHORT', '65000', '65650', '38', '0.0001')).toBe('-2.47');
  });

  it('a positive rate: Longs pay (negative), Shorts receive (positive)', () => {
    expect(fundingAmount('LONG', '153', '0.0001', '65000', '0.0001')).toEqual({ notional: '994.5', amount: '-0.09945' });
    expect(fundingAmount('SHORT', '153', '0.0001', '65000', '0.0001')).toEqual({ notional: '994.5', amount: '0.09945' });
    expect(fundingAmount('LONG', '153', '0.0001', '65000', '-0.0002').amount).toBe('0.1989');
  });

  it('settlements every 8 hours on UTC boundaries', () => {
    const s = fundingSettlementsBetween(new Date('2026-11-07T18:00:00Z'), new Date('2026-11-08T18:00:00Z'));
    expect(s.map((d) => d.toISOString())).toEqual(['2026-11-08T00:00:00.000Z', '2026-11-08T08:00:00.000Z', '2026-11-08T16:00:00.000Z']);
  });

  it('nothing due is a recorded zero; due but unknown is unavailable', () => {
    expect(fundingStatus(0, 0)).toBe('NONE_DUE');
    expect(fundingStatus(2, 2)).toBe('RECORDED');
    expect(fundingStatus(2, 1)).toBe('INCOMPLETE');
    expect(fundingStatus(2, 0)).toBe('UNAVAILABLE');
    expect(netRealized('12.5', '0.8', '-0.1')).toBe('11.6');
  });
});
