// Step 12 pilot rules: allowlist, approval + activation, halt, limits, adds/reversal off.
import { describe, expect, it } from 'vitest';
import { checkPilotEntry, pilotBlockIssues, validatePilotLimits, type PilotScope } from '../src';

const scope = (o: Partial<PilotScope> = {}): PilotScope => ({
  status: 'ACTIVE',
  investorId: 'inv-a',
  instrumentId: 'btc',
  exchangeAccountRef: 'UID …4821',
  limits: { maxOrderContracts: '15', maxOrderNotionalUsdt: '110', maxLeverage: 5, maxExposureUsdt: '110' },
  allowAdds: false,
  allowReversal: false,
  approvedAt: new Date(),
  investorActivatedAt: new Date(),
  entriesHalted: false,
  haltReason: null,
  ...o
});
const req = { investorId: 'inv-a', instrumentId: 'btc', contracts: '15', price: '65000', multiplier: '0.0001', leverage: 5, hasStop: true, openContracts: '0' };

describe('pilot entry rules', () => {
  it('admits an in-scope entry with its stop', () => expect(checkPilotEntry(scope(), req)).toEqual({ ok: true }));

  it.each([
    ['no pilot', null, req, 'PILOT_NOT_ACTIVE'],
    ['draft (no platform approval)', scope({ status: 'DRAFT', approvedAt: null }), req, 'PILOT_NOT_APPROVED'],
    ['approved but not activated by the investor', scope({ status: 'APPROVED', investorActivatedAt: null }), req, 'PILOT_INVESTOR_NOT_ACTIVATED'],
    ['ended', scope({ status: 'ENDED' }), req, 'PILOT_NOT_ACTIVE'],
    ['entries halted', scope({ entriesHalted: true, haltReason: 'operator' }), req, 'PILOT_ENTRIES_HALTED'],
    ['another investor', scope(), { ...req, investorId: 'inv-b' }, 'PILOT_INVESTOR_NOT_ALLOWLISTED'],
    ['another contract', scope(), { ...req, instrumentId: 'eth' }, 'PILOT_CONTRACT_NOT_ALLOWLISTED'],
    ['no stop', scope(), { ...req, hasStop: false }, 'PILOT_STOP_REQUIRED'],
    ['an add to an open position', scope(), { ...req, openContracts: '3' }, 'PILOT_ADDS_DISABLED'],
    ['too many contracts', scope(), { ...req, contracts: '16' }, 'PILOT_ORDER_SIZE'],
    ['too much notional', scope({ limits: { ...scope().limits, maxOrderNotionalUsdt: '90' } }), req, 'PILOT_ORDER_NOTIONAL'],
    ['too much leverage', scope(), { ...req, leverage: 6 }, 'PILOT_LEVERAGE']
  ] as const)('refuses %s', (_n, p, r, reason) => {
    const v = checkPilotEntry(p as PilotScope | null, r);
    expect(v.ok).toBe(false);
    expect(!v.ok && v.reason).toBe(reason);
  });

  it('validates operator limits', () => {
    expect(validatePilotLimits(scope().limits)).toEqual([]);
    expect(validatePilotLimits({ maxOrderContracts: '0', maxOrderNotionalUsdt: 'x', maxLeverage: 50, maxExposureUsdt: '10' }).length).toBeGreaterThanOrEqual(3);
    expect(validatePilotLimits({ maxOrderContracts: '1', maxOrderNotionalUsdt: '100', maxLeverage: 2, maxExposureUsdt: '50' })).toEqual(['maxExposureUsdt must be at least maxOrderNotionalUsdt']);
  });

  it('refuses order blocks with adds, automatic reversal, excess leverage or another contract', () => {
    const p = scope();
    expect(pilotBlockIssues({ allowAdds: false, leverage: 5, instrumentId: 'btc' }, { oppositePolicy: 'KEEP_OPEN' }, p)).toEqual([]);
    const issues = pilotBlockIssues({ allowAdds: true, leverage: 10, instrumentId: 'eth' }, { oppositePolicy: 'CLOSE_AND_REVERSE' }, p);
    expect(issues).toHaveLength(4);
  });
});
