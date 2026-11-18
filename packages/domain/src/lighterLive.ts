import { Decimal } from './decimal';

/**
 * Lighter private trading (Lighter plan Step 4): pure rules for the connection, integer scaling,
 * the signed order shapes and the uncertain-transaction procedure. No I/O, no signing.
 *
 * Sources (read 2026-11-17; "docs" = https://docs.lighter.xyz):
 *  - developers/getting-started/core-concepts: account indexes (0–2 system accounts; sub-accounts
 *    count down from 2^48−2), API key indexes 4–254 (0–3 reserved for Lighter's apps), nonce per
 *    API key, "when a rejected transaction consumes its nonce", "Retrying safely", integer prices
 *    and sizes, minimum order = max(min_base_amount, min_quote_amount), taker `price` = worst
 *    acceptable price.
 *  - developers/integration-guides/signing-transactions: order parameters (clientOrderIndex uint48
 *    unique across all markets; orderExpiry ms, 5 minutes–30 days, 0 for IOC), order types, grouping
 *    types (1 OTO, 2 OCO, 3 OTOCO), "sendTx code 200 means accepted, not executed".
 *  - trading/order-types-and-matching: SL/TP trigger on the MARK price (sell stop: mark ≤ trigger;
 *    buy stop: mark ≥ trigger); reduce-only only moves a position toward zero.
 *  - developers/reference/data-structures-constants-and-errors: tx status 0 failed, 1 pending,
 *    2 executed, 3 pending-final; order statuses; error 21104 invalid nonce, 21728 client order index
 *    exists, 21738 invalid reduce-only direction.
 *  - lighter-go signer/key_manager.go: an API private key is exactly 40 bytes.
 *  - lighter-python signer_client.py: chain ID 304 mainnet / 300 testnet; create_sl_order uses
 *    ORDER_TYPE_STOP_LOSS + IOC + 28-day expiry; create_market_order uses MARKET + IOC + expiry 0.
 */

const D = (v: Decimal.Value) => new Decimal(v);

/* ───────────────────────── Environment and connection input ───────────────────────── */

/**
 * Official Ethereum-based Lighter environments. `contractAddress` is the ZkLighter contract reported
 * by `GET /info` (observed 2026-11-18); both report `network_id` 1, so the contract is what tells
 * them apart. Testnet market IDs differ from mainnet (e.g. no XAU and no market 92 on testnet).
 */
export const LIGHTER_ENVIRONMENTS = {
  MAINNET: { baseUrl: 'https://mainnet.zklighter.elliot.ai', chainId: 304, contractAddress: '0x3B4D794a66304F130a4Db8F2551B0070dfCf5ca7' },
  TESTNET: { baseUrl: 'https://testnet.zklighter.elliot.ai', chainId: 300, contractAddress: '0x5236A61b4796BF57B78328c4D752414c4b26e863' }
} as const;
export type LighterEnvironment = keyof typeof LIGHTER_ENVIRONMENTS;

/**
 * Environments an investor may connect in this release. Mainnet only: every published Lighter
 * instrument comes from the mainnet catalog (market IDs are per environment), and no authorized
 * testnet account is configured. Mainnet ORDER submission stays disabled (see lighterOrders).
 */
export const LIGHTER_CONNECTABLE_ENVIRONMENTS: readonly LighterEnvironment[] = ['MAINNET'];

/** Largest Lighter account index (sub-accounts and pools count down from here). */
export const LIGHTER_MAX_ACCOUNT_INDEX = 2 ** 48 - 2;
/** Account indexes 0–2 are system accounts (treasury, insurance fund). */
export const LIGHTER_MIN_USER_ACCOUNT_INDEX = 3;
/** API key indexes 0–3 are reserved for Lighter's apps; 255 means "all keys" (queries only). */
export const LIGHTER_MIN_API_KEY_INDEX = 4;
export const LIGHTER_MAX_API_KEY_INDEX = 254;
/** clientOrderIndex is a uint48, unique across all markets of the account. 0 = placed in Lighter's UI. */
export const LIGHTER_MAX_CLIENT_ORDER_INDEX = 2 ** 48 - 1;

