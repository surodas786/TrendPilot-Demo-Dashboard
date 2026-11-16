/**
 * Exchanges TrendPilot can connect to, and the symbol rules for each. Pure; no I/O.
 *
 * Three symbols exist for one contract and are kept apart on purpose:
 *  - the TradingView SOURCE symbol in an alert (`BTCUSDT.P`, `BITUNIX:BTCUSDT.P`), matched by a
 *    signal route to a platform instrument;
 *  - the platform symbol (`BTCUSDT`), shown to people;
 *  - the exchange EXECUTION symbol the exchange API takes (MEXC `BTC_USDT`, Bitunix `BTCUSDT`).
 */

export const EXCHANGES = ['MEXC', 'BITUNIX'] as const;
export type ExchangeId = (typeof EXCHANGES)[number];

export const EXCHANGE_LABEL: Record<ExchangeId, string> = { MEXC: 'MEXC', BITUNIX: 'Bitunix' };

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

/** Key of the in-memory market-data cache: exchange first, so equal symbols never collide. */
export const marketKey = (exchange: ExchangeId, exchangeSymbol: string) => `${exchange}:${exchangeSymbol}`;
