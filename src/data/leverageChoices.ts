/**
 * Illustrative per-pair leverage choices for this demo.
 * Not verified current MEXC limits.
 */
const BY_PAIR: Record<string, number[]> = {
  BTCUSDT: [1, 2, 3, 5, 10, 20, 50, 100],
  ETHUSDT: [1, 2, 3, 5, 10, 20, 50],
  SOLUSDT: [1, 2, 3, 5, 10, 20],
  BNBUSDT: [1, 2, 3, 5, 10, 20],
  XRPUSDT: [1, 2, 3, 5, 10]
};

const FALLBACK = [1, 2, 3, 5, 10];

export function leverageChoices(symbol: string): number[] {
  return BY_PAIR[symbol] ?? FALLBACK;
}

export const LEVERAGE_NOTE = 'Illustrative exchange limits for this demo — not verified current MEXC limits.';