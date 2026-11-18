import { asc, eq, ne } from 'drizzle-orm';
import {
  bitunixAccountView,
  capabilityStateOf,
  connectionDto,
  connectionFor,
  connectionState,
  controlState,
  getDb,
  getLiveControl,
  lighterLiveRefusalFor,
  LIGHTER_ACCOUNT_CAPABILITIES,
  ORDER_CAPABILITIES,
  lighterTradePermission,
  listConnections,
  liveControlDto,
  BITUNIX_CAPABILITIES,
  LIGHTER_CAPABILITIES,
  MEXC_CAPABILITIES,
  schema,
  type ConnectionRow
} from '@trendpilot/db';
import { exchangeLabel, liveAccountBlockers, liveRefusalText } from '@trendpilot/domain';

export type EntryBlocker = { reason: string; text: string; next: string | null };

/** What the investor (or nobody but the platform) can do about a blocker, per exchange. */
function nextActionFor(reason: string, ex: string): string | null {
  const x = exchangeLabel(ex);
  switch (reason) {
    case 'LIVE_TRANSPORT_DISABLED':
    case 'LIVE_PLATFORM_DISABLED':
      return 'Nothing to do on your side: the platform operator switches Live on.';
    case 'LIVE_PLATFORM_HALTED':
      return 'Nothing to do on your side: the operator resumes new entries after review.';
    case 'LIVE_CONNECTION_MISSING':
      return `Connect your ${x} account on the Live Trading page.`;
    case 'LIVE_OWNERSHIP_MISMATCH':
    case 'LIVE_CONNECTION_NOT_VERIFIED':
      return `Save your ${x} API key again on the Live Trading page so TrendPilot can verify it.`;
    case 'LIVE_POSITION_MODE':
      return ex === 'BITUNIX' ? 'Switch the Bitunix account to Hedge mode in Bitunix, then check the connection again on the Live Trading page.' : `Press Save and check on the Live Trading page so TrendPilot reads the ${x} position mode again.`;
    case 'LIVE_ACCOUNT_NOT_APPROVED':
      return `Wait for an administrator to approve your ${x} account and set its limits.`;
    case 'LIVE_NOT_ACTIVATED':
      return `Activate Live for ${x} on the Live Trading page.`;
    case 'LIVE_ACCOUNT_HALTED':
      return 'An administrator resumes entries on this account after review.';
    case 'LIVE_CONTRACT_NOT_ALLOWED':
      return `Nothing to do on your side: an administrator adds ${x} contracts to the Live allowlist.`;
    case 'LIVE_CAPABILITY_PENDING':
      return `Nothing to do on your side: the operator records the ${x} order capability.`;
    default:
      return null;
  }
}

/** The capability the exchange's adapter checks before it sends an OPENING order (Lighter: its own scope check). */
const OPEN_CAPABILITY: Record<string, string> = { MEXC: 'OPEN_WITH_ATTACHED_STOP', BITUNIX: 'BITUNIX_OPEN_WITH_ATTACHED_STOP' };

/**
 * Every condition that blocks a regular (signal-driven) Live entry for this investor on ONE exchange,
 * in the worker's gate order, worded for that exchange, with the next action. The same checks the
 * order path applies: liveAccountBlockers (liveEntryEligibility, at evaluation and before submission),
 * Bitunix Hedge mode (the Live guard), the adapter's opening-order capability, and the Lighter Live
 * scope. Shared by Admin → Live Trading and the investor's My Account / Live Trading pages.
 */
