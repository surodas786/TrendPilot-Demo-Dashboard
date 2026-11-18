/**
 * Lighter Live scope: the ONLY way a Lighter connection, market or TradingView route can open a
 * position. It replaces the unconditional refusal of the earlier steps with an explicit, default-off
 * allowlist plus the capability records.
 *
 * Deployment settings (server .env; all unset = Lighter Live disabled, the default):
 *   LIGHTER_MAINNET_ORDERS   "enabled" opens Lighter mainnet order submission (still also needs
 *                            LIVE_ORDER_TRANSPORT=enabled). Off: no Lighter order of any kind is sent.
 *   LIGHTER_LIVE_CONNECTIONS TrendPilot exchange-connection IDs (UUIDs, comma-separated) allowed to
 *                            open Lighter positions.
 *   LIGHTER_LIVE_MARKETS     Lighter market IDs (integers, comma-separated) allowed for Live, e.g. 92.
 *   LIGHTER_LIVE_ROUTES      Signal route IDs (UUIDs, comma-separated) whose alerts may open Lighter
 *                            Live positions.
 *
 * Every ENTRY additionally needs each order capability recorded as VERIFIED or PILOT_ACCEPTED
 * (Admin → Live Trading), and the price-bound and fee inputs (LIGHTER_*_WORST_PRICE_PCT,
 * LIGHTER_TAKER_FEE_RATE). The scope gates NEW ENTRIES only: halting or narrowing it never blocks
 * protection, reduce-only closes or reconciliation (the venue sends those without this check).
 */
import { missingLiveInputs, type LighterLiveInputs } from '@trendpilot/domain';
import { livePilotVerified, type CapabilityState, type LighterCapabilityId } from './capabilities';

type Env = Record<string, string | undefined>;

