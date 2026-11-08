import { hydrateUserDirectory } from './userDirectory';
import { alignPricesToPositions } from './priceAlignment';
import type { DemoState } from '../contexts/demoReducer';

const KEY = 'trendpilot.demo';
const BACKUP_KEY = 'trendpilot.demo.unreadable';
const PLATFORM_KEY = 'trendpilot.platform';
const VERSION = 2;

const REQUIRED_ARRAYS: (keyof DemoState)[] = ['accounts', 'positions', 'closedTrades', 'orders', 'users', 'transfers', 'tradeRecords'];

/** Prices saved by the earlier token-block store fill pairs the shared price list doesn't cover yet. */
function migratePlatformPrices(state: DemoState): DemoState {
  try {
    const raw = window.localStorage.getItem(PLATFORM_KEY);
    if (!raw) return state;
    const prices = (JSON.parse(raw) as {state?: {prices?: Record<string, {price: number;updatedAt: number;}>;};})?.state?.prices ?? {};
    const paperPrices = { ...state.paperPrices };
    const priceTimes = { ...state.priceTimes };
    Object.entries(prices).forEach(([symbol, tick]) => {
      if (paperPrices[symbol] === undefined && tick && Number.isFinite(tick.price) && tick.price > 0) {
        paperPrices[symbol] = tick.price;
        priceTimes[symbol] = tick.updatedAt;
      }
    });
    return { ...state, paperPrices, priceTimes };
  } catch {
    return state;
  }
}

export interface LoadResult {
  state: DemoState;
  /** True when saved data existed but couldn't be read (a copy is kept under a separate key). */
  unreadable: boolean;
}

/**
 * Loads the saved shared demo store. Only fictional, non-sensitive records are ever saved —
 * no passwords, API keys or secrets exist in this state.
 */
export function loadDemoState(fresh: DemoState): LoadResult {
  const r = loadRaw(fresh);
  return { ...r, state: alignPricesToPositions(r.state) };
}

function loadRaw(fresh: DemoState): LoadResult {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return { state: migratePlatformPrices(hydrateUserDirectory(fresh)), unreadable: false };
    const data = JSON.parse(raw) as {version?: number;state?: Partial<DemoState>;};
    const saved = data?.state;
    if (data?.version !== VERSION || !saved || REQUIRED_ARRAYS.some((k) => !Array.isArray(saved[k]))) {
      window.localStorage.setItem(BACKUP_KEY, raw);
      return { state: migratePlatformPrices(hydrateUserDirectory(fresh)), unreadable: true };
    }
    const merged: DemoState = {
      ...fresh,
      ...saved,
      accounts: (saved.accounts ?? fresh.accounts).map((a) => ({ ...a, environment: a.environment === 'live' ? 'live' : 'paper' })),
      tokenProcessing: Array.isArray(saved.tokenProcessing) ? saved.tokenProcessing : [],
      tokenArchive: Array.isArray(saved.tokenArchive) ? saved.tokenArchive : [],
      priceTimes: saved.priceTimes ?? {},
      priceHistory: saved.priceHistory ?? {},
      composerDraft: null,
      selectedPositionId: null
    } as DemoState;
    return { state: migratePlatformPrices(merged), unreadable: false };
  } catch {
    return { state: migratePlatformPrices(hydrateUserDirectory(fresh)), unreadable: true };
  }
}

export function saveDemoState(state: DemoState): void {
  try {
    const { composerDraft: _draft, selectedPositionId: _sel, ...rest } = state;
    window.localStorage.setItem(KEY, JSON.stringify({ version: VERSION, state: rest }));
  } catch {

    // Storage unavailable — the demo keeps working in memory.
  }}