export async function entryBlockersFor(
  db: ReturnType<typeof getDb>,
  ex: 'MEXC' | 'BITUNIX' | 'LIGHTER',
  ownerId: string,
  row: ConnectionRow | null,
  ctx: { state: ReturnType<typeof controlState>; evidence: Record<string, { state: string } | undefined>; allowlisted: boolean }
): Promise<EntryBlocker[]> {
  const conn = row && row.status !== 'REVOKED' ? row : null;
  const out: EntryBlocker[] = liveAccountBlockers(ctx.state, conn ? connectionState(conn) : null, ownerId, ctx.allowlisted).map((b) => ({ reason: b.reason as string, text: liveRefusalText(b.reason, ex), next: nextActionFor(b.reason, ex) }));
  // Bitunix: the worker refuses (and halts) a Bitunix entry unless Bitunix reports Hedge mode.
  if (ex === 'BITUNIX' && conn?.status === 'VERIFIED' && conn.positionMode !== 'HEDGE' && !out.some((b) => b.reason === 'LIVE_POSITION_MODE'))
    out.push({ reason: 'LIVE_POSITION_MODE', text: liveRefusalText('LIVE_POSITION_MODE', 'BITUNIX'), next: nextActionFor('LIVE_POSITION_MODE', 'BITUNIX') });
  const cap = OPEN_CAPABILITY[ex];
  if (cap && !['VERIFIED', 'PILOT_ACCEPTED'].includes(ctx.evidence[cap]?.state ?? ''))
    out.push({ reason: 'LIVE_CAPABILITY_PENDING', text: `${exchangeLabel(ex)} opening orders are not enabled yet: the operator has not recorded ${cap}, so the ${exchangeLabel(ex)} adapter refuses them.`, next: nextActionFor('LIVE_CAPABILITY_PENDING', ex) });
  if (ex === 'LIGHTER' && conn) {
    const refusal = await lighterLiveRefusalFor(db, { ownerId }, 'ACCOUNT');
    if (refusal) out.push({ reason: 'LIGHTER_LIVE_SCOPE', text: refusal, next: null });
  }
  return out;
}

export interface ExchangeEligibility {
  exchange: 'MEXC' | 'BITUNIX' | 'LIGHTER';
  label: string;
  /** Connection verification (read-only key check): separate from permission to enter. */
  connection: { status: string | null; text: string; accountRef: string | null; positionMode: string | null };
  /** Contracts of THIS exchange on the Live allowlist. */
  liveContracts: string[];
  /** New Live entries on this exchange, with every blocker and the next action. */
  entries: { allowed: boolean; blockers: EntryBlocker[] };
}

const CONNECTION_TEXT: Record<string, string> = { VERIFIED: 'Verified', PENDING: 'Not verified yet', FAILED: 'Verification failed', REVOKED: 'Removed' };

