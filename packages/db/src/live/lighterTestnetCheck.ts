import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { Decimal, LIGHTER_ENVIRONMENTS, LIGHTER_TX_TYPE, smallestLighterSize, type LighterLiveInputs } from '@trendpilot/domain';
import type { Db } from '../client';
import { LighterPublicClient, type LighterMarket } from '../market/lighterPublic';
import { exchangeConnections } from '../schema';
import { LIGHTER_CAPABILITIES } from './capabilities';
import { lighterApiFor, lighterLiveInputs, lighterScopeOf, lighterSignerFor, saveLighterConnection } from './lighterConnection';
import { acquireLighterKeyLease, lighterVenue, releaseLighterKeyLease, type LighterVenueMarket } from './lighterOrders';
import { lighterTestnetEnabled, LighterTestnetConfigError, type LighterApi, type LighterSigner } from './lighterPrivate';

/**
 * Lighter OFFICIAL TESTNET verification (Lighter plan Step 4C). Runs the real Lighter venue (linked
 * OTO entry + size-0 reduce-only stop, reduce-only close) against testnet, for ONE investor's
 * testnet connection, in an isolated local test setup only:
 *  - LIGHTER_TESTNET=enabled (refused in production and outside a *_test / *_testnet database);
 *  - the API must prove it is testnet (ZkLighter contract), and the market is resolved by symbol
 *    from the TESTNET catalog — mainnet market IDs (e.g. XAU 92) are never used;
 *  - the connection is saved and verified through the normal flow with environment TESTNET; its
 *    nonces and transactions are keyed by environment, separate from mainnet; testnet never
 *    reaches the Live execution path or the Live ledger.
 * Mainnet orders stay refused (separate gate). Output is evidence only: no key, token or signed
 * payload is ever included.
 */

export interface TestnetCheckInput {
  ownerId: string;
  accountIndex: number;
  apiKeyIndex: number;
  apiPrivateKey: string;
  /** Testnet market symbol, e.g. "ETH". Never a market ID. */
  symbol: string;
  /** Stop distance from the fresh book, percent (explicit; no default). */
  stopDistancePct: string;
  sides?: ('LONG' | 'SHORT')[];
}

export interface TestnetStepEvidence {
  side: 'LONG' | 'SHORT';
  size: string;
  entry: { status: string; reason?: string; filled?: string; price?: string; fee?: string };
  stopAfterFill: { status: string; contracts: string; triggerPrice: string | null; reduceOnly: boolean; coversFill: boolean } | null;
  close: { status: string; reason?: string; filled?: string } | null;
  stopAfterClose: string;
  positionAfter: string;
  cleanup: string[];
}

export interface TestnetCheckReport {
  environment: 'TESTNET';
  identity: { networkId: number; contractAddress: string };
  market: { symbol: string; marketId: number; sizeDecimals: number; priceDecimals: number; minBase: string; minQuote: string };
  xau: 'NOT_ON_TESTNET' | 'PRESENT';
  connection: { status: string; keyMatch: unknown };
  steps: TestnetStepEvidence[];
  partialFill: 'NOT_ATTEMPTED: not reproducible on demand on a shared testnet book';
  notes: string[];
}

export interface TestnetCheckDeps {
  /** Testnet catalog source (default: the public testnet API). */
  catalog?: { environment(): Promise<{ networkId: number; contractAddress: string }>; markets(): Promise<LighterMarket[]> };
  api?: LighterApi;
  signer?: LighterSigner;
  sleep?: (ms: number) => Promise<void>;
  confirm?: { attempts: number; delayMs: number };
}

const D = (v: Decimal.Value) => new Decimal(v);