export interface LighterConnectionInput {
  environment: string;
  accountIndex: string | number;
  apiKeyIndex: string | number;
  apiPrivateKey: string;
}

export interface ValidLighterConnection {
  environment: LighterEnvironment;
  accountIndex: number;
  apiKeyIndex: number;
  /** Lower-case hex without 0x (80 characters = 40 bytes). */
  apiPrivateKey: string;
}

const intOf = (v: string | number): number | null => {
  const s = typeof v === 'number' ? String(v) : (v ?? '').trim();
  if (!/^\d{1,16}$/.test(s)) return null;
  const n = Number(s);
  return Number.isSafeInteger(n) ? n : null;
};

/**
 * Validates the investor's input. Never echoes the private key in a message. `allowed`: the
 * environments this process accepts (mainnet; testnet only in an isolated local test setup).
 */
export function validateLighterConnection(i: LighterConnectionInput, allowed: readonly LighterEnvironment[] = LIGHTER_CONNECTABLE_ENVIRONMENTS): { ok: true; value: ValidLighterConnection } | { ok: false; issues: string[] } {
  const issues: string[] = [];
  const env = String(i.environment ?? '').trim().toUpperCase() || 'MAINNET';
  if (!(env in LIGHTER_ENVIRONMENTS)) issues.push('Lighter environment must be MAINNET.');
  else if (!allowed.includes(env as LighterEnvironment)) issues.push(`Lighter ${env} accounts cannot be connected in this release (mainnet only).`);
  const account = intOf(i.accountIndex);
  if (account === null || account < LIGHTER_MIN_USER_ACCOUNT_INDEX || account > LIGHTER_MAX_ACCOUNT_INDEX)
    issues.push(`Enter your Lighter account index (a whole number from ${LIGHTER_MIN_USER_ACCOUNT_INDEX} to ${LIGHTER_MAX_ACCOUNT_INDEX}).`);
  const key = intOf(i.apiKeyIndex);
  if (key === null || key < LIGHTER_MIN_API_KEY_INDEX || key > LIGHTER_MAX_API_KEY_INDEX)
    issues.push(`Enter the API key index (${LIGHTER_MIN_API_KEY_INDEX}–${LIGHTER_MAX_API_KEY_INDEX}; 0–3 are reserved for Lighter's apps).`);
  const pk = String(i.apiPrivateKey ?? '').trim().replace(/^0x/i, '').toLowerCase();
  if (!/^[0-9a-f]{80}$/.test(pk)) issues.push('Enter the API private key: 80 hexadecimal characters (40 bytes), with or without 0x. This is the API key, never your wallet key or seed phrase.');
  if (issues.length) return { ok: false, issues };
  return { ok: true, value: { environment: env as LighterEnvironment, accountIndex: account!, apiKeyIndex: key!, apiPrivateKey: pk } };
}

/** Display reference for a connection: never secret. */
export const lighterAccountRef = (accountIndex: number, apiKeyIndex: number) => `account ${accountIndex} · key ${apiKeyIndex}`;

/* ───────────────────────── Integer scaling ───────────────────────── */

/** Decimals of a step such as "0.0001" → 4. Refuses a step that is not a power of ten. */
export function decimalsOfStep(step: Decimal.Value): number {
  const s = D(step);
  if (s.lte(0) || s.gt(1)) throw new Error(`step ${s.toFixed()} is not a power of ten ≤ 1`);
  const n = s.decimalPlaces();
  if (!D(10).pow(-n).eq(s)) throw new Error(`step ${s.toFixed()} is not a power of ten`);
  return n;
}

export type Rounding = 'DOWN' | 'UP' | 'EXACT';

