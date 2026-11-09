import { isRateLimitCode, normalizePairInput } from '@trendpilot/domain';
import { leverageChoicesFor, lookupFixtureContract, type MexcContractFixture } from '../mexcFixtures';
import { MexcPublicError, type MexcContractInfo } from './mexcPublic';

/**
 * UI-05 pair validation. In a deployed app the admin's ticker is checked against MEXC's public
 * Futures "Get Contract Info" endpoint and the contract specification is read from the exchange.
 * Automated tests and local demo mode use the local fixture catalogue instead.
 */

export type PairContractSource = 'MEXC_PUBLIC' | 'FIXTURE';

/** Where pair validation reads contracts. Default: MEXC in production, fixtures elsewhere. */
export function pairContractSource(env: Record<string, string | undefined> = process.env): PairContractSource {
  const v = (env.PAIR_VALIDATION_SOURCE ?? '').trim().toLowerCase();
  if (v === 'mexc') return 'MEXC_PUBLIC';
  if (v === 'fixture' || v === 'fixtures') return 'FIXTURE';
  if (v) throw new Error(`PAIR_VALIDATION_SOURCE must be "mexc" or "fixture" (got "${v}").`);
  return env.NODE_ENV === 'production' ? 'MEXC_PUBLIC' : 'FIXTURE';
}

/** A contract ready to become a trading pair. */
export interface PairContract extends MexcContractFixture {
  source: PairContractSource;
  minLeverage: number;
  displayName: string | null;
  settleCoin: string;
  /** Non-blocking notes from the exchange (e.g. API trading not allowed). */
  warnings: string[];
  checkedAt: string;
}

export type PairLookup =
  | { ok: true; contract: PairContract }
  /** INVALID_INPUT and UNKNOWN_SYMBOL / NOT_ELIGIBLE are the admin's to fix; the others are transient. */
  | { ok: false; reason: 'INVALID_INPUT' | 'UNKNOWN_SYMBOL' | 'NOT_ELIGIBLE' | 'RATE_LIMITED' | 'EXCHANGE_UNAVAILABLE'; message: string };

export interface ContractInfoSource {
  contractInfo(exchangeSymbol: string): Promise<MexcContractInfo>;
}

const MEXC_PERPETUAL = 1;

/** Eligibility: an enabled, USDT-settled perpetual. Returns the reasons it is not. */
export function contractProblems(c: MexcContractInfo): string[] {
  const out: string[] = [];
  if (c.futureType !== MEXC_PERPETUAL) out.push(`it is not a perpetual contract (futureType ${c.futureType ?? 'unknown'})`);
  if (c.quoteCoin !== 'USDT' || c.settleCoin !== 'USDT') out.push(`it is not USDT-settled (quote ${c.quoteCoin || '?'}, settle ${c.settleCoin || '?'})`);
  if (c.state !== 0) out.push(`it is not enabled for trading on MEXC (state ${c.state})`);
  return out;
}

export async function resolvePairContract(input: string, o: { source: PairContractSource; client?: ContractInfoSource; now?: () => Date }): Promise<PairLookup> {
  const parsed = normalizePairInput(input);
  if (!parsed) return { ok: false, reason: 'INVALID_INPUT', message: 'Enter a USDT perpetual ticker such as BTCUSDT or XAU_USDT.' };
  const checkedAt = (o.now?.() ?? new Date()).toISOString();

  if (o.source === 'FIXTURE') {
    const f = lookupFixtureContract(parsed.symbol);
    if (!f) return { ok: false, reason: 'UNKNOWN_SYMBOL', message: `${parsed.symbol} is not in the local MEXC contract fixtures (demo/test mode). Deployed apps validate against MEXC.` };
    return { ok: true, contract: { ...f, source: 'FIXTURE', minLeverage: 1, displayName: null, settleCoin: 'USDT', warnings: [], checkedAt } };
  }

  if (!o.client) throw new Error('resolvePairContract: a MEXC client is required');
  let info: MexcContractInfo;
  try {
    info = await o.client.contractInfo(parsed.exchangeSymbol);
  } catch (e) {
    if (e instanceof MexcPublicError) {
      if (e.kind === 'API' && e.code === 1001) return { ok: false, reason: 'UNKNOWN_SYMBOL', message: `${parsed.exchangeSymbol} is not a MEXC Futures contract.` };
      if (isRateLimitCode(e.kind, e.code)) return { ok: false, reason: 'RATE_LIMITED', message: 'MEXC is rate-limiting requests from this server. Wait a minute and validate again.' };
    }
    return { ok: false, reason: 'EXCHANGE_UNAVAILABLE', message: `MEXC did not answer the contract lookup (${(e as Error).message}). This is not a problem with the ticker; try again shortly.` };
  }

  const problems = contractProblems(info);
  if (problems.length) return { ok: false, reason: 'NOT_ELIGIBLE', message: `${info.exchangeSymbol} cannot be added: ${problems.join('; ')}.` };

  const warnings: string[] = [];
  if (info.apiAllowed === false) warnings.push('MEXC does not allow API trading on this contract; live trading would not be possible.');
  if (info.isHidden) warnings.push('MEXC lists this contract as hidden.');
  if (info.openingTime && info.openingTime > Date.parse(checkedAt)) warnings.push(`Trading opens ${new Date(info.openingTime).toISOString()}; no market data until then.`);
  if (!leverageChoicesFor(info.maxLeverage, info.minLeverage).length) warnings.push('No standard leverage step fits MEXC’s leverage range.');

  return {
    ok: true,
    contract: {
      // Platform symbol has no separator; execution uses the exchange-returned symbol.
      symbol: parsed.symbol,
      exchangeSymbol: info.exchangeSymbol,
      base: info.baseCoin || parsed.base,
      quote: 'USDT',
      contractMultiplier: info.contractSize,
      qtyStep: info.volUnit,
      minQty: info.minVol,
      maxQty: info.maxVol,
      priceTick: info.priceUnit,
      takerFeeRate: info.takerFeeRate ?? '0.0004',
      maxLeverage: info.maxLeverage,
      minLeverage: info.minLeverage,
      source: 'MEXC_PUBLIC',
      displayName: info.displayName,
      settleCoin: info.settleCoin,
      warnings,
      checkedAt
    }
  };
}
