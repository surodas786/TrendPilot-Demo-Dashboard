import type { BitunixSyncResult, LiveSyncSummary } from '@trendpilot/db';
import type { ExchangeId } from '@trendpilot/domain';

/* Investor "Sync with <exchange>" (My Trades / My Holdings → Live): per-exchange availability and result wording. */

/** Why an exchange has no investor-triggered sync (shown instead of the button). Null = it has one. */
export function manualSyncUnavailable(exchange: ExchangeId): string | null {
  if (exchange === 'LIGHTER')
    return 'Lighter accounts are reconciled automatically by TrendPilot every minute (balance, positions, stop coverage). That run may renew stop orders, so it is not started from this page.';
  return null;
}

/** One result shape for every exchange, with that exchange's own wording. */
export interface InvestorSyncResult {
  exchange: ExchangeId;
  connectionId: string;
  ok: boolean;
  busy: boolean;
  error: string | null;
  /** What changed, one line each; empty = TrendPilot matches the exchange. */
  lines: string[];
  drift: { kind: string; symbol: string; detail: string }[];
  lastSyncAt: string | null;
  lastSyncOkAt: string | null;
  lastSyncError: string | null;
}

export function mexcLines(s: LiveSyncSummary): string[] {
  const out: string[] = [];
  for (const c of s.closes) {
    if (c.result === 'FULL') out.push(`${c.symbol}: closed on MEXC — moved to closed positions`);
    else if (c.result === 'FULL_FILLS_PENDING') out.push(`${c.symbol}: closed on MEXC — moved to closed positions · fill details pending${c.pendingContracts ? ` (${c.pendingContracts} contracts)` : ''}`);
    else if (c.result === 'FILLS_BACKFILLED') out.push(`${c.symbol}: exit price, fees and P&L filled in from MEXC`);
    else if (c.result === 'PARTIAL')
      out.push(`${c.symbol}: ${c.platformContracts} contracts remain; stop ${c.stopCoverage === 'FULL' ? `covers them (${c.stopContracts})` : c.stopCoverage === 'PARTIAL' ? `covers only ${c.stopContracts}` : 'does not cover them'}`);
    else out.push(`${c.symbol}: ${c.exchangeContracts === '0' ? 'closed on MEXC' : `MEXC holds ${c.exchangeContracts}`} · fill details pending`);
  }
  for (const k of s.skipped) out.push(`${k.symbol}: not reconciled yet (${k.reason})`);
  return out;
}

export function bitunixLines(r: BitunixSyncResult): string[] {
  const out: string[] = [];
  if (r.closed) out.push(`${r.closed} position(s) closed on Bitunix — moved to closed positions`);
  if (r.closePending) out.push(`${r.closePending} close(s) seen on Bitunix · fill details pending`);
  if (r.reduced) out.push(`${r.reduced} position(s) reduced on Bitunix`);
  if (r.increased) out.push(`${r.increased} position(s) increased on Bitunix`);
  if (r.opened) out.push(`${r.opened} position(s) on Bitunix not opened by TrendPilot`);
  // Unresolved TrendPilot orders reconciled in this run: what Bitunix showed for each.
  for (const i of r.intents ?? []) {
    if (i.result === 'FILLED') out.push(`Order ${i.clientOrderId}: filled on Bitunix (order ${i.exchangeOrderId}) — position recorded`);
    else if (i.result === 'REJECTED') out.push(`Order ${i.clientOrderId}: not filled on Bitunix — reservation released`);
    else if (i.result === 'NOT_AT_VENUE') out.push(`Order ${i.clientOrderId}: Bitunix never accepted it — reservation released`);
    else if (i.result === 'PENDING') out.push(`Order ${i.clientOrderId}: still unresolved — ${i.detail}`);
  }
  return out;
}

