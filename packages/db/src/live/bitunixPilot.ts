import { createHash } from 'node:crypto';
import { Decimal } from '@trendpilot/domain';
import type { CloseRequest, ExecutionVenue } from '../venue/types';
import type { OpeningRequest, SimResult } from '../paper/simulator';
import { readHistoryTrades, readPendingPositions } from './bitunixAccount';
import { buildBitunixCloseOrder, buildBitunixOpenOrder, checkOpenQty, slStopTypeOf, type BitunixContractSpec, type BitunixOrderRequester } from './bitunixOrders';

/**
 * Supervised Bitunix live pilot (Step 5): one investor, one approved contract, the smallest
 * exchange-valid quantity, within an operator-approved exposure. It exercises the four Hedge-mode
 * paths through the SAME Bitunix venue the Live flow uses (capability gates, Hedge-mode and
 * settings checks, stop in the entry, closes by positionId), and records sanitized evidence:
 * payloads, order/position IDs, the attached stops as listed, fill visibility delay, the clientId
 * lookups, and that closing one leg left the other untouched. Never keys, nonces or signatures.
 *
 * `planBitunixPilot` is pure (dry run). `runBitunixPilot` sends orders: callers reach it only with
 * the live order transport open (LIVE_ORDER_TRANSPORT=enabled in production) — see
 * docs/BITUNIX_PILOT_RUNBOOK.md.
 */

export interface BitunixPilotInput {
  symbol: string;
  contract: BitunixContractSpec;
  quote: { bid: string; ask: string };
  leverage: number;
  marginMode: 'ISOLATED' | 'CROSS';
  /** Stop distance from the executable price, in percent (both legs). */
  stopPct: string;
  basis: 'MARK' | 'LAST';
  /** Operator-approved notional cap for the whole pilot (both legs open at once). */
  maxExposureUsdt: string;
  clientIdPrefix: string;
}

export interface BitunixPilotPlan {
  ok: boolean;
  problems: string[];
  qty: string;
  notionalPerLegUsdt: string;
  exposureUsdt: string;
  marginPerLegUsdt: string;
  stops: { LONG: string; SHORT: string };
  steps: { step: string; payload: Record<string, unknown> }[];
}

const D = (v: Decimal.Value) => new Decimal(v);

/** The pilot as it would be sent: smallest valid quantity, stops, exposure, the four payloads. */
export function planBitunixPilot(i: BitunixPilotInput): BitunixPilotPlan {
  const problems: string[] = [];
  const qty = D(i.contract.minQty).toFixed();
  const qtyIssue = checkOpenQty(qty, i.contract);
  if (qtyIssue) problems.push(qtyIssue);
  const tick = D(i.contract.priceTick);
  const longStop = D(i.quote.ask).times(D(1).minus(D(i.stopPct).div(100))).div(tick).ceil().times(tick);
  const shortStop = D(i.quote.bid).times(D(1).plus(D(i.stopPct).div(100))).div(tick).floor().times(tick);
  const notional = D(qty).times(i.quote.ask);
  const exposure = notional.times(2);
  if (exposure.gt(i.maxExposureUsdt)) problems.push(`both legs (${exposure.toDecimalPlaces(4).toFixed()} USDT) exceed the operator-approved exposure ${i.maxExposureUsdt} USDT`);
  const stopType = slStopTypeOf(i.basis)!;
  const id = (k: string) => `${i.clientIdPrefix}-${k}`;
  return {
    ok: problems.length === 0,
    problems,
    qty,
    notionalPerLegUsdt: notional.toDecimalPlaces(4).toFixed(),
    exposureUsdt: exposure.toDecimalPlaces(4).toFixed(),
    marginPerLegUsdt: notional.div(i.leverage).toDecimalPlaces(4).toFixed(),
    stops: { LONG: longStop.toFixed(), SHORT: shortStop.toFixed() },
    steps: [
      { step: '1. open long (BUY+OPEN, stop attached)', payload: buildBitunixOpenOrder({ symbol: i.symbol, side: 'LONG', qty, clientId: id('ol'), stopPrice: longStop.toFixed(), stopType }) },
      { step: '2. open short (SELL+OPEN, stop attached)', payload: buildBitunixOpenOrder({ symbol: i.symbol, side: 'SHORT', qty, clientId: id('os'), stopPrice: shortStop.toFixed(), stopType }) },
      { step: '3. close long (BUY+CLOSE + long positionId); the short leg must be unchanged', payload: buildBitunixCloseOrder({ symbol: i.symbol, positionSide: 'LONG', positionId: '<long positionId>', qty, clientId: id('cl') }) },
      { step: '4. close short (SELL+CLOSE + short positionId)', payload: buildBitunixCloseOrder({ symbol: i.symbol, positionSide: 'SHORT', positionId: '<short positionId>', qty, clientId: id('cs') }) }
    ]
  };
}

export interface BitunixPilotEvidence {
  startedAt: string;
  finishedAt: string;
  symbol: string;
  qty: string;
  steps: { step: string; ok: boolean; detail: Record<string, unknown> }[];
  /** sha256 of the canonical evidence (without this field): referenced when a capability is marked VERIFIED. */
  digest: string;
}

/** The capability-evidence reference for a pilot run: `bitunix-pilot:<sha256>`. */
export const pilotReference = (e: Pick<BitunixPilotEvidence, 'digest'>) => `bitunix-pilot:${e.digest}`;

