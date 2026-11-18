import { asc, eq } from 'drizzle-orm';
import {
  bitunixAccountView,
  capabilityStateOf,
  connectionDto,
  connectionFor,
  connectionState,
  controlState,
  getDb,
  getLiveControl,
  lighterTradePermission,
  listConnections,
  liveControlDto,
  BITUNIX_CAPABILITIES,
  LIGHTER_CAPABILITIES,
  MEXC_CAPABILITIES,
  schema,
  type ConnectionRow
} from '@trendpilot/db';
import { liveAccountBlockers, LIVE_REFUSAL_TEXT } from '@trendpilot/domain';

/** The signed-in investor's Live status (owner-scoped; never the key or secret). */
export async function liveStatusFor(ownerId: string) {
  const db = getDb();
  const control = await getLiveControl(db);
  const conn = await connectionFor(db, ownerId);
  const active = conn && conn.status !== 'REVOKED' ? conn : null;
  // The investor's Bitunix connection (read-only in this release): shown, never part of the Live gates.
  const bx = await connectionFor(db, ownerId, 'BITUNIX');
  // Lighter (connect, verify and sync only): verification and permission to trade shown separately.
  const lt = await connectionFor(db, ownerId, 'LIGHTER');
  const lighter = lt && lt.status !== 'REVOKED' ? lt : null;
  const contracts = await db
    .select({ id: schema.instruments.id, symbol: schema.instruments.symbol, exchangeSymbol: schema.instruments.exchangeSymbol })
    .from(schema.instruments)
    .where(eq(schema.instruments.liveAllowed, true));
  const state = controlState(control);
  // Every blocker, in gate order (the worker refuses on the first): an operator halt does not hide
  // a connection problem such as the position mode.
  const blockers = liveAccountBlockers(state, active ? connectionState(active) : null, ownerId, contracts.length > 0).map((b) => ({ reason: b.reason, text: LIVE_REFUSAL_TEXT[b.reason] }));
  const first = blockers[0];
  return {
    platform: { transportEnabled: state.transportEnabled, liveEnabled: state.platformEnabled, entriesHalted: state.platformEntriesHalted, haltReason: state.platformHaltReason ?? null },
    connection: active ? connectionDto(active) : null,
    bitunix: bx && bx.status !== 'REVOKED' ? connectionDto(bx) : null,
    bitunixAccount: bx && bx.status !== 'REVOKED' ? await bitunixAccountView(db, bx) : null,
    lighter: lighter ? connectionDto(lighter) : null,
    lighterAccount: lighter ? lighterAccountView(lighter) : null,
    lighterTrade: lighterTradePermission(lighter, capabilityStateOf(control)),
    liveContracts: contracts,
    entries: { allowed: !first, reason: first?.reason ?? null, reasonText: first?.text ?? null, blockers }
  };
}

/** Admin → Live Trading data: switch, capability evidence, every connection (no secrets), contract allowlist. */
export async function adminLiveData() {
  const db = getDb();
  const contracts = await db
    .select({ id: schema.instruments.id, exchange: schema.instruments.exchange, symbol: schema.instruments.symbol, exchangeSymbol: schema.instruments.exchangeSymbol, status: schema.instruments.status, isFixture: schema.instruments.isFixture, liveAllowed: schema.instruments.liveAllowed })
    .from(schema.instruments)
    .orderBy(asc(schema.instruments.symbol), asc(schema.instruments.exchange));
  return {
    control: liveControlDto(await getLiveControl(db)),
    capabilities: [...MEXC_CAPABILITIES, ...BITUNIX_CAPABILITIES, ...LIGHTER_CAPABILITIES].map((c) => ({ id: c.id, summary: c.summary, documented: c.documented, mock: c.mock, readOnly: c.readOnly, gaps: c.gaps, docs: c.docs })),
    connections: await listConnections(db),
    contracts
  };
}

/** The Lighter account as last reconciled (USDC; never mixed with USDT), for the investor's own view. */
export function lighterAccountView(c: ConnectionRow) {
  const st = (c.accountState ?? {}) as {
    currency?: string;
    balance?: { collateral: string; available: string; totalAssetValue: string | null; atMs: number };
    tradingMode?: string | null;
    positions?: { marketId: number; symbol: string; side: string | null; size: string; avgEntryPrice: string | null; liquidationPrice: string | null; unrealizedPnl: string | null; fundingPaidOutUsdc: string | null; openOrders: number }[];
  };
  return {
    currency: 'USDC' as const,
    balance: st.balance ?? null,
    tradingMode: st.tradingMode ?? null,
    positions: st.positions ?? [],
    lastSyncAt: c.lastSyncAt?.toISOString() ?? null,
    lastSyncOkAt: c.lastSyncOkAt?.toISOString() ?? null,
    lastSyncError: c.lastSyncError
  };
}
