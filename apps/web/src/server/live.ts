import { asc, eq } from 'drizzle-orm';
import { connectionDto, connectionFor, connectionState, controlState, getDb, getLiveControl, listConnections, liveControlDto, MEXC_CAPABILITIES, schema } from '@trendpilot/db';
import { liveAccountBlockers, LIVE_REFUSAL_TEXT } from '@trendpilot/domain';

/** The signed-in investor's Live status (owner-scoped; never the key or secret). */
export async function liveStatusFor(ownerId: string) {
  const db = getDb();
  const control = await getLiveControl(db);
  const conn = await connectionFor(db, ownerId);
  const active = conn && conn.status !== 'REVOKED' ? conn : null;
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
    liveContracts: contracts,
    entries: { allowed: !first, reason: first?.reason ?? null, reasonText: first?.text ?? null, blockers }
  };
}

/** Admin → Live Trading data: switch, capability evidence, every connection (no secrets), contract allowlist. */
export async function adminLiveData() {
  const db = getDb();
  const contracts = await db
    .select({ id: schema.instruments.id, symbol: schema.instruments.symbol, exchangeSymbol: schema.instruments.exchangeSymbol, status: schema.instruments.status, isFixture: schema.instruments.isFixture, liveAllowed: schema.instruments.liveAllowed })
    .from(schema.instruments)
    .orderBy(asc(schema.instruments.symbol));
  return {
    control: liveControlDto(await getLiveControl(db)),
    capabilities: MEXC_CAPABILITIES.map((c) => ({ id: c.id, summary: c.summary, documented: c.documented, mock: c.mock, readOnly: c.readOnly, gaps: c.gaps, docs: c.docs })),
    connections: await listConnections(db),
    contracts
  };
}