export interface LighterLiveScope {
  mainnetOrders: boolean;
  connections: ReadonlySet<string>;
  markets: ReadonlySet<number>;
  routes: ReadonlySet<string>;
  /** Malformed settings (the malformed entries are ignored, never widened). */
  issues: string[];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** LIGHTER_MAINNET_ORDERS: "enabled" or unset/"off". Anything else is off. */
export function lighterMainnetOrdersEnabled(env: Env = process.env): boolean {
  return (env.LIGHTER_MAINNET_ORDERS ?? '').trim().toLowerCase() === 'enabled';
}

export function lighterLiveScope(env: Env = process.env): LighterLiveScope {
  const issues: string[] = [];
  const mo = (env.LIGHTER_MAINNET_ORDERS ?? '').trim().toLowerCase();
  if (mo !== '' && mo !== 'off' && mo !== 'enabled') issues.push(`LIGHTER_MAINNET_ORDERS must be "enabled" or "off" (treated as off).`);
  const list = (k: string) =>
    (env[k] ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  const uuids = (k: string) => {
    const out = new Set<string>();
    for (const s of list(k)) {
      if (UUID.test(s)) out.add(s.toLowerCase());
      else issues.push(`${k}: "${s.slice(0, 40)}" is not an ID (ignored).`);
    }
    return out;
  };
  const markets = new Set<number>();
  for (const s of list('LIGHTER_LIVE_MARKETS')) {
    if (/^\d{1,6}$/.test(s)) markets.add(Number(s));
    else issues.push(`LIGHTER_LIVE_MARKETS: "${s.slice(0, 40)}" is not a market ID (ignored).`);
  }
  return { mainnetOrders: mo === 'enabled', connections: uuids('LIGHTER_LIVE_CONNECTIONS'), markets, routes: uuids('LIGHTER_LIVE_ROUTES'), issues };
}

/** Lighter XAU perp (mainnet). Its execution capability is recorded separately. */
export const LIGHTER_XAU_MARKET_ID = 92;

/** Capabilities a Lighter account needs before it can be approved, activated or open a position. */
export const LIGHTER_ACCOUNT_CAPABILITIES: readonly LighterCapabilityId[] = [
  'LIGHTER_SIGNER',
  'LIGHTER_KEY_MATCH',
  'LIGHTER_ACCOUNT_SETTINGS',
  'LIGHTER_OPEN_WITH_LINKED_STOP',
  // Never open what cannot be closed.
  'LIGHTER_REDUCE_ONLY_CLOSE',
  'LIGHTER_ORDER_LOOKUP',
  'LIGHTER_FILL_FEES'
];

export const lighterMarketCapabilities = (marketId: number | null | undefined): readonly LighterCapabilityId[] => (marketId === LIGHTER_XAU_MARKET_ID ? ['LIGHTER_XAU_EXECUTION'] : []);

export interface LighterScopeTarget {
  connection?: { id: string; status: string; venueEnvironment: string | null } | null;
  marketId?: number | null;
  routeId?: string | null;
}

/**
 * Why Lighter Live is refused for this target, or null.
 *  ACCOUNT: approval / activation of a connection.
 *  MARKET:  adding a Lighter market to the Live allowlist.
 *  SEND:    the last check before an opening order is sent (account + market).
 *  ENTRY:   a TradingView alert opening a position (account + market + route).
 */
export function lighterLiveRefusal(
  scope: LighterLiveScope,
  capabilities: CapabilityState,
  inputs: LighterLiveInputs,
  t: LighterScopeTarget,
  level: 'ACCOUNT' | 'MARKET' | 'SEND' | 'ENTRY'
): string | null {
  if (!scope.mainnetOrders) return 'Lighter Live trading is disabled on this deployment (LIGHTER_MAINNET_ORDERS is not enabled).';
  if (level !== 'MARKET') {
    const c = t.connection;
    if (!c) return 'No Lighter connection is set up.';
    if (c.status !== 'VERIFIED') return 'The Lighter connection is not verified.';
    if (c.venueEnvironment !== 'MAINNET') return 'Only a Lighter mainnet connection can trade Live.';
    if (!scope.connections.has(c.id.toLowerCase())) return 'This Lighter account is not in the Lighter Live scope (LIGHTER_LIVE_CONNECTIONS).';
    const cap = LIGHTER_ACCOUNT_CAPABILITIES.find((id) => !livePilotVerified(id, capabilities));
    if (cap) return `Lighter capability ${cap} is not recorded as verified (Admin → Live Trading).`;
    const gaps = [...new Set([...missingLiveInputs(inputs, 'OPEN'), ...missingLiveInputs(inputs, 'CLOSE')])];
    if (gaps.length) return `Lighter Live inputs are not configured: ${gaps.join(', ')}.`;
  }
  if (level !== 'ACCOUNT') {
    if (t.marketId === null || t.marketId === undefined || !scope.markets.has(t.marketId)) return `Lighter market ${t.marketId ?? '(none)'} is not in the Lighter Live scope (LIGHTER_LIVE_MARKETS).`;
    const cap = lighterMarketCapabilities(t.marketId).find((id) => !livePilotVerified(id, capabilities));
    if (cap) return `Lighter capability ${cap} is not recorded as verified (Admin → Live Trading).`;
  }
  if (level === 'ENTRY' && (!t.routeId || !scope.routes.has(t.routeId.toLowerCase()))) return 'This TradingView route is not in the Lighter Live scope (LIGHTER_LIVE_ROUTES).';
  return null;
}

/**
 * Evidence rule for a Lighter capability recorded as VERIFIED: it must cite a Lighter MAINNET
 * transaction TrendPilot itself sent and saw EXECUTED (`lighter-tx:<hash>`), of the kind that
 * capability is about. PILOT_ACCEPTED stays an explicit operator decision for a supervised pilot.
 */
export const LIGHTER_EVIDENCE_PURPOSES: Record<LighterCapabilityId, readonly ('OPEN_WITH_STOP' | 'CLOSE' | 'STOP_RESIZE')[]> = {
  LIGHTER_SIGNER: ['OPEN_WITH_STOP', 'CLOSE', 'STOP_RESIZE'],
  LIGHTER_KEY_MATCH: ['OPEN_WITH_STOP', 'CLOSE', 'STOP_RESIZE'],
  LIGHTER_ACCOUNT_SETTINGS: ['OPEN_WITH_STOP'],
  LIGHTER_OPEN_WITH_LINKED_STOP: ['OPEN_WITH_STOP'],
  LIGHTER_XAU_EXECUTION: ['OPEN_WITH_STOP'],
  LIGHTER_ORDER_LOOKUP: ['OPEN_WITH_STOP', 'CLOSE'],
  LIGHTER_FILL_FEES: ['OPEN_WITH_STOP', 'CLOSE'],
  LIGHTER_FUNDING: ['OPEN_WITH_STOP'],
  LIGHTER_REDUCE_ONLY_CLOSE: ['CLOSE'],
  LIGHTER_STOP_RESIZE: ['STOP_RESIZE'],
  LIGHTER_STOP_RENEW: ['STOP_RESIZE']
};

export const lighterEvidenceHash = (evidence: string): string | null => /lighter-tx:([0-9a-fA-Fx]{16,130})/.exec(evidence)?.[1] ?? null;
