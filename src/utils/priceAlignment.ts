import type { DemoState } from '../contexts/demoReducer';

/**
 * One simulated price per pair. Pairs with open positions take the price those positions
 * are valued at (the most recently opened one), so Demo Controls, Holdings, the Dashboard
 * and exit checks all read the same number. Every open position on the pair is then
 * revalued at that price. Exit rules are not run here — this only aligns the display.
 */
export function alignPricesToPositions<S extends Pick<DemoState, 'positions' | 'paperPrices'>>(state: S): S {
  const latest = new Map<string, number>();
  state.positions.forEach((p) => {
    if (p.quantity > 0 && Number.isFinite(p.markPrice) && p.markPrice > 0) latest.set(p.pair, p.markPrice);
  });
  if (latest.size === 0) return state;
  const paperPrices = { ...state.paperPrices };
  latest.forEach((price, pair) => {
    paperPrices[pair] = price;
  });
  return {
    ...state,
    paperPrices,
    positions: state.positions.map((p) => latest.has(p.pair) ? { ...p, markPrice: paperPrices[p.pair] } : p)
  };
}