/** value × 10^decimals as an integer string. EXACT refuses a value that needs rounding. */
export function toScaledInt(value: Decimal.Value, decimals: number, rounding: Rounding): string {
  const v = D(value).times(D(10).pow(decimals));
  if (rounding === 'EXACT' && !v.isInteger()) throw new Error(`${D(value).toFixed()} has more than ${decimals} decimals`);
  const r = rounding === 'UP' ? v.ceil() : v.floor();
  if (r.isNegative()) throw new Error('negative amount');
  return r.toFixed(0);
}

export const fromScaledInt = (scaled: string | number | bigint, decimals: number): string => D(String(scaled)).div(D(10).pow(decimals)).toFixed();

/* ───────────────────────── Orders ───────────────────────── */

export const LIGHTER_ORDER_TYPE = { LIMIT: 0, MARKET: 1, STOP_LOSS: 2, STOP_LOSS_LIMIT: 3, TAKE_PROFIT: 4, TAKE_PROFIT_LIMIT: 5 } as const;
export const LIGHTER_TIF = { IOC: 0, GTT: 1, POST_ONLY: 2 } as const;
export const LIGHTER_GROUPING = { OTO: 1, OCO: 2, OTOCO: 3 } as const;
export const LIGHTER_TX_TYPE = { CREATE_ORDER: 14, CANCEL_ORDER: 15, MODIFY_ORDER: 17, CREATE_GROUPED_ORDERS: 28 } as const;
/** SDK default for SL/TP orders (`DEFAULT_28_DAY_ORDER_EXPIRY`); the docs allow 5 minutes to 30 days. */
export const LIGHTER_STOP_EXPIRY_MS = 28 * 24 * 3600 * 1000;

/** One order as the signer takes it (the WASM signer's grouped-order object, same field names). */
export interface LighterOrderReq {
  MarketIndex: number;
  ClientOrderIndex: number;
  BaseAmount: string;
  Price: string;
  IsAsk: 0 | 1;
  Type: number;
  TimeInForce: number;
  ReduceOnly: 0 | 1;
  TriggerPrice: string;
  OrderExpiry: number;
}

export interface LighterMarketRules {
  marketId: number;
  sizeDecimals: number;
  priceDecimals: number;
  minBaseAmount: string;
  minQuoteAmount: string;
  /** Per-order USDC limit (`order_quote_limit`), null when the catalog has none. */
  maxQuoteAmount: string | null;
}

/** Live inputs Lighter does not provide and TrendPilot must not invent. Missing → entries refused. */
export interface LighterLiveInputs {
  /** Worst acceptable entry price as a % beyond the fresh best ask (Long) / bid (Short). */
  entryWorstPricePct: string | null;
  /** Worst acceptable fill once the stop triggers, as a % beyond the trigger. */
  stopWorstPricePct: string | null;
  /** Worst acceptable price for a reduce-only market close, as a % beyond the fresh book. */
  closeWorstPricePct: string | null;
  /** The account's taker fee rate (fraction, 0.0002 = 2 bp) for the margin check. */
  takerFeeRate: string | null;
}

export function missingLiveInputs(i: LighterLiveInputs, kind: 'OPEN' | 'CLOSE'): string[] {
  const need: (keyof LighterLiveInputs)[] = kind === 'OPEN' ? ['entryWorstPricePct', 'stopWorstPricePct', 'takerFeeRate'] : ['closeWorstPricePct'];
  return need.filter((k) => i[k] === null || i[k] === undefined || !D(i[k]!).isFinite() || D(i[k]!).isNegative());
}

/**
 * Worst price for a taker order: buys pay at most ref×(1+pct), sells receive at least ref×(1−pct).
 * Rounded to the tick so the bound never exceeds the configured slippage (buys down, sells up).
 */