export function digestEvidence(e: Omit<BitunixPilotEvidence, 'digest'>): string {
  return createHash('sha256').update(JSON.stringify(e)).digest('hex');
}

/**
 * Runs the pilot against the venue (orders are REAL when the venue's transport is the live one).
 * Stops at the first failed step; whatever is open stays protected by its attached stop and is
 * reported for the operator.
 */
export async function runBitunixPilot(
  venue: ExecutionVenue,
  r: BitunixOrderRequester,
  i: BitunixPilotInput & { instrumentId: string; paperAccountId: string },
  o: { now?: () => Date; sleep?: (ms: number) => Promise<void>; visibilityTimeoutMs?: number } = {}
): Promise<BitunixPilotEvidence> {
  const now = o.now ?? (() => new Date());
  const sleep = o.sleep ?? ((ms: number) => new Promise((res) => setTimeout(res, ms)));
  const plan = planBitunixPilot(i);
  const startedAt = now().toISOString();
  const steps: BitunixPilotEvidence['steps'] = [];
  const finish = (): BitunixPilotEvidence => {
    const body = { startedAt, finishedAt: now().toISOString(), symbol: i.symbol, qty: plan.qty, steps };
    return { ...body, digest: digestEvidence(body) };
  };
  if (!plan.ok) {
    steps.push({ step: 'plan', ok: false, detail: { problems: plan.problems } });
    return finish();
  }
  const id = (k: string) => `${i.clientIdPrefix}-${k}`;
  const legs = async () => (await readPendingPositions(r, { symbol: i.symbol })).items.filter((p) => D(p.qty).gt(0));
  const open = async (side: 'LONG' | 'SHORT', k: string): Promise<SimResult> =>
    venue.placeOpeningOrderWithStop({
      paperAccountId: i.paperAccountId,
      clientOrderId: id(k),
      instrumentId: i.instrumentId,
      side,
      contracts: plan.qty,
      contract: { multiplier: '1', qtyStep: i.contract.qtyStep, minQty: i.contract.minQty, takerFeeRate: i.contract.takerFeeRate },
      quote: i.quote,
      stop: { price: plan.stops[side], basis: i.basis },
      now: now(),
      leverage: i.leverage,
      marginMode: i.marginMode
    } satisfies OpeningRequest);

  for (const [side, k] of [['LONG', 'ol'], ['SHORT', 'os']] as const) {
    const t0 = now().getTime();
    const res = await open(side, k);
    const ok = res.status === 'FILLED' && res.stop.orderId !== 'bitunix-tpsl:missing';
    let visibleMs: number | null = null;
    if (res.status === 'FILLED') {
      for (let w = 0; w < 20; w++) {
        const trades = (await readHistoryTrades(r, { orderId: res.orderId }, { maxPages: 1 })).items;
        if (trades.length) {
          visibleMs = now().getTime() - t0;
          break;
        }
        await sleep(500);
      }
    }
    const prot = res.status === 'FILLED' ? await venue.inspectProtection(res.stop.orderId, i.instrumentId) : null;
    const lookup = await venue.lookupOrder(id(k), i.instrumentId).catch((e) => ({ error: (e as Error).message }));
    steps.push({
      step: `open ${side}`,
      ok: ok && !!prot && prot.status === 'ACTIVE',
      detail: { result: res, protection: prot, fillVisibleAfterMs: visibleMs, lookupByClientId: lookup && 'status' in lookup ? { status: lookup.status, orderId: lookup.orderId } : lookup }
    });
    if (!steps.at(-1)!.ok) return finish();
  }

  const before = await legs();
  const long = before.find((p) => p.side === 'LONG');
  const short = before.find((p) => p.side === 'SHORT');
  steps.push({ step: 'both legs listed separately', ok: !!long && !!short && long.positionId !== short.positionId, detail: { legs: before.map((p) => ({ positionId: p.positionId, side: p.side, qty: p.qty })) } });
  if (!long || !short) return finish();

  const close = (side: 'LONG' | 'SHORT', ref: string, k: string) =>
    venue.placeReduceOnlyClose({ paperAccountId: i.paperAccountId, clientOrderId: id(k), instrumentId: i.instrumentId, positionSide: side, contracts: plan.qty, contract: { multiplier: '1', qtyStep: i.contract.qtyStep, takerFeeRate: i.contract.takerFeeRate }, quote: { ...i.quote, mark: i.quote.bid, last: i.quote.bid }, now: now(), positionRef: ref } satisfies CloseRequest);

  const cl = await close('LONG', long.positionId, 'cl');
  const mid = await legs();
  const shortAfter = mid.find((p) => p.positionId === short.positionId);
  steps.push({
    step: 'close long; short untouched',
    ok: cl.status === 'FILLED' && !mid.some((p) => p.positionId === long.positionId) && !!shortAfter && D(shortAfter.qty).eq(short.qty),
    detail: { result: cl, shortBefore: short.qty, shortAfter: shortAfter?.qty ?? null }
  });
  const cs = await close('SHORT', short.positionId, 'cs');
  const after = await legs();
  steps.push({ step: 'close short', ok: cs.status === 'FILLED' && !after.some((p) => p.positionId === short.positionId), detail: { result: cs, legsAfter: after.map((p) => ({ positionId: p.positionId, side: p.side, qty: p.qty })) } });
  return finish();
}