export async function runLighterTestnetCheck(db: Db, i: TestnetCheckInput, deps: TestnetCheckDeps = {}, env: Record<string, string | undefined> = process.env): Promise<TestnetCheckReport> {
  if (!lighterTestnetEnabled(env)) throw new LighterTestnetConfigError('Set LIGHTER_TESTNET=enabled (isolated local test setup only) to run the testnet check.');
  const notes: string[] = [];
  const t = LIGHTER_ENVIRONMENTS.TESTNET;
  const catalog = deps.catalog ?? new LighterPublicClient({ baseUrl: env.LIGHTER_TESTNET_BASE_URL || t.baseUrl });
  const identity = await catalog.environment();
  if (identity.contractAddress.toLowerCase() !== t.contractAddress.toLowerCase()) throw new LighterTestnetConfigError(`The configured API is not Lighter testnet (contract ${identity.contractAddress}).`);
  const markets = (await catalog.markets()).filter((m) => m.marketType === 'perp');
  const xau = markets.some((m) => /^XAU/i.test(m.symbol)) ? 'PRESENT' : 'NOT_ON_TESTNET';
  const m = markets.find((x) => x.symbol.toUpperCase() === i.symbol.toUpperCase());
  if (!m) throw new LighterTestnetConfigError(`Testnet has no perp "${i.symbol}" (markets: ${markets.map((x) => x.symbol).join(', ')}).`);
  if (m.status !== 'active') throw new LighterTestnetConfigError(`Testnet market ${m.symbol} is ${m.status}.`);
  if (m.quoteAssetId !== 0) throw new LighterTestnetConfigError(`Testnet market ${m.symbol} is not USDC-settled.`);
  const market: LighterVenueMarket = { marketId: m.marketId, symbol: m.symbol, sizeDecimals: m.sizeDecimals, priceDecimals: m.priceDecimals, minBaseAmount: m.minBaseAmount, minQuoteAmount: m.minQuoteAmount, maxQuoteAmount: m.orderQuoteLimit };

  // The normal connection flow, environment TESTNET (identity + key match through the signer).
  const conn = await saveLighterConnection(db, i.ownerId, { environment: 'TESTNET', accountIndex: i.accountIndex, apiKeyIndex: i.apiKeyIndex, apiPrivateKey: i.apiPrivateKey }, 'lighter-testnet-check', env);
  const v = (conn.verification ?? {}) as { apiKey?: { keyMatch?: unknown }; error?: string };
  const report: TestnetCheckReport = {
    environment: 'TESTNET',
    identity,
    market: { symbol: m.symbol, marketId: m.marketId, sizeDecimals: m.sizeDecimals, priceDecimals: m.priceDecimals, minBase: m.minBaseAmount, minQuote: m.minQuoteAmount },
    xau,
    connection: { status: conn.status, keyMatch: v.apiKey?.keyMatch ?? null },
    steps: [],
    partialFill: 'NOT_ATTEMPTED: not reproducible on demand on a shared testnet book',
    notes
  };
  if (conn.status !== 'VERIFIED') {
    notes.push(`Connection not verified: ${v.error ?? conn.status}. No order was sent.`);
    return report;
  }

  const api = deps.api ?? lighterApiFor(conn, env);
  const signer = deps.signer ?? lighterSignerFor(conn);
  const scope = lighterScopeOf(conn);
  const inputs: LighterLiveInputs = lighterLiveInputs(env);
  // Testnet harness: every Lighter capability is treated as verified FOR THIS RUN ONLY; the testnet
  // gate (openLighterOrderTransport) is what allows the sends, and it never opens mainnet.
  const capabilities = Object.fromEntries(LIGHTER_CAPABILITIES.map((c) => [c.id, 'VERIFIED' as const]));
  const venue = lighterVenue({ db, scope, api, signer, inputs, capabilities, marketFor: async () => market, confirm: deps.confirm ?? { attempts: 10, delayMs: 1500 }, sleep: deps.sleep });
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));

  for (const side of i.sides ?? (['LONG', 'SHORT'] as const)) {
    const cleanup: string[] = [];
    const snap = await api.account(scope.accountIndex);
    const here = snap?.positions.find((p) => p.marketId === market.marketId);
    if (here && (D(here.size).gt(0) || here.openOrderCount + here.pendingOrderCount > 0)) {
      notes.push(`${side}: skipped — the testnet account already holds a position or orders on ${market.symbol}; clean it up first.`);
      continue;
    }
    // Smallest valid size: max(min_base_amount, min_quote_amount / ask) rounded UP to the size step (+2% headroom on the quote minimum).
    const book = await api.orderBook(market.marketId);
    if (!book.bestBid || !book.bestAsk) {
      notes.push(`${side}: skipped — empty testnet book on ${market.symbol}.`);
      continue;
    }
    const step = D(10).pow(-market.sizeDecimals);
    const size = smallestLighterSize(market, book.bestAsk, '2');
    const ref = side === 'LONG' ? D(book.bestBid) : D(book.bestAsk);
    const stop = (side === 'LONG' ? ref.times(D(1).minus(D(i.stopDistancePct).div(100))) : ref.times(D(1).plus(D(i.stopDistancePct).div(100)))).toDecimalPlaces(market.priceDecimals).toFixed();
    const lev = here?.leverage ?? null;
    const ev: TestnetStepEvidence = { side, size, entry: { status: 'NOT_SENT' }, stopAfterFill: null, close: null, stopAfterClose: 'n/a', positionAfter: 'n/a', cleanup };
    report.steps.push(ev);
    if (!lev || !here?.marginMode) {
      ev.entry = { status: 'NOT_SENT', reason: `Lighter reports no leverage / margin mode for ${market.symbol}; set them on the testnet account first` };
      continue;
    }
    const cid = `tn-${side.toLowerCase()}-${randomUUID().slice(0, 8)}`;
    const opened = await venue.placeOpeningOrderWithStop({
      paperAccountId: 'lighter-testnet-check',
      clientOrderId: cid,
      instrumentId: `testnet:${market.marketId}`,
      side,
      contracts: size,
      contract: { multiplier: '1', qtyStep: step.toFixed(), minQty: market.minBaseAmount, takerFeeRate: '0' },
      quote: { bid: book.bestBid, ask: book.bestAsk },
      stop: { price: stop, basis: 'MARK' },
      now: new Date(),
      leverage: lev,
      marginMode: here.marginMode
    });
    if (opened.status !== 'FILLED') {
      ev.entry = { status: opened.status, reason: opened.reason };
      continue;
    }
    ev.entry = { status: 'FILLED', filled: opened.fill.contracts, price: opened.fill.price, fee: opened.fill.fee };
    const prot = await venue.inspectProtection(opened.stop.orderId, `testnet:${market.marketId}`);
    ev.stopAfterFill = prot
      ? { status: String(prot.status), contracts: prot.contracts, triggerPrice: prot.triggerPrice, reduceOnly: prot.reduceOnly, coversFill: prot.status === 'ACTIVE' && prot.reduceOnly && D(prot.contracts).eq(opened.fill.contracts) }
      : null;
    await sleep(2_000);
    const held = await venue.position('lighter-testnet-check', `testnet:${market.marketId}`, undefined, side);
    const closed = await venue.placeReduceOnlyClose({
      paperAccountId: 'lighter-testnet-check',
      clientOrderId: `${cid}-close`,
      instrumentId: `testnet:${market.marketId}`,
      positionSide: side,
      contracts: held.contracts,
      contract: { multiplier: '1', qtyStep: step.toFixed(), takerFeeRate: '0' },
      quote: { bid: book.bestBid, ask: book.bestAsk, mark: book.bestBid, last: book.bestBid },
      now: new Date()
    });
    ev.close = closed.status === 'REJECTED' ? { status: 'REJECTED', reason: closed.reason } : { status: closed.status, filled: closed.fill.contracts };
    await sleep(2_000);
    ev.positionAfter = (await venue.position('lighter-testnet-check', `testnet:${market.marketId}`)).contracts;
    const after = await venue.inspectProtection(opened.stop.orderId, `testnet:${market.marketId}`);
    ev.stopAfterClose = after ? String(after.status) : 'gone';
    // Cleanup: a stop still resting on a flat market is cancelled (testnet gate; same nonce lease).
    if (after && (after.status === 'ACTIVE' || String(after.status).startsWith('WAITING')) && D(ev.positionAfter).isZero()) {
      const idx = Number(opened.stop.orderId.split(':')[2]);
      const holder = `testnet-cleanup:${randomUUID()}`;
      if (await acquireLighterKeyLease(db, scope, holder, 30_000)) {
        try {
          const nonce = await api.nextNonce(scope.accountIndex, scope.apiKeyIndex);
          const tx = await signer.signCancelOrder({ marketIndex: market.marketId, index: idx }, nonce);
          await api.sendTx(LIGHTER_TX_TYPE.CANCEL_ORDER, tx.txInfo);
          cleanup.push(`cancel of stop ${idx} accepted (tx ${tx.txHash.slice(0, 12)}…)`);
        } finally {
          await releaseLighterKeyLease(db, scope, holder);
        }
        await sleep(2_000);
        const s = await venue.inspectProtection(opened.stop.orderId, `testnet:${market.marketId}`);
        cleanup.push(`stop after cancel: ${s ? s.status : 'gone'}`);
      } else cleanup.push('cancel not sent: nonce lease busy');
    }
  }
  return report;
}

/** The testnet connection row of an investor, if any (for the CLI's summary). */
export async function testnetConnectionOf(db: Db, ownerId: string) {
  const [c] = await db.select().from(exchangeConnections).where(and(eq(exchangeConnections.ownerId, ownerId), eq(exchangeConnections.exchange, 'LIGHTER'), eq(exchangeConnections.venueEnvironment, 'TESTNET')));
  return c ?? null;
}