export function worstPrice(isAsk: boolean, reference: Decimal.Value, pct: Decimal.Value, priceDecimals: number): string {
  const f = D(pct).div(100);
  const raw = isAsk ? D(reference).times(D(1).minus(f)) : D(reference).times(D(1).plus(f));
  if (raw.lte(0)) throw new Error('worst price is not positive');
  return toScaledInt(raw, priceDecimals, isAsk ? 'UP' : 'DOWN');
}

/**
 * Size checks on the base amount (already rounded DOWN to the market's size step). Lighter's
 * minimum is the larger of min_base_amount and min_quote_amount (USDC at the reference price).
 */
export function checkLighterSize(base: Decimal.Value, price: Decimal.Value, r: LighterMarketRules): string | null {
  const b = D(base);
  if (b.lte(0)) return 'QTY_BELOW_MIN: size rounds to zero';
  if (b.lt(r.minBaseAmount)) return `QTY_BELOW_MIN: ${b.toFixed()} < min_base_amount ${r.minBaseAmount}`;
  const notional = b.times(price);
  if (notional.lt(r.minQuoteAmount)) return `NOTIONAL_BELOW_MIN: ${notional.toDecimalPlaces(6).toFixed()} USDC < min_quote_amount ${r.minQuoteAmount}`;
  if (r.maxQuoteAmount !== null && notional.gt(r.maxQuoteAmount)) return `NOTIONAL_ABOVE_MAX: ${notional.toDecimalPlaces(6).toFixed()} USDC > order_quote_limit ${r.maxQuoteAmount}`;
  return null;
}

/**
 * Opening market order with its reduce-only stop, linked as OTO (the stop exists only once the
 * entry fills). Long: buy entry, sell stop below. Short: sell entry, buy stop above. The stop
 * triggers on Lighter's MARK price (documented); a LAST basis is refused upstream. The child's
 * BaseAmount must be 0: Lighter sizes the triggered stop itself (lighter-go v1.0.12
 * create_grouped_orders.go ValidateOTO, "Ensure child order base size is 0"; the signer refuses
 * otherwise). Its coverage is verified against the confirmed fill after execution.
 */
export function buildOpenWithStop(i: {
  side: 'LONG' | 'SHORT';
  rules: LighterMarketRules;
  baseAmount: string;
  entryWorstPrice: string;
  stopTrigger: string;
  stopWorstPrice: string;
  entryClientOrderIndex: number;
  stopClientOrderIndex: number;
  nowMs: number;
}): { groupingType: number; orders: [LighterOrderReq, LighterOrderReq] } {
  const isAsk: 0 | 1 = i.side === 'SHORT' ? 1 : 0;
  return {
    groupingType: LIGHTER_GROUPING.OTO,
    orders: [
      { MarketIndex: i.rules.marketId, ClientOrderIndex: i.entryClientOrderIndex, BaseAmount: i.baseAmount, Price: i.entryWorstPrice, IsAsk: isAsk, Type: LIGHTER_ORDER_TYPE.MARKET, TimeInForce: LIGHTER_TIF.IOC, ReduceOnly: 0, TriggerPrice: '0', OrderExpiry: 0 },
      {
        MarketIndex: i.rules.marketId,
        ClientOrderIndex: i.stopClientOrderIndex,
        BaseAmount: '0',
        Price: i.stopWorstPrice,
        IsAsk: isAsk ? 0 : 1,
        Type: LIGHTER_ORDER_TYPE.STOP_LOSS,
        TimeInForce: LIGHTER_TIF.IOC,
        ReduceOnly: 1,
        TriggerPrice: i.stopTrigger,
        OrderExpiry: i.nowMs + LIGHTER_STOP_EXPIRY_MS
      }
    ]
  };
}

