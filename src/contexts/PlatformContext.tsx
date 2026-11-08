import React, { createContext, useContext, useEffect, useMemo, useReducer } from 'react';
import { createPlatformSeed, refPriceOf } from '../data/platformSeed';
import { simNow } from '../utils/clock';
import { normalizeInterval } from '../utils/platformText';
import { validateSignal } from '../utils/signalValidation';
import { routeUsage } from '../data/signalRoutes';
import type { SignalInput } from '../types/signals';
import { nextReceiptId, platformReducer, validateAlert } from './platformReducer';
import { useDemo } from './DemoContext';
import type { PlatformAction } from './platformReducer';
import type { AlertMessage, ExchangeConnectionMeta, PlatformState, PriceTick, StrategyPackage, TradingPair } from '../types/platform';
import type { TokenBlock } from '../types/tradeSettings';
import type { PricePoint } from '../types/holdings';

const KEY = 'trendpilot.platform';
const VERSION = 2;
const TICK_MS = 4000;

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

interface PlatformValue {
  /**
   * Administrator settings, token blocks and connections. Prices, price history and processing
   * records are read from the shared demo store, so every page sees the same values.
   * `positions` contains only migrated holdings that were never linked to an account.
   */
  platform: PlatformState;
  receiveSignal: (message: AlertMessage) => void;
  savePackage: (pkg: StrategyPackage) => void;
  addPair: (pair: TradingPair) => void;
  updatePairDefaults: (symbol: string, patch: Pick<TradingPair, 'stopLossPct' | 'takeProfitPct' | 'trailingEnabled' | 'trailingPct'>) => void;
  setPairEnabled: (symbol: string, enabled: boolean) => void;
  resetPlatform: () => void;
  connectionFor: (subscriberId: string) => ExchangeConnectionMeta | undefined;
  saveConnection: (meta: ExchangeConnectionMeta) => void;
  renameConnection: (subscriberId: string, name: string) => void;
  disconnectConnection: (subscriberId: string) => void;
  recordConnectionTest: (subscriberId: string) => void;
  saveTokenBlock: (block: TokenBlock) => void;
  setTokenBlockActive: (subscriberId: string, blockId: string, active: boolean) => void;
  applyDemoPrice: (symbol: string, price: number) => void;
  /** Closes a migrated (unassigned) holding. Account-linked positions close through the shared store. */
  closeHolding: (subscriberId: string, positionId: string) => void;
}

const Ctx = createContext<PlatformValue | null>(null);

function load(): PlatformState {
  const seed = createPlatformSeed(simNow());
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return seed;
    const data = JSON.parse(raw) as {version: number;state: PlatformState;};
    const s = data?.state;
    // Version 1 data is migrated in place; nothing is cleared.
    if (data.version !== 1 && data.version !== VERSION || !s || !Array.isArray(s.pairs) || !Array.isArray(s.packages) || !Array.isArray(s.signals) || !Array.isArray(s.feed) || typeof s.prices !== 'object') {
      return seed;
    }
    const connections = Array.isArray(s.connections) ?
    s.connections.
    filter((c) => c && typeof c.id === 'string' && typeof c.subscriberId === 'string' && typeof c.maskedKey === 'string').
    map((c) => ({ id: c.id, subscriberId: c.subscriberId, name: String(c.name ?? 'MEXC connection'), exchange: 'mexc-futures' as const, maskedKey: c.maskedKey, status: c.status === 'disconnected' ? 'disconnected' as const : 'connected' as const, lastTestAt: Number(c.lastTestAt) || 0, createdAt: Number(c.createdAt) || 0 })) :
    [];
    // Blocks saved before accounts existed are never guessed: they need an explicit account choice.
    const tokenBlocks = Array.isArray(s.tokenBlocks) ?
    s.tokenBlocks.filter((b) => b && typeof b.id === 'string' && typeof b.subscriberId === 'string' && Array.isArray(b.takeProfits)).map((b) => ({ ...b, accountId: typeof b.accountId === 'string' ? b.accountId : null })) :
    [];
    const positions = Array.isArray(s.positions) ? s.positions.filter((p) => p && typeof p.id === 'string' && typeof p.subscriberId === 'string' && Array.isArray(p.exits) && Array.isArray(p.targets)) : [];
    const processing = Array.isArray(s.processing) ? s.processing.filter((r) => r && typeof r.receiptId === 'string' && typeof r.signalId === 'string') : [];
    const priceHistory = s.priceHistory && typeof s.priceHistory === 'object' ? s.priceHistory : {};
    return { ...s, connections, tokenBlocks, positions, processing, priceHistory };
  } catch {
    return seed;
  }
}

