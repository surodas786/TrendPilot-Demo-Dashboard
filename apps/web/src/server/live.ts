import { asc, eq } from 'drizzle-orm';
import { connectionDto, connectionFor, connectionState, controlState, getDb, getLiveControl, listConnections, liveControlDto, MEXC_CAPABILITIES, schema } from '@trendpilot/db';
import { liveAccountGate, LIVE_REFUSAL_TEXT } from '@trendpilot/domain';

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
  const gate = liveAccountGate(state, active ? connectionState(active) : null, ownerId, true);
  return {
    platform: { transportEnabled: state.transportEnabled, liveEnabled: state.platformEnabled, entriesHalted: state.platformEntriesHalted, haltReason: state.platformHaltReason ?? null },
    connection: active ? connectionDto(active) : null,
    liveContracts: contracts,
    entries: gate.ok ? { allowed: contracts.length > 0, reason: contracts.length ? null : 'LIVE_CONTRACT_NOT_ALLOWED', reasonText: contracts.length ? null : LIVE_REFUSAL_TEXT.LIVE_CONTRACT_NOT_ALLOWED } : { allowed: false, reason: gate.reason, reasonText: LIVE_REFUSAL_TEXT[gate.reason] }
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