/** Reduce-only market close of a Long (sell) or Short (buy), capped by the caller at the confirmed position. */
export function buildReduceOnlyClose(i: { positionSide: 'LONG' | 'SHORT'; marketId: number; baseAmount: string; worstPrice: string; clientOrderIndex: number }): LighterOrderReq {
  return {
    MarketIndex: i.marketId,
    ClientOrderIndex: i.clientOrderIndex,
    BaseAmount: i.baseAmount,
    Price: i.worstPrice,
    IsAsk: i.positionSide === 'LONG' ? 1 : 0,
    Type: LIGHTER_ORDER_TYPE.MARKET,
    TimeInForce: LIGHTER_TIF.IOC,
    ReduceOnly: 1,
    TriggerPrice: '0',
    OrderExpiry: 0
  };
}

/* ───────────────────────── Transactions ───────────────────────── */

export const LIGHTER_TX_STATUS = { FAILED: 0, PENDING: 1, EXECUTED: 2, PENDING_FINAL: 3 } as const;

export type UncertainTxDecision =
  /** The transaction executed: read its orders and fills; never resend. */
  | 'EXECUTED'
  /** Not executed and the nonce is still free: resend the SAME transaction with the SAME nonce. */
  | 'RESEND_SAME_NONCE'
  /** Failed and its nonce was consumed (included as a no-op): nothing was created; do not resend. */
  | 'FAILED_NONCE_CONSUMED'
  /** Failed before applying and the nonce is free: resend with the same nonce (same client order index). */
  | 'FAILED_RESEND_SAME_NONCE'
  /** Still queued or not visible yet: wait. */
  | 'WAIT'
  /** The nonce moved on but the transaction is not visible: cannot tell; never resend. */
  | 'UNKNOWN';

/**
 * Documented "Retrying safely" procedure for a transaction whose outcome is unknown (timeout,
 * dropped connection, restart). `txStatus` null = the hash is not known to Lighter (yet).
 * Re-signing with a NEW nonce while the original may still execute can place the order twice, so
 * no outcome here allocates a new nonce.
 */
export function decideUncertainTx(i: { txStatus: number | null; nextNonce: number; nonce: number }): UncertainTxDecision {
  if (i.txStatus === LIGHTER_TX_STATUS.EXECUTED) return 'EXECUTED';
  if (i.txStatus === LIGHTER_TX_STATUS.PENDING || i.txStatus === LIGHTER_TX_STATUS.PENDING_FINAL) return 'WAIT';
  if (i.txStatus === LIGHTER_TX_STATUS.FAILED) return i.nextNonce > i.nonce ? 'FAILED_NONCE_CONSUMED' : 'FAILED_RESEND_SAME_NONCE';
  // Unknown hash: if the nonce is still ours, the transaction never reached the sequencer.
  if (i.nextNonce === i.nonce) return 'RESEND_SAME_NONCE';
  if (i.nextNonce < i.nonce) return 'WAIT'; // an earlier transaction on this key is still ahead of ours
  return 'UNKNOWN';
}

/** Order statuses (REST `status`) that are final. */
export const LIGHTER_FINAL_ORDER_STATUSES = new Set([
  'filled',
  'canceled',
  'canceled-post-only',
  'canceled-reduce-only',
  'canceled-position-not-allowed',
  'canceled-margin-not-allowed',
  'canceled-too-much-slippage',
  'canceled-not-enough-liquidity',
  'canceled-self-trade',
  'canceled-expired',
  'canceled-oco',
  'canceled-child',
  'canceled-liquidation',
  'canceled-invalid-balance'
]);

/** API error codes the adapter handles explicitly (others are rejections with their code). */
export const LIGHTER_ERR = { INVALID_NONCE: 21104, CLIENT_ORDER_INDEX_EXISTS: 21728, INVALID_REDUCE_ONLY_DIRECTION: 21738, NO_POSITION_FOUND: 21614 } as const;

/* ───────────────────────── Native stop expiry (Step 5) ───────────────────────── */

