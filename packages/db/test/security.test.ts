// IAM-01 MFA primitives and OPS-01 secret sealing.
import { describe, expect, it } from 'vitest';
import { base32Decode, base32Encode, newTotpSecret, otpauthUri, timeStep, totpAt, verifyTotp } from '../src/security/totp';
import { open, seal } from '../src/security/secretBox';
import { leverageChoicesFor, lookupFixtureContract, MEXC_CONTRACT_FIXTURES } from '../src/mexcFixtures';

describe('TOTP (RFC 6238)', () => {
  // RFC 6238 Appendix B, SHA-1 seed "12345678901234567890"; we use 6 digits (the last 6 of the 8-digit vectors).
  const rfcSecret = base32Encode(Buffer.from('12345678901234567890'));
  it.each([
    [59, '287082'],
    [1111111109, '081804'],
    [1234567890, '005924'],
    [2000000000, '279037']
  ])('matches the RFC vector at t=%i', (t, code) => {
    expect(totpAt(rfcSecret, Math.floor(t / 30))).toBe(code);
  });

  it('round-trips base32', () => {
    const buf = Buffer.from('any bytes ÿ\u0000', 'latin1');
    expect(base32Decode(base32Encode(buf))).toEqual(buf);
  });

  it('accepts ±1 step and rejects older or replayed steps', () => {
    const s = newTotpSecret();
    const now = Date.now();
    const step = timeStep(now);
    expect(verifyTotp(s, totpAt(s, step), now)).toBe(step);
    expect(verifyTotp(s, totpAt(s, step - 1), now)).toBe(step - 1);
    expect(verifyTotp(s, totpAt(s, step - 3), now)).toBeNull();
    expect(verifyTotp(s, totpAt(s, step), now, step)).toBeNull(); // replay of the accepted step
    expect(verifyTotp(s, 'abcdef', now)).toBeNull();
  });

  it('builds an otpauth URI for authenticator apps', () => {
    expect(otpauthUri('ABC', 'a@b.c')).toMatch(/^otpauth:\/\/totp\/TrendPilot%3Aa%40b\.c\?secret=ABC&issuer=TrendPilot/);
  });
});

describe('secretBox', () => {
  it('seals with a random IV and opens back', () => {
    const a = seal('JBSWY3DPEHPK3PXP');
    const b = seal('JBSWY3DPEHPK3PXP');
    expect(a).not.toBe(b);
    expect(a).not.toContain('JBSWY3DPEHPK3PXP');
    expect(open(a)).toBe('JBSWY3DPEHPK3PXP');
  });

  it('rejects tampering', () => {
    const s = seal('secret');
    const parts = s.split('.');
    const ct = Buffer.from(parts[3]!, 'base64url');
    ct[0] = ct[0]! ^ 1;
    parts[3] = ct.toString('base64url');
    expect(() => open(parts.join('.'))).toThrow();
  });
});

describe('local MEXC contract fixtures', () => {
  it('looks up tickers case-insensitively and exposes contract specs', () => {
    expect(lookupFixtureContract('btcusdt')).toMatchObject({ symbol: 'BTCUSDT', exchangeSymbol: 'BTC_USDT', contractMultiplier: '0.0001' });
    expect(lookupFixtureContract('NOPEUSDT')).toBeUndefined();
    expect(MEXC_CONTRACT_FIXTURES.length).toBeGreaterThanOrEqual(3);
  });

  it('derives leverage choices from the maximum', () => {
    expect(leverageChoicesFor(10)).toEqual([1, 2, 3, 5, 10]);
    expect(leverageChoicesFor(100)).toContain(100);
  });
});
