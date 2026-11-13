/**
 * Read-only Live entry preflight for one investor's Live order block. Runs the worker's own code
 * against the current database state: the routing screen (`evaluateBlockForSignal`: pause,
 * direction, weekday, trading window, freshness) and phase-1 entry (`assessEntry`: exposure,
 * quote, EMA, sizing, risk, margin, then the Live gates). It reports what an alert for `--side`
 * at `--at` (default now) would do, and every blocker.
 *
 * One READ ONLY transaction, no account lock, no rows created: the database refuses any write.
 * No alert is created, no job is queued and nothing is sent to MEXC. The worker's last check
 * right before sending (the position MEXC reports) needs the exchange and is not run here.
 *
 *   npm run ops:live-preflight -- --email investor@… --symbol XAU_USDT --side SHORT [--at 2026-11-13T16:50:00+06:00] [--ref 4100.5]
 */
import { and, eq, or } from 'drizzle-orm';
import { Decimal, ENTRY_REASON_TEXT, evaluateBlockForSignal, INTERVAL_TIMEFRAME, lastClosedBarOpen, LIVE_REFUSAL_TEXT, liveAccountBlockers, type SignalInterval, type Weekday } from '@trendpilot/domain';
import { createDb } from '../client';
import { loadRootEnv, requireEnv } from '../env';
import { connectionFor, connectionState, controlState, getLiveControl, limitsOf } from '../live/liveMode';
import { latestQuote } from '../paper/market';
import { assessEntry, windowOf } from '../paper/entry';
import { instruments, orderBlocks, paperAccounts, strategyVersions, users } from '../schema';

