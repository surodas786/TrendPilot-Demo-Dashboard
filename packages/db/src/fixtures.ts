/**
 * Deterministic fixture data (SRS §1.3, §14). Fictional people; contract metadata comes
 * from the local MEXC contract fixture catalog (mexcFixtures.ts), NOT the live exchange.
 */

export const FIXTURE_USERS = {
  admin: { email: 'admin@trendpilot.local', name: 'Platform Administrator', role: 'ADMIN' as const },
  investorA: { email: 'investor.a@trendpilot.local', name: 'Nadia Rahman', role: 'INVESTOR' as const },
  investorB: { email: 'investor.b@trendpilot.local', name: 'Omar Siddiqui', role: 'INVESTOR' as const }
};

export const FIXTURE_IDS = {
  package: '7c1e0d4a-0000-4000-8000-000000000001',
  version: '7c1e0d4a-0000-4000-8000-000000000101',
  /** Test-only package/version approved for BTCUSDT and ETHUSDT. */
  testPackage: '7c1e0d4a-0000-4000-8000-000000000002',
  testVersion: '7c1e0d4a-0000-4000-8000-000000000201',
  instruments: {
    BTCUSDT: '5a9f3b2c-0000-4000-8000-000000000001',
    /** Test-only contracts, never part of the development seed. */
    ETHUSDT: '5a9f3b2c-0000-4000-8000-000000000002',
    XRPUSDT: '5a9f3b2c-0000-4000-8000-000000000004'
  }
};

/** A pair the admin has approved: fixture contract symbol plus suggested exits. */
export interface FixtureInstrument {
  symbol: keyof typeof FIXTURE_IDS.instruments;
  status: 'PUBLISHED' | 'DISABLED';
  stop: string;
  tp: string;
  trailingEnabled: boolean;
  trailing: string;
}

/**
 * Development seed: exactly one approved MEXC Futures contract (BTCUSDT perpetual).
 * Suggested exits mirror the MagicPatterns demo pair defaults (illustrative only).
 */
export const FIXTURE_INSTRUMENTS: FixtureInstrument[] = [{ symbol: 'BTCUSDT', status: 'PUBLISHED', stop: '1.5', tp: '3', trailingEnabled: true, trailing: '1' }];

/** Extra contracts used only by automated tests (catalog validation, disabled pairs). */
export const TEST_ONLY_INSTRUMENTS: FixtureInstrument[] = [
  { symbol: 'ETHUSDT', status: 'PUBLISHED', stop: '2', tp: '4', trailingEnabled: true, trailing: '1.5' },
  { symbol: 'XRPUSDT', status: 'DISABLED', stop: '3', tp: '6', trailingEnabled: false, trailing: '2' }
];

/** SRS §13 paper fixture: confirmed 15m bars, ATR 10, factor 3, EMA Off, KEEP_OPEN. */
export const FIXTURE_STRATEGY = {
  packageName: 'Supertrend 15m — paper fixture',
  version: 1,
  timeframe: '15m' as const,
  atrLength: 10,
  atrFactor: '3',
  permittedDirections: 'BOTH' as const,
  emaFilter: 'OFF' as const,
  oppositePolicy: 'KEEP_OPEN' as const,
  signalMaxAgeSeconds: 120,
  maxPriceDeviationPct: '0.5'
};

/**
 * TradingView fixture: the chart an admin's alerts come from. {{exchange}} and {{ticker}} as
 * TradingView renders them for the MEXC BTCUSDT perpetual chart.
 */
export const FIXTURE_SIGNAL_SOURCE = {
  ingressNamespace: 'tradingview-main',
  ingressName: 'TradingView (development)',
  sourceExchange: 'MEXC',
  sourceSymbol: 'BTCUSDT.P',
  interval: '15' as const,
  maxSignalAgeSeconds: 120,
  clockToleranceSeconds: 5
};
