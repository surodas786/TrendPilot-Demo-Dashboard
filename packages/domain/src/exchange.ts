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
 * Exchanges TrendPilot can trade Live on. Lighter is not listed: its pairs trade in Paper, and an
 * investor can connect and verify a Lighter account (Lighter plan Step 4), but every Live ENTRY path
 * refuses an exchange that is not listed here, instead of treating it as MEXC.
 */
export const TRADABLE_EXCHANGES = ['MEXC', 'BITUNIX'] as const satisfies readonly ExchangeId[];
export type TradableExchangeId = (typeof TRADABLE_EXCHANGES)[number];
export const isTradableExchange = (v: unknown): v is TradableExchangeId => typeof v === 'string' && (TRADABLE_EXCHANGES as readonly string[]).includes(v);

/**
 * Exchanges with a Paper simulator account: MEXC (USDT) and Lighter (USDC, isolated balance; Lighter
 * plan Step 3). Bitunix is Live only. Paper never reaches an exchange.
 */
export const PAPER_EXCHANGES = ['MEXC', 'LIGHTER'] as const satisfies readonly ExchangeId[];
export type PaperExchangeId = (typeof PAPER_EXCHANGES)[number];
export const isPaperExchange = (v: unknown): v is PaperExchangeId => typeof v === 'string' && (PAPER_EXCHANGES as readonly string[]).includes(v);

/** Why an exchange cannot be connected or traded LIVE yet, or null when it can. */
export function exchangeUnavailableReason(exchange: string | null | undefined): string | null {
  if (isTradableExchange(exchange)) return null;
  if (exchange === 'LIGHTER') return 'Lighter Live is not enabled for this account yet: it needs a verified Lighter connection approved by an administrator, the Lighter contract on the Live allowlist and the deployment\'s Lighter Live settings. Lighter Paper is available.';
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