loadRootEnv();
const arg = (n: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const email = arg('email');
const symbol = (arg('symbol') ?? 'XAU_USDT').toUpperCase();
const side = (arg('side') ?? 'SHORT').toUpperCase() as 'LONG' | 'SHORT';
const now = arg('at') ? new Date(arg('at')!) : new Date();
if (!email || (side !== 'LONG' && side !== 'SHORT') || Number.isNaN(now.getTime())) {
  console.error('Usage: --email <investor> --symbol XAU_USDT --side SHORT|LONG [--at ISO-with-offset] [--ref price]');
  process.exit(2);
}

const h = createDb(requireEnv('DATABASE_URL'), 1);
const out: Record<string, unknown> = { readOnly: true, evaluatedAt: now.toISOString(), side };
const blockers: string[] = [];

try {
  await h.db.transaction(
    async (tx) => {
      const [u] = await tx.select().from(users).where(eq(users.email, email));
      if (!u) throw new Error(`No user ${email}.`);
      const [inst] = await tx
        .select()
        .from(instruments)
        .where(or(eq(instruments.exchangeSymbol, symbol), eq(instruments.symbol, symbol.replace('_', '')), eq(instruments.symbol, symbol)));
      if (!inst) throw new Error(`No instrument ${symbol}.`);
      const [row] = await tx
        .select({ block: orderBlocks, version: strategyVersions })
        .from(orderBlocks)
        .innerJoin(strategyVersions, eq(strategyVersions.id, orderBlocks.strategyVersionId))
        .where(and(eq(orderBlocks.ownerId, u.id), eq(orderBlocks.instrumentId, inst.id), eq(orderBlocks.mode, 'LIVE')));
      if (!row) throw new Error(`${email} has no Live order block for ${symbol}.`);
      const { block, version } = row;
      out.block = {
        id: block.id,
        revision: block.revision,
        mode: block.mode,
        status: block.status,
        direction: block.direction,
        weekdays: block.weekdays,
        tradingWindow: windowOf(block) ?? 'all day',
        timezone: block.timezone,
        orderCostUsdt: block.orderCostUsdt,
        leverage: block.leverage,
        marginMode: block.marginMode,
        stop: block.stop,
        strategyVersion: version.version,
        permittedDirections: version.permittedDirections,
        emaFilter: version.emaFilter
      };

      // Routing screen, as dispatch runs it for a fresh alert on the pinned version's timeframe.
      const interval = (Object.entries(INTERVAL_TIMEFRAME).find(([, tf]) => tf === version.timeframe)?.[0] ?? '15') as SignalInterval;
      const barOpenAt = lastClosedBarOpen(now, interval);
      const screen = evaluateBlockForSignal({
        action: side === 'LONG' ? 'BULLISH_FLIP' : 'BEARISH_FLIP',
        interval,
        // A fresh alert: freshness is not what this preflight tests.
        barCloseAt: now,
        evaluatedAt: now,
        user: { status: u.status },
        block: { status: block.status, mode: block.mode, direction: block.direction, weekdays: block.weekdays as Weekday[], timezone: block.timezone, tradingWindow: windowOf(block) },
        version: { timeframe: version.timeframe, permittedDirections: version.permittedDirections, signalMaxAgeSeconds: version.signalMaxAgeSeconds }
      });
      out.routingScreen = { status: screen.status, failedChecks: screen.failed };
      for (const f of screen.failed) blockers.push(`routing: ${f}`);

      // The Live account as the worker would lock it (read here without a lock; never created).
      const [account] = await tx.select().from(paperAccounts).where(and(eq(paperAccounts.ownerId, u.id), eq(paperAccounts.mode, 'LIVE')));
      const control = await getLiveControl(tx);
      const conn = await connectionFor(tx, u.id);
      out.live = {
        transportEnabled: controlState(control).transportEnabled,
        platformLiveEnabled: control.liveEnabled,
        platformEntriesHalted: control.entriesHalted,
        contractLiveAllowed: inst.liveAllowed,
        connection: conn
          ? { status: conn.status, positionMode: conn.positionMode, approved: !!conn.approvedAt, liveEnabled: conn.liveEnabled, entriesHalted: conn.entriesHalted, haltReason: conn.haltReason, limits: limitsOf(conn), lastSyncAt: conn.lastSyncAt }
          : null,
        accountBlockers: liveAccountBlockers(controlState(control), conn ? connectionState(conn) : null, u.id, inst.liveAllowed).map((b) => `${b.reason}: ${LIVE_REFUSAL_TEXT[b.reason]}`)
      };
      if (!account) {
        blockers.push('account: no Live account yet (created on the first MEXC balance sync); available margin is 0');
        out.account = null;
        return;
      }
      out.account = {
        wallet: account.walletBalance,
        positionMargin: account.positionMargin,
        orderReserve: account.orderReserve,
        exchangeEquity: account.exchangeEquity,
        exchangeAvailableToOpen: account.exchangeAvailable,
        exchangeSyncedAt: account.exchangeSyncedAt
      };

      const quote = await latestQuote(tx, block.instrumentId, now);
      const mid = quote ? new Decimal(quote.bid).plus(quote.ask).div(2).toFixed() : null;
      const referencePrice = arg('ref') ?? mid ?? '0';
      out.quote = quote ? { bid: quote.bid, ask: quote.ask, asOf: quote.asOf, source: quote.source, referencePriceUsed: referencePrice } : null;

      const { result, live, availableUsdt } = await assessEntry(tx, { event: { interval, barOpenAt, referencePrice }, block, version, side, now, account });
      out.availableMarginUsdt = availableUsdt;
      if (!result.ok) {
        blockers.push(`entry: ${result.reason}: ${ENTRY_REASON_TEXT[result.reason]} ${JSON.stringify(result.detail)}`);
        out.entry = { ok: false, reason: result.reason, detail: result.detail };
        return;
      }
      const s = result.sizing;
      out.entry = {
        ok: true,
        contracts: s.contracts,
        quantity: s.quantity,
        entryPrice: `${s.entryPrice} (${s.entryPriceBasis})`,
        notionalUsdt: s.estimatedNotionalUsdt,
        leverage: block.leverage,
        marginUsdt: s.estimatedMarginUsdt,
        requiredWithFeeUsdt: result.requiredUsdt,
        stopPrice: `${s.stopPrice} (${s.stopBasis})`,
        lossToStopUsdt: s.lossToStopUsdt,
        liquidationEstimate: result.liquidationPrice
      };
      out.liveGate = live ? { ok: live.verdict.ok, reason: live.verdict.ok ? null : live.verdict.reason, detail: live.verdict.ok ? null : (live.verdict.detail ?? null), text: live.reasonText } : null;
      if (live && !live.verdict.ok) for (const b of live.blockers) blockers.push(`live: ${b}: ${LIVE_REFUSAL_TEXT[b]}`);
    },
    { accessMode: 'read only' }
  );
  out.blockers = blockers;
  out.verdict = blockers.length ? 'BLOCKED: a Live alert now would record these reasons and queue nothing' : 'ELIGIBLE: a Live alert now would queue one Live paper.submit job (MEXC position re-checked at send)';
  console.log(JSON.stringify(out, null, 2));
} catch (e) {
  console.error(`Preflight failed: ${(e as Error).message}`);
  process.exitCode = 1;
} finally {
  await h.close();
}