export function PlatformProvider({ children }: {children: React.ReactNode;}) {
  const [platform, dispatch] = useReducer(platformReducer, undefined, load);
  const { state: demo, setPaperPrice, setSharedPrices, executeTokenSignal, submitSignal } = useDemo();

  useEffect(() => {
    try {
      window.localStorage.setItem(KEY, JSON.stringify({ version: VERSION, state: platform }));
    } catch {

      // Storage unavailable — state stays in memory.
    }}, [platform]);

  // Pairs with any open position (shared store or migrated holdings) are monitored and never drift on their own.
  const openSymbols = useMemo(() => {
    const set = new Set(demo.positions.map((p) => p.pair));
    platform.positions.forEach((p) => p.status === 'open' && set.add(p.symbol));
    return set;
  }, [demo.positions, platform.positions]);
  const openKey = [...openSymbols].sort().join(',');

  // Single shared price per pair: the shared store wins; platform-only pairs fall back to their saved tick.
  const prices = useMemo(() => {
    const out: Record<string, PriceTick> = {};
    platform.pairs.forEach((pair) => {
      const shared = demo.paperPrices[pair.symbol];
      const own = platform.prices[pair.symbol];
      if (shared !== undefined) out[pair.symbol] = { price: shared, updatedAt: demo.priceTimes[pair.symbol] ?? own?.updatedAt ?? 0 };else
      if (own) out[pair.symbol] = own;
    });
    return out;
  }, [platform.pairs, platform.prices, demo.paperPrices, demo.priceTimes]);
  const pricesRef = React.useRef(prices);
  pricesRef.current = prices;

  const feed = useMemo(() => platform.pairs.filter((p) => p.enabled || openSymbols.has(p.symbol)).map((p) => p.symbol), [platform.pairs, openSymbols]);
  const feedKey = feed.join(',');

  useEffect(() => {
    const open = new Set(openKey ? openKey.split(',') : []);
    const symbols = feedKey ? feedKey.split(',') : [];
    const id = window.setInterval(() => {
      const next: Record<string, number> = {};
      symbols.forEach((s) => {
        if (open.has(s)) return;
        const prev = pricesRef.current[s]?.price ?? refPriceOf(s);
        next[s] = prev * (1 + (Math.random() - 0.5) * 0.002);
      });
      if (Object.keys(next).length === 0) return;
      setSharedPrices(next);
      dispatch({ type: 'setAbsolutePrices', prices: next, at: simNow() });
    }, TICK_MS);
    return () => window.clearInterval(id);
  }, [feedKey, openKey, setSharedPrices]);

  const exposed = useMemo<PlatformState>(() => {
    const counts = new Map<string, number>();
    demo.positions.forEach((p) => p.tokenRuntime && counts.set(p.tokenRuntime.blockId, (counts.get(p.tokenRuntime.blockId) ?? 0) + 1));
    const priceHistory: Record<string, PricePoint[]> = { ...platform.priceHistory };
    Object.entries(demo.priceHistory).forEach(([s, h]) => {
      if (h.length > 0) priceHistory[s] = h;
    });
    return {
      ...platform,
      prices,
      priceHistory,
      feed,
      tokenBlocks: platform.tokenBlocks.map((b) => ({ ...b, openPositions: counts.get(b.id) ?? 0 })),
      processing: [...demo.tokenProcessing, ...platform.processing]
    };
  }, [platform, prices, feed, demo.positions, demo.priceHistory, demo.tokenProcessing]);

  const value = useMemo<PlatformValue>(() => {
    const d = (a: DistributiveOmit<PlatformAction, 'at'>) => dispatch({ ...a, at: simNow() } as PlatformAction);
    return {
      platform: exposed,
      receiveSignal: (message) => {
        const at = simNow();
        const id = nextReceiptId(at);
        const result = validateAlert(platform, message);
        const tf = normalizeInterval(message.interval);
        // Resolve the route: explicit route_id, otherwise only an unambiguous mapping (timeframe + symbol).
        let route = message.route_id ? demo.routes.find((r) => r.id === message.route_id) : undefined;
        let routeNote: string | undefined;
        if (!message.route_id) {
          const candidates = demo.routes.filter((r) => r.enabled && r.timeframe === tf.timeframe && Object.values(r.symbolMap).includes(message.symbol));
          if (candidates.length === 1) route = candidates[0];else
          routeNote = candidates.length === 0 ? 'No saved route matches this symbol and interval — execution skipped.' : `${candidates.length} routes match this symbol and interval — ambiguous, execution skipped. Add route_id to the alert.`;
        } else if (!route) routeNote = `Unknown route_id ${message.route_id} — execution skipped.`;
        dispatch({ type: 'receiveSignal', message, id, at });
        if (result.outcome !== 'accepted') return;

        // Same central feed and validation as Admin Workspace (route, timeframe, confirmation, age, duplicates, sequence).
        const created = Date.parse(message.timestamp);
        const minutes = tf.timeframe === '5m' ? 5 : 15;
        const barOpen = message.bar_time ? Date.parse(message.bar_time) : Number.NaN;
        const candleClose = Number.isFinite(barOpen) ? barOpen + minutes * 60000 : Math.floor(created / (minutes * 60000)) * minutes * 60000;
        const input: SignalInput = {
          routeId: route?.id ?? message.route_id ?? 'unresolved-route',
          strategyVersion: route?.approvedVersion ?? '',
          pair: message.symbol,
          action: message.action === 'LONG' ? 'open-long' : 'open-short',
          referencePrice: demo.paperPrices[message.symbol] ?? 0,
          candleCloseAt: candleClose,
          createdAt: created,
          // Simulated gateway receipt shortly after the alert fired (UTC ms; shown in Asia/Dhaka).
          receivedAt: Number.isFinite(created) ? created + 1400 : at,
          // Confirmation requires valid close data: a known bar_time whose candle has closed before the alert fired.
          confirmed: Number.isFinite(barOpen) && candleClose <= created,
          signalId: message.signal_id,
          timeframe: message.interval
        };
        const central = validateSignal(input, { routes: demo.routes, signals: demo.centralSignals, watermarks: demo.watermarks, now: Math.max(at, input.receivedAt) });
        submitSignal(input);
        if (routeNote || !route || central.outcome !== 'accepted' || routeUsage(route) !== 'trade') return;
        executeTokenSignal({
          receiptId: id,
          signalId: message.signal_id,
          symbol: message.symbol,
          side: message.action === 'LONG' ? 'long' : 'short',
          timeframe: tf.timeframe,
          rawInterval: tf.raw,
          blocks: platform.tokenBlocks,
          packages: platform.packages,
          pairs: platform.pairs,
          connections: platform.connections,
          candleClose: message.candle_close ?? null,
          ema200: message.ema200 ?? null
        });
      },
      applyDemoPrice: (symbol, price) => {
        if (!Number.isFinite(price) || price <= 0) return;
        setPaperPrice(symbol, price);
        // Migrated holdings run their own saved percentage exits from the same price.
        d({ type: 'applyDemoPrice', symbol, price });
      },
      closeHolding: (subscriberId, positionId) => d({ type: 'closeHolding', subscriberId, positionId }),
      savePackage: (pkg) => dispatch({ type: 'savePackage', pkg }),
      addPair: (pair) => d({ type: 'addPair', pair }),
      updatePairDefaults: (symbol, patch) => d({ type: 'updatePairDefaults', symbol, patch }),
      setPairEnabled: (symbol, enabled) => d({ type: 'setPairEnabled', symbol, enabled }),
      resetPlatform: () => d({ type: 'resetPlatform' }),
      connectionFor: (subscriberId) => platform.connections.find((c) => c.subscriberId === subscriberId),
      saveConnection: (meta) => dispatch({ type: 'saveConnection', meta }),
      renameConnection: (subscriberId, name) => dispatch({ type: 'renameConnection', subscriberId, name }),
      disconnectConnection: (subscriberId) => dispatch({ type: 'disconnectConnection', subscriberId }),
      recordConnectionTest: (subscriberId) => d({ type: 'recordConnectionTest', subscriberId }),
      saveTokenBlock: (block) => dispatch({ type: 'saveTokenBlock', block }),
      setTokenBlockActive: (subscriberId, blockId, active) => d({ type: 'setTokenBlockActive', subscriberId, blockId, active })
    };
  }, [platform, exposed, executeTokenSignal, setPaperPrice, submitSignal, demo.routes, demo.centralSignals, demo.watermarks, demo.paperPrices]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function usePlatform(): PlatformValue {
  const v = useContext(Ctx);
  if (!v) throw new Error('usePlatform must be used inside PlatformProvider');
  return v;
}