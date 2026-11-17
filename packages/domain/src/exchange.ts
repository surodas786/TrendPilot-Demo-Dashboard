/**
 * Exchanges TrendPilot can connect to, and the symbol rules for each. Pure; no I/O.
 *
 * Three symbols exist for one contract and are kept apart on purpose:
 *  - the TradingView SOURCE symbol in an alert (`BTCUSDT.P`, `BITUNIX:BTCUSDT.P`), matched by a
 *    signal route to a platform instrument;
 *  - the platform symbol (`BTCUSDT`), shown to people;
 *  - the exchange EXECUTION symbol the exchange API takes (MEXC `BTC_USDT`, Bitunix `BTCUSDT`).
 */

export const EXCHANGES = ['MEXC', 'BITUNIX', 'LIGHTER'] as const;
export type ExchangeId = (typeof EXCHANGES)[number];

export const EXCHANGE_LABEL: Record<ExchangeId, string> = { MEXC: 'MEXC', BITUNIX: 'Bitunix', LIGHTER: 'Lighter' };

/** Display name for any stored exchange value ("Bitunix", "Lighter"); unknown values are shown as stored. */
export const exchangeLabel = (exchange: string | null | undefined): string => (exchange && isExchangeId(exchange) ? EXCHANGE_LABEL[exchange] : (exchange ?? ''));

/**
 * Exchanges TrendPilot can connect to and trade on. Lighter is registered for market discovery and
 * pair selection only (Step 1 of the Lighter plan): no connection, no prices, no orders. Every Live
 * and connection path refuses an exchange that is not listed here, instead of treating it as MEXC.
 */
export const TRADABLE_EXCHANGES = ['MEXC', 'BITUNIX'] as const satisfies readonly ExchangeId[];
export type TradableExchangeId = (typeof TRADABLE_EXCHANGES)[number];
export const isTradableExchange = (v: unknown): v is TradableExchangeId => typeof v === 'string' && (TRADABLE_EXCHANGES as readonly string[]).includes(v);

/** Why an exchange cannot be connected or traded yet, or null when it can. */
export function exchangeUnavailableReason(exchange: string | null | undefined): string | null {
  if (isTradableExchange(exchange)) return null;
  if (exchange === 'LIGHTER') return 'Lighter trading is not available yet: Lighter markets can be published and selected, but connecting a Lighter account, prices and orders come in a later release.';
  return `Exchange ${exchange ?? '(none)'} is not supported.`;
}

export const isExchangeId = (v: unknown): v is ExchangeId => typeof v === 'string' && (EXCHANGES as readonly string[]).includes(v);

/** Request input → exchange. Missing means MEXC (every record and client from before Bitunix). */
export function parseExchangeId(v: unknown): ExchangeId | null {
  if (v === undefined || v === null || v === '') return 'MEXC';
  const s = typeof v === 'string' ? v.trim().toUpperCase() : '';
  return isExchangeId(s) ? s : null;
}

/** Bitunix Futures symbol format: base + USDT, no separator (BTCUSDT, XAUUSDT). */
export const isBitunixFuturesSymbol = (s: string) => /^[A-Z0-9]{2,20}USDT$/.test(s);

/**
 * A TradingView source symbol (or a platform symbol) → the Bitunix execution symbol, or null.
 * Accepts `BTCUSDT`, `BTCUSDT.P`, `BITUNIX:BTCUSDT.P`, `BTC_USDT`, `btcusdt`. The source symbol
 * itself is never rewritten: routes keep matching what TradingView sends.
 */
export function bitunixSymbolFor(raw: string): string | null {
  let s = (raw ?? '').trim().toUpperCase();
  const colon = s.lastIndexOf(':');
  if (colon >= 0) s = s.slice(colon + 1);
  s = s.replace(/\.P$/, '').replace(/PERP$/, '').replace(/_/g, '');
  return isBitunixFuturesSymbol(s) ? s : null;
}

/** Lighter market IDs are non-negative integers from the official catalog; never derived from a ticker. */
export const isLighterMarketId = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 2 ** 31 - 1;

/** Key of the in-memory market-data cache: exchange first, so equal symbols never collide. */
export const marketKey = (exchange: ExchangeId, exchangeSymbol: string) => `${exchange}:${exchangeSymbol}`;