/** The signed-in investor's Live status (owner-scoped; never the key or secret). */
export async function liveStatusFor(ownerId: string) {
  const db = getDb();
  const control = await getLiveControl(db);
  const conn = await connectionFor(db, ownerId);
  const active = conn && conn.status !== 'REVOKED' ? conn : null;
  const bx = await connectionFor(db, ownerId, 'BITUNIX');
  const lt = await connectionFor(db, ownerId, 'LIGHTER');
  const lighter = lt && lt.status !== 'REVOKED' ? lt : null;
  const allowed = await db
    .select({ id: schema.instruments.id, exchange: schema.instruments.exchange, symbol: schema.instruments.symbol, exchangeSymbol: schema.instruments.exchangeSymbol, status: schema.instruments.status })
    .from(schema.instruments)
    .where(eq(schema.instruments.liveAllowed, true));
  const state = controlState(control);
  const evidence = liveControlDto(control).capabilities as Record<string, { state: string } | undefined>;
  const contractsOf = (ex: string) => allowed.filter((x) => x.exchange === ex && x.status === 'PUBLISHED');

  // Per exchange: verification and entry permission, from the gates that govern order submission.
  const rows = { MEXC: active, BITUNIX: bx && bx.status !== 'REVOKED' ? bx : null, LIGHTER: lighter } as const;
  const exchanges: ExchangeEligibility[] = [];
  for (const ex of LIVE_EXCHANGES) {
    const row = rows[ex];
    // MEXC is always listed (the default Live exchange); Bitunix and Lighter once connected.
    if (ex !== 'MEXC' && !row) continue;
    const blockers = await entryBlockersFor(db, ex, ownerId, row, { state, evidence, allowlisted: contractsOf(ex).length > 0 });
    exchanges.push({
      exchange: ex,
      label: exchangeLabel(ex),
      connection: { status: row?.status ?? null, text: row ? (CONNECTION_TEXT[row.status] ?? row.status) : 'Not connected', accountRef: row?.accountRef ?? null, positionMode: row?.positionMode ?? null },
      liveContracts: contractsOf(ex).map((x) => x.exchangeSymbol || x.symbol),
      entries: { allowed: blockers.length === 0, blockers }
    });
  }
  // MEXC entries (kept for older clients): MEXC contracts only, MEXC gates only.
  const mexc = exchanges.find((e) => e.exchange === 'MEXC')!;
  const first = mexc.entries.blockers[0];
  return {
    platform: { transportEnabled: state.transportEnabled, liveEnabled: state.platformEnabled, entriesHalted: state.platformEntriesHalted, haltReason: state.platformHaltReason ?? null },
    connection: active ? connectionDto(active) : null,
    bitunix: bx && bx.status !== 'REVOKED' ? connectionDto(bx) : null,
    bitunixAccount: bx && bx.status !== 'REVOKED' ? await bitunixAccountView(db, bx) : null,
    lighter: lighter ? connectionDto(lighter) : null,
    lighterAccount: lighter ? lighterAccountView(lighter) : null,
    lighterTrade: lighterTradePermission(lighter, capabilityStateOf(control)),
    liveContracts: contractsOf('MEXC').map(({ id, symbol, exchangeSymbol }) => ({ id, symbol, exchangeSymbol })),
    entries: { allowed: !first, reason: first?.reason ?? null, reasonText: first?.text ?? null, blockers: mexc.entries.blockers },
    exchanges
  };
}

