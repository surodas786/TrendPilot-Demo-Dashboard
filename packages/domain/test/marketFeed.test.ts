// MKT-01/02 public feed rules: closed-candle detection, gaps, backoff, clock skew, book sanity.
import { describe, expect, it } from 'vitest';
import { backoffMs, candleRevised, clockOffsetMs, emaAtSignalBar, FEED_POLICY, fixtureCandles, isClosedBar, marketSourceLabel, missingBarRanges, newestClosedBarOpen, quoteAgeState, quoteProblem, toLocalTime } from '../src';

const M15 = 900_000;
const at = (s: string) => new Date(s);

describe('closed-candle detection (never a forming bar)', () => {
  it('accepts a bar only after its close plus the grace period on the exchange clock', () => {
    const open = at('2026-11-08T09:15:00Z');
    const close = open.getTime() + M15;
    expect(isClosedBar(open, '15', close - 1)).toBe(false); // still forming
    expect(isClosedBar(open, '15', close + FEED_POLICY.closeGraceMs - 1)).toBe(false); // just closed, not final yet
    expect(isClosedBar(open, '15', close + FEED_POLICY.closeGraceMs)).toBe(true);
  });

  it('newest closed bar open matches isClosedBar at every boundary', () => {
    const now = at('2026-11-08T09:30:02Z').getTime(); // 09:30 close not yet past grace
    expect(newestClosedBarOpen('15', now).toISOString()).toBe('2026-11-08T09:00:00.000Z');
    expect(newestClosedBarOpen('15', now + 1000).toISOString()).toBe('2026-11-08T09:15:00.000Z');
    expect(newestClosedBarOpen('5', now + 1000).toISOString()).toBe('2026-11-08T09:25:00.000Z');
    for (const t of [now, now + 1000, now + 450_000]) {
      const b = newestClosedBarOpen('15', t);
      expect(isClosedBar(b, '15', t)).toBe(true);
      expect(isClosedBar(new Date(b.getTime() + M15), '15', t)).toBe(false);
    }
  });
});

describe('gap detection', () => {
  const from = at('2026-11-08T08:00:00Z');
  const to = at('2026-11-08T09:15:00Z'); // 6 bars: 08:00 … 09:15
  const all = [0, 1, 2, 3, 4, 5].map((i) => from.getTime() + i * M15);

  it('finds nothing when every bar is present', () => {
    expect(missingBarRanges(all, '15', from, to)).toEqual([]);
  });

  it('merges contiguous missing bars into ranges, oldest first', () => {
    const have = [all[0]!, all[3]!, all[5]!];
    const r = missingBarRanges(have, '15', from, to);
    expect(r.map((g) => [g.from.toISOString(), g.to.toISOString(), g.bars])).toEqual([
      ['2026-11-08T08:15:00.000Z', '2026-11-08T08:30:00.000Z', 2],
      ['2026-11-08T09:00:00.000Z', '2026-11-08T09:00:00.000Z', 1]
    ]);
  });

  it('reports leading and trailing gaps', () => {
    const r = missingBarRanges([all[2]!], '15', from, to);
    expect(r.map((g) => g.bars)).toEqual([2, 3]);
  });
});

describe('clock skew and backoff', () => {
  it('measures the exchange offset from the round-trip midpoint and maps exchange time to local', () => {
    expect(clockOffsetMs(1_000, 1_600, 1_200)).toBe(500); // exchange 500 ms ahead
    expect(toLocalTime(10_500, 500).getTime()).toBe(10_000);
    expect(clockOffsetMs(1_000, 700, 1_200)).toBe(-400);
  });

  it('backs off exponentially with jitter and a ceiling', () => {
    expect(backoffMs(1, 0.5)).toBe(1_000);
    expect(backoffMs(2, 0.5)).toBe(2_000);
    expect(backoffMs(5, 0.5)).toBe(16_000);
    expect(backoffMs(30, 0.5)).toBe(FEED_POLICY.backoffMaxMs);
    expect(backoffMs(3, 0)).toBe(3_200);
    expect(backoffMs(3, 0.999)).toBeLessThanOrEqual(4_800);
  });
});

describe('quote checks', () => {
  it('rejects a crossed or non-positive book', () => {
    expect(quoteProblem({ bid: '100', ask: '100.1', mark: '100', last: '100' })).toBeNull();
    expect(quoteProblem({ bid: '100.2', ask: '100.1', mark: '100', last: '100' })).toMatch(/crossed/);
    expect(quoteProblem({ bid: '0', ask: '100.1', mark: '100', last: '100' })).toMatch(/bid/);
    expect(quoteProblem({ bid: '1', ask: '2', mark: 'x', last: '1' })).toMatch(/mark/);
  });

  it('judges freshness at read time', () => {
    const now = at('2026-11-08T10:00:00Z');
    expect(quoteAgeState(null, now)).toBe('NONE');
    expect(quoteAgeState(new Date(now.getTime() - 15_000), now)).toBe('FRESH');
    expect(quoteAgeState(new Date(now.getTime() - 15_001), now)).toBe('STALE');
  });

  it('detects a revised closed bar and labels sources', () => {
    const a = { open: '1', high: '2', low: '0.5', close: '1.5' };
    expect(candleRevised(a, { ...a, close: '1.50' })).toBe(false);
    expect(candleRevised(a, { ...a, close: '1.6' })).toBe(true);
    expect(marketSourceLabel('MEXC_PUBLIC')).toBe('MEXC public market data');
    expect(marketSourceLabel('FIXTURE')).toBe('Fixture (replay data)');
  });
});

describe('EMA input never mixes sources', () => {
  it('stops the consecutive run at a candle from another source', () => {
    const bar = at('2026-11-08T09:15:00Z');
    const cs = fixtureCandles({ endBarOpen: bar, intervalMs: M15, count: 260, endClose: '65000', trend: 'UP' }).map((c, i) => ({ ...c, source: i < 100 ? 'FIXTURE' : 'MEXC_PUBLIC' }));
    const r = emaAtSignalBar(cs, bar, M15);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.detail).toBe('INSUFFICIENT_HISTORY');
    expect(!r.ok && r.candlesAvailable).toBe(160);
    const same = cs.map((c) => ({ ...c, source: 'MEXC_PUBLIC' }));
    expect(emaAtSignalBar(same, bar, M15).ok).toBe(true);
  });
});
