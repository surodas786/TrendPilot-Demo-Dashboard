// Live entry gates (OPS-01/02): every opening order passes these; closes never do.
import { describe, expect, it } from 'vitest';
import { checkLiveEntry, keyFingerprint, liveAccountBlockers, LIVE_REFUSAL_TEXT, validateAccountRef, validateLiveLimits, type LiveConnectionState, type LiveControlState, type LiveEntryRequest } from '../src';

const control: LiveControlState = { transportEnabled: true, platformEnabled: true, platformEntriesHalted: false };
const conn: LiveConnectionState = {
  ownerId: 'u1',
  status: 'VERIFIED',
  positionMode: 'ONE_WAY',
  approved: true,
  liveEnabled: true,
  entriesHalted: false,
  limits: { maxOrderContracts: '20', maxOrderNotionalUsdt: '150', maxLeverage: 5, maxExposureUsdt: '200' }
};
// 15 contracts × 0.0001 × 65000 = 97.5 USDT
const req: LiveEntryRequest = { ownerId: 'u1', contractLiveAllowed: true, contracts: '15', price: '65000', multiplier: '0.0001', leverage: 5, hasStop: true, openContracts: '0' };

describe('checkLiveEntry', () => {
  it('passes when every gate is open', () => {
    expect(checkLiveEntry(control, conn, req)).toEqual({ ok: true });
  });

  it.each([
    ['LIVE_TRANSPORT_DISABLED', { control: { transportEnabled: false } }],
    ['LIVE_PLATFORM_DISABLED', { control: { platformEnabled: false } }],
    ['LIVE_PLATFORM_HALTED', { control: { platformEntriesHalted: true } }],
    ['LIVE_CONNECTION_MISSING', { conn: null }],
    ['LIVE_OWNERSHIP_MISMATCH', { conn: { ownerId: 'u2' } }],
    ['LIVE_CONNECTION_NOT_VERIFIED', { conn: { status: 'FAILED' } }],
    ['LIVE_POSITION_MODE', { conn: { positionMode: 'HEDGE' } }],
    ['LIVE_POSITION_MODE', { conn: { positionMode: null } }],
    ['LIVE_ACCOUNT_NOT_APPROVED', { conn: { approved: false } }],
    ['LIVE_ACCOUNT_NOT_APPROVED', { conn: { limits: null } }],
    ['LIVE_NOT_ACTIVATED', { conn: { liveEnabled: false } }],
    ['LIVE_ACCOUNT_HALTED', { conn: { entriesHalted: true } }],
    ['LIVE_CONTRACT_NOT_ALLOWED', { req: { contractLiveAllowed: false } }],
    ['LIVE_STOP_REQUIRED', { req: { hasStop: false } }],
    ['LIVE_ORDER_SIZE', { req: { contracts: '21' } }],
    ['LIVE_ORDER_NOTIONAL', { req: { price: '120000' } }],
    ['LIVE_LEVERAGE', { req: { leverage: 6 } }],
    ['LIVE_EXPOSURE', { req: { openContracts: '16' } }]
  ] as const)('refuses with %s', (reason, o: { control?: object; conn?: object | null; req?: object }) => {
    const c = o.conn === null ? null : { ...conn, ...(o.conn ?? {}) };
    const r = checkLiveEntry({ ...control, ...(o.control ?? {}) }, c, { ...req, ...(o.req ?? {}) });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toBe(reason);
  });
});

describe('One-way position mode', () => {
  it('Hedge mode blocks new entries with the One-way reason; an unverified connection is reported as that first', () => {
    expect(checkLiveEntry(control, { ...conn, positionMode: 'HEDGE' }, req)).toEqual({ ok: false, reason: 'LIVE_POSITION_MODE', detail: { positionMode: 'HEDGE' } });
    expect(LIVE_REFUSAL_TEXT.LIVE_POSITION_MODE).toMatch(/^One-way position mode required/);
    expect(liveAccountBlockers(control, { ...conn, status: 'FAILED', positionMode: 'HEDGE' }, 'u1', true).map((b) => b.reason)).toEqual(['LIVE_CONNECTION_NOT_VERIFIED']);
  });

  it('lists every blocker in gate order, so an operator halt does not hide the position mode', () => {
    const halted = { ...control, platformEntriesHalted: true, platformHaltReason: 'verification' };
    expect(liveAccountBlockers(halted, { ...conn, positionMode: 'HEDGE' }, 'u1', true).map((b) => b.reason)).toEqual(['LIVE_PLATFORM_HALTED', 'LIVE_POSITION_MODE']);
    expect(checkLiveEntry(halted, { ...conn, positionMode: 'HEDGE' }, req)).toMatchObject({ ok: false, reason: 'LIVE_PLATFORM_HALTED' });
    expect(liveAccountBlockers(control, conn, 'u1', true)).toEqual([]);
  });
});

describe('Live limits and account references', () => {
  it('validates limits', () => {
    expect(validateLiveLimits({ maxOrderContracts: '2', maxOrderNotionalUsdt: '20', maxLeverage: 3, maxExposureUsdt: '20' })).toEqual([]);
    expect(validateLiveLimits({ maxOrderContracts: '0', maxOrderNotionalUsdt: 'x', maxLeverage: 0, maxExposureUsdt: '20' })).toHaveLength(3);
    expect(validateLiveLimits({ maxOrderContracts: '2', maxOrderNotionalUsdt: '50', maxLeverage: 3, maxExposureUsdt: '20' })).toEqual(['maxExposureUsdt must be at least maxOrderNotionalUsdt']);
  });

  it('refuses anything that looks like a key as an account reference', () => {
    expect(validateAccountRef('UID …4821')).toBeNull();
    expect(validateAccountRef('mx0vglAbCdEf')).not.toBeNull();
    expect(validateAccountRef('a'.repeat(32))).not.toBeNull();
    expect(validateAccountRef(' ')).not.toBeNull();
  });

  it('shows only the last four characters of a key', () => {
    expect(keyFingerprint('mx0vglTESTKEY1234')).toBe('…1234');
  });
});
