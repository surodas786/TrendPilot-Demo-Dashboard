// SIG-02/03 payload and timing rules; per-investor screening (SIG-05, CFG-04, STR-08 subset).
import { describe, expect, it } from 'vitest';
import { assessTiming, buildTradingViewPayload, evaluateBlockForSignal, lastClosedBarOpen, parseWith, tradingViewPayloadSchema, type BlockEvaluationInput } from '../src';

const BAR = new Date('2026-11-08T09:15:00Z'); // Sunday 15:15 in Asia/Dhaka
const CLOSE = new Date('2026-11-08T09:30:00Z');
const at = (s: number) => new Date(CLOSE.getTime() + s * 1000);

const payload = (o: Record<string, unknown> = {}) => ({
  ...buildTradingViewPayload({ action: 'BULLISH_FLIP', exchange: 'MEXC', symbol: 'BTCUSDT.P', interval: '15', barOpen: BAR, firedAt: at(1), referencePrice: '65000.5' }),
  ...o
});

describe('SIG-02 exact payload', () => {
  it('builds the template keys in order with TradingView time format', () => {
    expect(Object.keys(payload())).toEqual(['action', 'source_exchange', 'source_symbol', 'interval', 'bar_open_utc', 'alert_fired_utc', 'reference_price']);
    expect(payload().bar_open_utc).toBe('2026-11-08T09:15:00Z');
  });

  it('accepts the exact bullish and bearish messages', () => {
    expect(parseWith(tradingViewPayloadSchema, payload()).ok).toBe(true);
    expect(parseWith(tradingViewPayloadSchema, payload({ action: 'BEARISH_FLIP' })).ok).toBe(true);
  });

  it.each([
    ['unresolved placeholder', { source_symbol: '{{ticker}}' }, 'source_symbol'],
    ['unknown action', { action: 'BUY' }, 'action'],
    ['unsupported interval', { interval: '60' }, 'interval'],
    ['numeric interval', { interval: 15 }, 'interval'],
    ['non-UTC timestamp', { bar_open_utc: '2026-11-08T15:15:00+06:00' }, 'bar_open_utc'],
    ['epoch timestamp', { alert_fired_utc: '1762593001000' }, 'alert_fired_utc'],
    ['negative price', { reference_price: '-1' }, 'reference_price'],
    ['zero price', { reference_price: '0' }, 'reference_price'],
    ['extra investor field', { investor_id: 'abc' }, '']
  ])('rejects %s', (_n, o, path) => {
    const r = parseWith(tradingViewPayloadSchema, payload(o));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues.map((i) => i.path)).toContain(path);
  });

  it('rejects a missing field', () => {
    const p: Record<string, unknown> = payload();
    delete p.reference_price;
    expect(parseWith(tradingViewPayloadSchema, p).ok).toBe(false);
  });
});

describe('SIG-03 timing', () => {
  const policy = { maxSignalAgeSeconds: 120, clockToleranceSeconds: 5 };
  const parse = (o: Record<string, unknown> = {}) => tradingViewPayloadSchema.parse(payload(o));

  it('derives the bar close from bar open + interval and keeps all four times', () => {
    const r = assessTiming(parse(), at(3), policy);
    expect(r.ok && r.times).toEqual({ barOpenAt: BAR, barCloseAt: CLOSE, alertFiredAt: at(1), receivedAt: at(3) });
  });

  it.each([
    ['MISALIGNED_BAR', { bar_open_utc: '2026-11-08T09:16:00Z' }, at(3)],
    ['PRE_CLOSE', { alert_fired_utc: '2026-11-08T09:29:00Z' }, at(3)],
    ['FUTURE_TIMESTAMP', { alert_fired_utc: '2026-11-08T09:31:00Z' }, at(3)],
    ['FUTURE_TIMESTAMP', {}, new Date('2026-11-08T09:29:00Z')],
    ['SIGNAL_STALE', {}, at(121)]
  ])('%s', (reason, o, receivedAt) => {
    const r = assessTiming(parse(o), receivedAt, policy);
    expect(r.ok ? 'OK' : r.reason).toBe(reason);
  });

  it('allows clock skew within tolerance and the boundary of max age', () => {
    expect(assessTiming(parse({ alert_fired_utc: '2026-11-08T09:29:57Z' }), at(1), policy).ok).toBe(true);
    expect(assessTiming(parse(), at(120), policy).ok).toBe(true);
  });

  it('finds the most recently closed bar', () => {
    expect(lastClosedBarOpen(new Date('2026-11-08T09:31:10Z'), '15')).toEqual(BAR);
    expect(lastClosedBarOpen(new Date('2026-11-08T09:31:10Z'), '5')).toEqual(new Date('2026-11-08T09:25:00Z'));
  });
});

describe('per-investor screening', () => {
  const base: BlockEvaluationInput = {
    action: 'BULLISH_FLIP',
    interval: '15',
    barCloseAt: CLOSE,
    evaluatedAt: at(5),
    user: { status: 'ACTIVE' },
    block: { status: 'ACTIVE', mode: 'PAPER', direction: 'BOTH', weekdays: ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'], timezone: 'Asia/Dhaka' },
    version: { timeframe: '15m', permittedDirections: 'BOTH', signalMaxAgeSeconds: 120 }
  };
  type Overrides = Omit<Partial<BlockEvaluationInput>, 'block' | 'version'> & { block?: Partial<BlockEvaluationInput['block']>; version?: Partial<BlockEvaluationInput['version']> };
  const ev = (o: Overrides = {}) =>
    evaluateBlockForSignal({ ...base, ...o, block: { ...base.block, ...o.block }, version: { ...base.version, ...o.version } } as BlockEvaluationInput);

  it('an active matching block is READY_FOR_EVALUATION (not an approved entry)', () => {
    expect(ev()).toMatchObject({ status: 'READY_FOR_EVALUATION', reason: null, side: 'LONG', failed: [] });
  });

  it.each([
    ['PAUSED', { block: { status: 'PAUSED' } }],
    ['DIRECTION_DISABLED', { block: { direction: 'SHORT_ONLY' } }],
    ['DIRECTION_DISABLED', { version: { permittedDirections: 'SHORT_ONLY' } }],
    ['DAY_DISABLED', { block: { weekdays: ['MON', 'TUE'] } }],
    ['DAY_DISABLED', { block: { weekdays: [] } }],
    ['SIGNAL_STALE', { evaluatedAt: at(121) }],
    ['STRATEGY_MISMATCH', { version: { timeframe: '5m' } }],
    ['ACCOUNT_SUSPENDED', { user: { status: 'SUSPENDED' } }],
    ['LIVE_DISABLED', { block: { mode: 'LIVE' } }],
    ['NO_MANAGED_POSITION', { action: 'CLOSE_LONG' }]
  ] as const)('skips with %s', (reason, o) => {
    const r = ev(o as never);
    expect(r.status).toBe('SKIPPED');
    expect(r.failed).toContain(reason);
  });

  it('reports the first failure in a fixed order but lists them all', () => {
    const r = ev({ block: { status: 'PAUSED', direction: 'SHORT_ONLY' } });
    expect(r.reason).toBe('PAUSED');
    expect(r.failed).toEqual(['PAUSED', 'DIRECTION_DISABLED']);
  });

  it('a bearish flip evaluates the short side', () => {
    expect(ev({ action: 'BEARISH_FLIP' })).toMatchObject({ side: 'SHORT', status: 'READY_FOR_EVALUATION' });
    expect(ev({ action: 'BEARISH_FLIP', block: { direction: 'LONG_ONLY' } }).reason).toBe('DIRECTION_DISABLED');
  });
});
