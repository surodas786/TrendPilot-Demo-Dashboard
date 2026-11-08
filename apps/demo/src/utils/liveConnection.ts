import type { ConnectionTestOutcome } from '../types/platform';

export const TEST_MESSAGES: Record<ConnectionTestOutcome, string> = {
  success: 'Demo test passed. Futures connection simulated.',
  invalid: 'Demo test failed: invalid credentials.',
  'no-futures': 'Demo test failed: futures access unavailable.'
};

export const OUTCOME_LABELS: Record<ConnectionTestOutcome, string> = {
  success: 'Successful',
  invalid: 'Invalid credentials',
  'no-futures': 'Futures access unavailable'
};

export const DEMO_NOTE = 'Demo only. Use sample credentials. No exchange requests or real trades are made.';

const rand = (n: number) =>
Array.from({ length: n }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[Math.floor(Math.random() * 32)]).join('');

/** Clearly fictional sample credentials, generated locally. */
export function sampleCredentials(): {key: string;secret: string;} {
  return { key: `DEMO-MEXC-KEY-${rand(12)}`, secret: `demo-secret-not-real-${rand(24).toLowerCase()}` };
}

/** Only this masked label is kept after saving. */
export function maskKey(key: string): string {
  const k = key.trim();
  return `••••••••${k.slice(-4)}`;
}