/**
 * Read-only, no-order readiness check of the TradingView routes for one chart. For each action it
 * resolves the enabled route exactly as webhook intake does (ingress + source exchange + ticker +
 * interval + action), then prints:
 *  - the route's signal contract and whether it is the chart's own contract (same exchange/ticker);
 *  - strategy compatibility (newest published version: timeframe and approved contract);
 *  - the execution instruments an accepted alert would be dispatched to (signal contract plus
 *    enabled explicit targets) with their exchanges, and the order blocks on them in the lineage.
 *
 * With --expect-exchange it exits 1 unless every action resolves to exactly one route whose
 * execution instruments are all on that exchange. One READ ONLY transaction: the database refuses
 * any write. No alert is created, no job is queued, nothing is sent to any exchange.
 *
 *   npm run ops:route-readiness -- --exchange BITUNIX --symbol XAUUSDT.P --interval 5 --expect-exchange BITUNIX
 */
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { contractMatchesSource, normalizeSource, SIGNAL_ACTIONS, type SignalAction } from '@trendpilot/domain';
import { createDb } from '../client';
import { loadRootEnv, requireEnv } from '../env';
import { instruments, orderBlocks, webhookIngress, signalRoutes, signalRouteTargets, strategyPackages, strategyVersions } from '../schema';
import { routeStrategyIssues } from '../signals/routeAdmin';

loadRootEnv();
const arg = (n: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const exchange = normalizeSource(arg('exchange') ?? '');
const symbol = normalizeSource(arg('symbol') ?? '');
const interval = arg('interval') ?? '5';
const expect = arg('expect-exchange') ? normalizeSource(arg('expect-exchange')!) : null;
const actions = (arg('actions') ?? 'BULLISH_FLIP,BEARISH_FLIP').split(',').map((a) => a.trim()) as SignalAction[];
if (!exchange || !symbol || !['5', '15'].includes(interval) || actions.some((a) => !SIGNAL_ACTIONS.includes(a))) {
  console.error('Usage: --exchange BITUNIX --symbol XAUUSDT.P [--interval 5] [--actions BULLISH_FLIP,BEARISH_FLIP] [--expect-exchange BITUNIX]');
  process.exit(2);
}
console.log(`# Route readiness (no orders) — ${new Date().toISOString()}\nsource: ${exchange}:${symbol} ${interval}m · actions: ${actions.join(', ')}${expect ? ` · expected execution exchange: ${expect}` : ''}`);

const h = createDb(requireEnv('DATABASE_URL'), 1);
const failures: string[] = [];
try {
  await h.db.transaction(
    async (tx) => {
      for (const action of actions) {
        console.log(`\n## ${action}`);
        const routes = await tx
          .select({ r: signalRoutes, ns: webhookIngress.namespace })
          .from(signalRoutes)
          .innerJoin(webhookIngress, eq(webhookIngress.id, signalRoutes.ingressId))
          .where(and(eq(signalRoutes.sourceExchange, exchange), eq(signalRoutes.sourceSymbol, symbol), eq(signalRoutes.interval, interval), eq(signalRoutes.action, action), eq(signalRoutes.enabled, true)));
        if (routes.length !== 1) {
          const why = routes.length ? `${routes.length} enabled routes match (ROUTE_AMBIGUOUS)` : 'no enabled route matches (ROUTE_NOT_FOUND)';
          console.log(why);
          failures.push(`${action}: ${why}`);
          continue;
        }
        const { r, ns } = routes[0]!;
        const [primary] = await tx.select().from(instruments).where(eq(instruments.id, r.instrumentId));
        const [pkg] = await tx.select({ name: strategyPackages.name }).from(strategyPackages).where(eq(strategyPackages.id, r.packageId));
        const ownContract = !!primary && contractMatchesSource(primary, r.sourceExchange, r.sourceSymbol);
        console.table([{ route: r.name, id: r.id, ingress: ns, kind: r.kind, lineage: pkg?.name, signalContract: `${primary?.exchange}:${primary?.exchangeSymbol} (${primary?.status})`, chartsOwnContract: ownContract }]);
        if (!ownContract) failures.push(`${action}: signal contract ${primary?.exchange}:${primary?.exchangeSymbol} is not the ${exchange}:${symbol} contract`);
        const issues = await routeStrategyIssues(tx, { ...r, interval: r.interval as '5' | '15' });
        if (issues.length) {
          console.log('strategy issues:', issues.map((i) => i.message).join(' | '));
          failures.push(`${action}: strategy issues`);
        }

        const targets = await tx.select().from(signalRouteTargets).where(and(eq(signalRouteTargets.routeId, r.id), eq(signalRouteTargets.enabled, true)));
        // Same set intake snapshots and dispatch evaluates: the signal contract plus enabled targets.
        const ids = r.kind === 'ACTIONABLE' ? [r.instrumentId, ...targets.map((t) => t.instrumentId).filter((id) => id !== r.instrumentId)] : [];
        const exec = ids.length ? await tx.select().from(instruments).where(inArray(instruments.id, ids)) : [];
        console.log(`execution instruments (${exec.length}):`);
        if (exec.length) console.table(exec.map((i) => ({ exchange: i.exchange, exchangeSymbol: i.exchangeSymbol, status: i.status, via: i.id === r.instrumentId ? 'SIGNAL_CONTRACT' : 'TARGET' })));
        const blocks = ids.length
          ? await tx
              .select({ id: orderBlocks.id, mode: orderBlocks.mode, status: orderBlocks.status, exchange: instruments.exchange, symbol: instruments.exchangeSymbol, version: strategyVersions.version })
              .from(orderBlocks)
              .innerJoin(strategyVersions, eq(strategyVersions.id, orderBlocks.strategyVersionId))
              .innerJoin(instruments, eq(instruments.id, orderBlocks.instrumentId))
              .where(and(inArray(orderBlocks.instrumentId, ids), eq(strategyVersions.packageId, r.packageId), isNull(orderBlocks.archivedAt)))
          : [];
        console.log(`order blocks that would be evaluated (${blocks.length}):`);
        if (blocks.length) console.table(blocks);
        if (r.kind !== 'ACTIONABLE') failures.push(`${action}: route is ${r.kind}, nothing would execute`);
        if (expect) {
          const other = exec.filter((i) => i.exchange !== expect);
          if (!exec.length) failures.push(`${action}: no execution instrument`);
          if (other.length) failures.push(`${action}: also executes on ${other.map((i) => `${i.exchange}:${i.exchangeSymbol}`).join(', ')}`);
        }
      }
    },
    { accessMode: 'read only' }
  );
} finally {
  await h.close();
}
console.log(failures.length ? `\nNOT READY:\n- ${failures.join('\n- ')}` : `\nREADY: every action resolves to one route${expect ? ` executing only on ${expect}` : ''}. No order was sent.`);
if (failures.length) process.exitCode = 1;