/**
 * Lighter stops expire (order_expiry, at most 30 days; TrendPilot uses the SDK's 28 days). The
 * official ModifyOrder carries no expiry (lighter-go v1.0.12 L2ModifyOrderTxInfo: MarketIndex,
 * Index, BaseAmount, Price, TriggerPrice — its ExpiredAt is the transaction's own validity), so a
 * stop cannot be renewed in place. Renewal = place a NEW reduce-only stop, confirm it is armed, then
 * cancel the old one (overlap, never a gap). That overlap is not verified on the exchange; until it
 * is (capability LIGHTER_STOP_RENEW), the plan is ALERT: halt new entries and tell the operator.
 */
export type StopRenewalPlan =
  | { action: 'NONE'; reason: string }
  | { action: 'ALERT'; reason: string }
  | { action: 'WAIT'; reason: string }
  | { action: 'RENEW'; attemptKey: string };

export interface StopRenewalInput {
  expiresAtMs: number | null;
  nowMs: number;
  /** Operator-set lead time; null = not configured (nothing is assumed). */
  leadMs: number | null;
  /** LIGHTER_STOP_RENEW verified on a live pilot. */
  renewVerified: boolean;
  /** The last renewal attempt for THIS stop and expiry, if any. */
  previous: { attemptKey: string; status: 'PENDING' | 'REJECTED' | 'CONFIRMED' } | null;
}

export function planStopRenewal(i: StopRenewalInput): StopRenewalPlan {
  if (i.expiresAtMs === null) return { action: 'ALERT', reason: 'STOP_EXPIRY_UNKNOWN: Lighter reports no expiry for this stop' };
  if (i.expiresAtMs <= i.nowMs) return { action: 'ALERT', reason: 'STOP_EXPIRED: the native stop has expired; the position is not protected' };
  if (i.leadMs === null) return { action: 'NONE', reason: 'STOP_RENEW_LEAD_UNSET: renewal lead time not configured' };
  if (i.expiresAtMs - i.nowMs > i.leadMs) return { action: 'NONE', reason: 'STOP_NOT_DUE' };
  const attemptKey = `renew:${i.expiresAtMs}`;
  if (i.previous && i.previous.attemptKey === attemptKey) {
    if (i.previous.status === 'PENDING') return { action: 'WAIT', reason: 'STOP_RENEW_PENDING: a renewal for this expiry is still unconfirmed; not sent again' };
    if (i.previous.status === 'REJECTED') return { action: 'ALERT', reason: 'STOP_RENEW_REJECTED: Lighter refused the renewal; not retried automatically' };
    return { action: 'NONE', reason: 'STOP_RENEWED' };
  }
  if (!i.renewVerified) return { action: 'ALERT', reason: 'STOP_EXPIRING: renewal is disabled until LIGHTER_STOP_RENEW is verified; new entries halted' };
  return { action: 'RENEW', attemptKey };
}

/* ───────────────────────── Minimum valid size (Step 5 pilot runbook) ───────────────────────── */

/**
 * The smallest size Lighter accepts at `price`: the larger of min_base_amount and
 * min_quote_amount / price, rounded UP to the size step (10^-size_decimals) so it is a valid
 * increment and still meets both minimums. `headroomPct` raises the quote minimum for price moves
 * between this computation and submission (the venue re-checks on the fresh book anyway).
 */
export function smallestLighterSize(r: Pick<LighterMarketRules, 'sizeDecimals' | 'minBaseAmount' | 'minQuoteAmount'>, price: Decimal.Value, headroomPct: Decimal.Value = 0): string {
  const p = D(price);
  if (p.lte(0)) throw new Error('price must be positive');
  const step = D(10).pow(-r.sizeDecimals);
  const byQuote = D(r.minQuoteAmount).times(D(1).plus(D(headroomPct).div(100))).div(p);
  const raw = Decimal.max(r.minBaseAmount, byQuote);
  return raw.div(step).ceil().times(step).toFixed(r.sizeDecimals);
}