/** Admin → Live Trading data: switch, capability evidence, every connection (no secrets), contract allowlist. */
export async function adminLiveData() {
  const db = getDb();
  const contracts = await db
    .select({ id: schema.instruments.id, exchange: schema.instruments.exchange, symbol: schema.instruments.symbol, exchangeSymbol: schema.instruments.exchangeSymbol, status: schema.instruments.status, isFixture: schema.instruments.isFixture, liveAllowed: schema.instruments.liveAllowed })
    .from(schema.instruments)
    .orderBy(asc(schema.instruments.symbol), asc(schema.instruments.exchange));
  const control = await getLiveControl(db);
  const connections = await listConnections(db);
  const rows = await db.select().from(schema.exchangeConnections).where(ne(schema.exchangeConnections.status, 'REVOKED'));
  const state = controlState(control);
  const evidence = liveControlDto(control).capabilities as Record<string, { state: string } | undefined>;
  const caps = [...MEXC_CAPABILITIES, ...BITUNIX_CAPABILITIES, ...LIGHTER_CAPABILITIES].map((c) => ({ id: c.id, exchange: capabilityExchange(c.id), summary: c.summary, documented: c.documented, mock: c.mock, readOnly: c.readOnly, gaps: c.gaps, docs: c.docs }));

  // Per connection: every condition that blocks a regular (signal-driven) Live entry on THAT
  // exchange — the same function the investor's own pages use.
  const blockersOf = (row: ConnectionRow) => {
    const ex = (row.exchange === 'BITUNIX' || row.exchange === 'LIGHTER' ? row.exchange : 'MEXC') as 'MEXC' | 'BITUNIX' | 'LIGHTER';
    const allowlisted = contracts.some((x) => x.exchange === ex && x.status === 'PUBLISHED' && x.liveAllowed);
    return entryBlockersFor(db, ex, row.ownerId, row, { state, evidence, allowlisted });
  };
  const blockersById = new Map(await Promise.all(rows.map(async (r) => [r.id, await blockersOf(r)] as const)));

  // Per exchange: platform gates, this exchange's capability records (PILOT_ACCEPTED is shown as
  // such, and lets the adapter send that order type), allowlisted contracts and account readiness.
  const exchanges = LIVE_EXCHANGES.map((ex) => {
    const platform = liveAccountBlockers(state, null, '', true)
      .filter((b) => b.reason === 'LIVE_TRANSPORT_DISABLED' || b.reason === 'LIVE_PLATFORM_DISABLED' || b.reason === 'LIVE_PLATFORM_HALTED')
      .map((b) => ({ reason: b.reason as string, text: liveRefusalText(b.reason, ex) }));
    const capabilities = caps.filter((c) => c.exchange === ex).map((c) => ({ id: c.id, state: (evidence[c.id]?.state ?? 'PENDING') as 'VERIFIED' | 'PILOT_ACCEPTED' | 'PENDING' }));
    const allowlisted = contracts.filter((x) => x.exchange === ex && x.status === 'PUBLISHED' && x.liveAllowed).map((x) => x.exchangeSymbol || x.symbol);
    const accounts = connections.filter((c) => c.exchange === ex).map((c) => ({ email: c.owner.email, blockers: blockersById.get(c.id) ?? [] }));
    const blocking: { reason: string; text: string }[] = [...platform];
    // Only the capabilities the order path actually checks (MEXC read-only rows are evidence, not gates).
    const gating = new Set<string>(ex === 'MEXC' ? ORDER_CAPABILITIES : ex === 'BITUNIX' ? BITUNIX_CAPABILITIES.map((c) => c.id) : [...LIGHTER_ACCOUNT_CAPABILITIES, 'LIGHTER_OPEN_WITH_LINKED_STOP', 'LIGHTER_REDUCE_ONLY_CLOSE']);
    const pending = capabilities.filter((x) => x.state === 'PENDING' && gating.has(x.id)).map((x) => x.id);
    if (pending.length)
      blocking.push({ reason: 'CAPABILITY_PENDING', text: `No operator record (VERIFIED or PILOT_ACCEPTED) for ${pending.join(', ')}: the ${exchangeLabel(ex)} adapter refuses ${pending.length === 1 ? 'that order type' : 'those order types'} (CAPABILITY_UNVERIFIED).` });
    if (!allowlisted.length) blocking.push({ reason: 'LIVE_CONTRACT_NOT_ALLOWED', text: `No published ${exchangeLabel(ex)} contract is on the Live allowlist.` });
    if (!accounts.length) blocking.push({ reason: 'LIVE_CONNECTION_MISSING', text: `No investor has connected a ${exchangeLabel(ex)} account.` });
    else if (!accounts.some((a) => a.blockers.length === 0))
      blocking.push({ reason: 'NO_READY_ACCOUNT', text: `No ${exchangeLabel(ex)} account passes every account gate (see the accounts below for each one's blockers).` });
    return {
      exchange: ex,
      label: exchangeLabel(ex),
      capabilities,
      pilotAccepted: capabilities.filter((c) => c.state === 'PILOT_ACCEPTED').map((c) => c.id),
      allowlisted,
      readyAccounts: accounts.filter((a) => a.blockers.length === 0).length,
      accounts: accounts.length,
      blocking
    };
  });

  return {
    control: liveControlDto(control),
    capabilities: caps,
    exchanges,
    connections: connections.map((c) => ({ ...c, blockers: blockersById.get(c.id) ?? [] })),
    contracts
  };
}

const LIVE_EXCHANGES = ['MEXC', 'BITUNIX', 'LIGHTER'] as const;
const capabilityExchange = (id: string) => (id.startsWith('BITUNIX_') ? 'BITUNIX' : id.startsWith('LIGHTER_') ? 'LIGHTER' : 'MEXC');

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
