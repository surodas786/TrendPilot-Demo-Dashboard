import type { ContractSpec, Quote } from '@trendpilot/domain';

/**
 * LOCAL MEXC FUTURES CONTRACT FIXTURES — illustrative values for development and tests.
 * They are NOT verified against the live exchange and must never drive live orders.
 * An admin "validates" a ticker against this catalog until the M4 adapter exists.
 */
export const FIXTURE_LABEL = 'Local MEXC contract fixture — not verified against the live exchange';

export interface MexcContractFixture extends ContractSpec {
  symbol: string;
  exchangeSymbol: string;
  base: string;
  quote: 'USDT';
  maxLeverage: number;
}

const c = (symbol: string, base: string, f: Omit<MexcContractFixture, 'symbol' | 'exchangeSymbol' | 'base' | 'quote' | 'takerFeeRate'>): MexcContractFixture => ({
  symbol,
  exchangeSymbol: `${base}_USDT`,
  base,
  quote: 'USDT',
  takerFeeRate: '0.0004',
  ...f
});

export const MEXC_CONTRACT_FIXTURES: MexcContractFixture[] = [
  c('BTCUSDT', 'BTC', { contractMultiplier: '0.0001', qtyStep: '1', minQty: '1', maxQty: '1000000', priceTick: '0.1', maxLeverage: 100 }),
  c('ETHUSDT', 'ETH', { contractMultiplier: '0.01', qtyStep: '1', minQty: '1', maxQty: '1000000', priceTick: '0.01', maxLeverage: 50 }),
  c('SOLUSDT', 'SOL', { contractMultiplier: '0.1', qtyStep: '1', minQty: '1', maxQty: '500000', priceTick: '0.001', maxLeverage: 20 }),
  c('XRPUSDT', 'XRP', { contractMultiplier: '10', qtyStep: '1', minQty: '1', maxQty: '500000', priceTick: '0.0001', maxLeverage: 10 }),
  c('DOGEUSDT', 'DOGE', { contractMultiplier: '100', qtyStep: '1', minQty: '1', maxQty: '500000', priceTick: '0.00001', maxLeverage: 10 })
];

/** Fixture top-of-book used by order previews. Static, labelled, never "live". */
export const FIXTURE_QUOTES: Record<string, Omit<Quote, 'asOf' | 'source'>> = {
  BTCUSDT: { bid: '64990.5', ask: '65000.0', mark: '64995.2' },
  ETHUSDT: { bid: '3199.89', ask: '3200.11', mark: '3200.02' },
  SOLUSDT: { bid: '149.981', ask: '150.019', mark: '150.004' },
  XRPUSDT: { bid: '0.6199', ask: '0.6201', mark: '0.6200' },
  DOGEUSDT: { bid: '0.14995', ask: '0.15005', mark: '0.15001' }
};

const LEVERAGE_STEPS = [1, 2, 3, 5, 10, 20, 25, 50, 75, 100, 125, 200];
export const leverageChoicesFor = (maxLeverage: number, minLeverage = 1) => LEVERAGE_STEPS.filter((x) => x >= minLeverage && x <= maxLeverage);

export function lookupFixtureContract(symbol: string): MexcContractFixture | undefined {
  return MEXC_CONTRACT_FIXTURES.find((x) => x.symbol === symbol.trim().toUpperCase());
}

export function fixtureQuote(symbol: string, now = new Date()): Quote | undefined {
  const q = FIXTURE_QUOTES[symbol];
  return q && { ...q, asOf: now.toISOString(), source: 'FIXTURE' };
}
