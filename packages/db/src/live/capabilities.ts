/**
 * MEXC Futures private capabilities and their evidence (Step 11 pilot handoff).
 *
 * Status per capability:
 *  - documented: the official docs establish the endpoint and fields (read 2026-11-09);
 *  - mock: exercised by the adapter against mocked exchange responses in this repository;
 *  - readOnly: checked against an explicitly authorized read-only account (none configured);
 *  - livePilot: observed on a live, authorized pilot account (Step 12; none yet).
 * The execution gate requires `livePilot === 'VERIFIED'` for every capability an action needs, so
 * a merely documented or mocked capability can never place an order.
 */

export type Evidence = 'VERIFIED' | 'PENDING' | 'NOT_APPLICABLE' | 'NOT_DOCUMENTED';

export interface Capability {
  id: CapabilityId;
  summary: string;
  docs: string;
  documented: 'YES' | 'PARTIAL' | 'NO';
  mock: Evidence;
  readOnly: Evidence;
  livePilot: Evidence;
  /** What the docs do not establish for the intended account and contract. */
  gaps: string[];
}

export type CapabilityId =
  | 'SIGNED_REQUESTS'
  | 'READ_BALANCES'
  | 'READ_POSITIONS'
  | 'READ_POSITION_MODE'
  | 'READ_ORDER_BY_CLIENT_ID'
  | 'READ_FILLS'
  | 'READ_STOP_ORDERS'
  | 'OPEN_WITH_ATTACHED_STOP'
  | 'REDUCE_ONLY_CLOSE'
  | 'STOP_RESIZE_AFTER_PARTIAL_CLOSE'
  | 'CANCEL_STOP'
  | 'CLIENT_ORDER_ID_IDEMPOTENCY'
  | 'ACCOUNT_ELIGIBILITY'
  | 'BITUNIX_OPEN_WITH_ATTACHED_STOP'
  | 'BITUNIX_HEDGE_CLOSE_BY_POSITION'
  | 'BITUNIX_TPSL_RESIZE'
  | LighterCapabilityId;

export type LighterCapabilityId =
  | 'LIGHTER_SIGNER'
  | 'LIGHTER_KEY_MATCH'
  | 'LIGHTER_ACCOUNT_SETTINGS'
  | 'LIGHTER_OPEN_WITH_LINKED_STOP'
  | 'LIGHTER_REDUCE_ONLY_CLOSE'
  | 'LIGHTER_STOP_RESIZE'
  | 'LIGHTER_ORDER_LOOKUP'
  | 'LIGHTER_FILL_FEES'
  | 'LIGHTER_FUNDING'
  | 'LIGHTER_XAU_EXECUTION'
  | 'LIGHTER_STOP_RENEW';

const DOC = 'https://www.mexc.com/api-docs/futures/account-and-trading-endpoints/';

export const MEXC_CAPABILITIES: Capability[] = [
  {
    id: 'SIGNED_REQUESTS',
    summary: 'HMAC-SHA256 of ApiKey + Request-Time + parameter string; headers ApiKey, Request-Time, Signature, Recv-Window',
    docs: 'https://www.mexc.com/api-docs/futures/integration-guide',
    documented: 'YES',
    mock: 'VERIFIED',
    readOnly: 'PENDING',
    livePilot: 'PENDING',
    gaps: ['Whether the API key must be IP-whitelisted for this deployment (error 406 exists)']
  },
  { id: 'READ_BALANCES', summary: 'GET /api/v1/private/account/assets', docs: `${DOC}get-all-account-assets`, documented: 'YES', mock: 'VERIFIED', readOnly: 'PENDING', livePilot: 'PENDING', gaps: [] },
  {
    id: 'READ_POSITIONS',
    summary: 'GET /api/v1/private/position/open_positions (positionType 1 long / 2 short, holdVol in contracts)',
    docs: `${DOC}get-open-positions`,
    documented: 'YES',
    mock: 'VERIFIED',
    readOnly: 'PENDING',
    livePilot: 'PENDING',
    gaps: ['Sample response contains undocumented fields']
  },
  {
    id: 'READ_POSITION_MODE',
    summary: 'GET /api/v1/private/position/position_mode (1 hedge, 2 one-way)',
    docs: `${DOC}get-user-position-mode`,
    documented: 'YES',
    mock: 'VERIFIED',
    readOnly: 'PENDING',
    livePilot: 'PENDING',
    gaps: ['The pilot account must be checked: order create defaults to hedge mode when positionMode is omitted']
  },
  {
    id: 'READ_ORDER_BY_CLIENT_ID',
    summary: 'GET /api/v1/private/order/external/{symbol}/{externalOid} (state 1 pending, 2 unfilled, 3 filled, 4 canceled, 5 invalid)',
    docs: `${DOC}get-order-by-external-id`,
    documented: 'PARTIAL',
    mock: 'VERIFIED',
    readOnly: 'PENDING',
    livePilot: 'PENDING',
    gaps: ['The response for an unknown externalOid is not documented (adapter assumes error 2040 "order not exist")', 'How quickly an accepted order becomes visible to this query (read-after-write) is not documented']
  },
  {
    id: 'READ_FILLS',
    summary: 'GET /api/v1/private/order/deal_details/{orderId}',
    docs: `${DOC}get-trade-records-by-order-id`,
    documented: 'PARTIAL',
    mock: 'VERIFIED',
    readOnly: 'PENDING',
    livePilot: 'PENDING',
    gaps: ['No pagination is documented', 'The example uses `taker` while the table says `isTaker`', 'Fee sign: positive = paid by the user (documented); fee currency not guaranteed USDT']
  },
  {
    id: 'READ_STOP_ORDERS',
    summary: 'GET /api/v1/private/stoporder/open_orders (TP/SL orders; state 1 untriggered … 5 failed)',
    docs: `${DOC}get-current-take-profitstop-loss-order-list`,
    documented: 'PARTIAL',
    mock: 'VERIFIED',
    readOnly: 'PENDING',
    livePilot: 'PENDING',
    gaps: ['Not documented that a stop attached at order creation (stopLossPrice) appears in this list, or under which orderId/positionId']
  },
  {
    id: 'OPEN_WITH_ATTACHED_STOP',
    summary: 'POST /api/v1/private/order/create: side 1 open long / 3 open short, type 5 market, openType, leverage, externalOid, stopLossPrice + lossTrend (1 last, 2 fair/mark, 3 index), positionMode',
    docs: `${DOC}place-order`,
    documented: 'PARTIAL',
    mock: 'VERIFIED',
    readOnly: 'NOT_APPLICABLE',
    livePilot: 'PENDING',
    gaps: [
      'Fields are documented; behaviour is not: whether the attached stop is created atomically with the fill, for the filled quantity on a partial fill, and as a reduce-only trigger',
      '`price` is marked required even for market orders (adapter sends the executable quote)',
      'Rate limit 4 orders / 2 s'
    ]
  },
  {
    id: 'REDUCE_ONLY_CLOSE',
    summary: 'POST /api/v1/private/order/create: side 4 close long / 2 close short, type 5, positionId of the leg; One-way: positionMode 2 + reduceOnly; Hedge: positionMode 1, no reduceOnly',
    docs: `${DOC}place-order`,
    documented: 'PARTIAL',
    mock: 'VERIFIED',
    readOnly: 'NOT_APPLICABLE',
    livePilot: 'PENDING',
    gaps: ['`reduceOnly` "applies only in one-way mode"; in hedge mode the close sides are relied on to never open the opposite side (not stated explicitly)', 'No error code is documented for a reduce-only order that would increase a position']
  },
  {
    id: 'STOP_RESIZE_AFTER_PARTIAL_CLOSE',
    summary: 'Keep stop coverage equal to the remaining contracts after a partial close (POST /api/v1/private/stoporder/place volType 1 for the remainder FIRST, then cancel the old stop; never cancel-first)',
    docs: `${DOC}place-tpsl-order-by-position`,
    documented: 'PARTIAL',
    mock: 'VERIFIED',
    readOnly: 'NOT_APPLICABLE',
    livePilot: 'PENDING',
    gaps: [
      'Not documented whether an attached/position stop shrinks automatically after a partial close',
      'Placing a replacement before cancelling can exceed "closable quantity": TrendPilot then keeps the old reduce-only stop (it still covers the remainder) and reports the resize as unconfirmed; cancel-then-place is not used because it leaves the remainder unprotected',
      'Sample response conflicts with the text (array vs order ID)'
    ]
  },
  { id: 'CANCEL_STOP', summary: 'POST /api/v1/private/stoporder/cancel {orders:[{stopPlanOrderId}]}', docs: `${DOC}cancel-tpsl-planned-orders`, documented: 'YES', mock: 'VERIFIED', readOnly: 'NOT_APPLICABLE', livePilot: 'PENDING', gaps: [] },
  {
    id: 'CLIENT_ORDER_ID_IDEMPOTENCY',
    summary: 'externalOid reused on retry so a duplicate submission cannot open twice',
    docs: `${DOC}place-order`,
    documented: 'NO',
    mock: 'VERIFIED',
    readOnly: 'NOT_APPLICABLE',
    livePilot: 'PENDING',
    gaps: ['The docs do not say that MEXC rejects a second order with the same externalOid. The adapter therefore never resubmits without first confirming the order is absent, after a grace period']
  },
  {
    id: 'ACCOUNT_ELIGIBILITY',
    summary: 'Futures order permission for this account and automated use',
    docs: 'https://www.mexc.com/announcements/17827791531135',
    documented: 'PARTIAL',
    mock: 'NOT_APPLICABLE',
    readOnly: 'PENDING',
    livePilot: 'PENDING',
    gaps: [
      'KYC is required for order permission (integration guide)',
      'MEXC (2026-05-26): API access is "primarily available to institutional users"; "bot trading, or algorithmic trading" is restricted and may freeze the account. Written confirmation from MEXC for this use is required before any live order',
      'Trading API was under maintenance 2022-07-25 to 2026-03-31 (update log)'
    ]
  }
];

/**
 * Bitunix order capabilities (Step 3). Documented and exercised against a mocked exchange only; an
 * operator records live-pilot evidence (Admin → Live Trading) before any Bitunix order is sent.
 */
export const BITUNIX_CAPABILITIES: Capability[] = [
  {
    id: 'BITUNIX_OPEN_WITH_ATTACHED_STOP',
    summary: 'POST /api/v1/futures/trade/place_order, Hedge mode: BUY+OPEN (long) / SELL+OPEN (short), MARKET, clientId, slPrice + slStopType + slOrderType MARKET',
    docs: 'https://www.bitunix.com/api-docs/futures/trade/place_order.html',
    documented: 'PARTIAL',
    mock: 'VERIFIED',
    readOnly: 'NOT_APPLICABLE',
    livePilot: 'PENDING',
    gaps: [
      'Whether the attached stop appears in the pending TP/SL list for the leg, with or without slQty',
      'Fill visibility delay in trade history after a market order',
      'clientId length/charset limits and the exact answer for an unknown clientId (adapter treats 20007 / empty data as absent)'
    ]
  },
  {
    id: 'BITUNIX_HEDGE_CLOSE_BY_POSITION',
    summary: 'POST /api/v1/futures/trade/place_order, Hedge mode: BUY+CLOSE+positionId (close long) / SELL+CLOSE+positionId (close short), MARKET',
    docs: 'https://www.bitunix.com/api-docs/futures/trade/place_order.html',
    documented: 'PARTIAL',
    mock: 'VERIFIED',
    readOnly: 'NOT_APPLICABLE',
    livePilot: 'PENDING',
    gaps: [
      'The page also calls `side` the order direction; its CLOSE rows (close long = BUY) contradict that reading. Confirm on the smallest size before relying on it',
      'Whether the position TP/SL shrinks with a partial close'
    ]
  },
  {
    id: 'BITUNIX_TPSL_RESIZE',
    summary: 'POST /api/v1/futures/tpsl/modify_order {orderId, slPrice (unchanged), slStopType, slOrderType MARKET, slQty = remaining}: a fixed-quantity stop follows a partial close, verified by re-reading the pending TP/SL',
    docs: 'https://www.bitunix.com/api-docs/futures/tp_sl/modify_tp_sl_order.html',
    documented: 'PARTIAL',
    mock: 'VERIFIED',
    readOnly: 'NOT_APPLICABLE',
    livePilot: 'PENDING',
    gaps: [
      'Whether the entry-attached stop is listed as a fixed-quantity TP/SL (slQty) or a position TP/SL (whole position, one per position, modified by positionId)',
      'Whether modify keeps the same orderId and applies atomically (no unprotected gap)',
      'A TP/SL that also carries a take profit is not modified by TrendPilot (its TP part would change too)'
    ]
  }
];

const LIGHTER_DOC = 'https://docs.lighter.xyz';

/**
 * Lighter capabilities (Lighter plan Step 4). Documented from docs.lighter.xyz and the official
 * SDK sources (lighter-python signer_client.py, lighter-go v1.0.12), exercised against a mocked
 * signer and exchange only. No authorized testnet account is configured and mainnet order
 * submission is disabled, so NOTHING here is observed on Lighter: `readOnly` / `livePilot` stay
 * PENDING and the Lighter entry path refuses until an operator records live evidence.
 */
export const LIGHTER_CAPABILITIES: Capability[] = [
  {
    id: 'LIGHTER_SIGNER',
    summary: 'Server-side signing of CreateGroupedOrders / CreateOrder / ModifyOrder / CancelOrder and auth tokens with the investor API key (official lighter-go signer)',
    docs: `${LIGHTER_DOC}/developers/integration-guides/signing-transactions`,
    documented: 'YES',
    mock: 'VERIFIED',
    readOnly: 'PENDING',
    livePilot: 'PENDING',
    gaps: [
      'No signer runtime is installed in this Node service. The official signer exists only as a Go C shared library (Python ctypes) or a WASM build; using either is a new dependency awaiting approval',
      'WASM signer: Go networking is unavailable, so nonces must be passed explicitly (TrendPilot does) and CheckClient cannot be used'
    ]
  },
  {
    id: 'LIGHTER_KEY_MATCH',
    summary: 'The saved API private key is the key registered at (account index, API key index): its public key equals GET /api/v1/apikeys public_key, or an auth token it signs is accepted by /api/v1/accountLimits',
    docs: `${LIGHTER_DOC}/developers/reference/wasm-signer`,
    documented: 'YES',
    mock: 'VERIFIED',
    readOnly: 'PENDING',
    livePilot: 'PENDING',
    gaps: ['Deriving the public key needs the signer; until then a connection proves only that the account exists and the API key index is registered']
  },
  {
    id: 'LIGHTER_ACCOUNT_SETTINGS',
    summary: 'Margin mode (0 cross / 1 isolated) and leverage per market from GET /api/v1/account positions[]; TrendPilot never changes them',
    docs: `${LIGHTER_DOC}/api/account/account`,
    documented: 'PARTIAL',
    mock: 'VERIFIED',
    readOnly: 'PENDING',
    livePilot: 'PENDING',
    gaps: [
      'The unit of positions[].initial_margin_fraction is not documented (the catalog uses 1/10000); TrendPilot reads it as percent until verified',
      'A market never traded may have no settings row; entries are then refused rather than assuming defaults'
    ]
  },
  {
    id: 'LIGHTER_OPEN_WITH_LINKED_STOP',
    summary: 'CreateGroupedOrders OTO: MARKET IOC entry (worst price) + STOP_LOSS IOC reduce-only child (mark-price trigger, 28-day expiry), one transaction, one nonce',
    docs: `${LIGHTER_DOC}/developers/integration-guides/signing-transactions`,
    documented: 'PARTIAL',
    mock: 'VERIFIED',
    readOnly: 'NOT_APPLICABLE',
    livePilot: 'PENDING',
    gaps: [
      'Child stop size after a PARTIAL fill of the IOC parent is not documented (parent size, filled size, or cancelled); TrendPilot verifies coverage against the confirmed filled size and resizes or emergency-closes',
      'Child activation: trigger_status moves from parent-order to mark-price — timing after the parent fill is not documented',
      'Stop expiry: max 30 days (docs); renewal before expiry is not implemented (Step 5 decision)',
      'Whether the reduce-only child is cancelled (canceled-child) when the parent IOC fills nothing'
    ]
  },
  {
    id: 'LIGHTER_REDUCE_ONLY_CLOSE',
    summary: 'CreateOrder MARKET IOC reduce-only, sized at the confirmed position, worst-price bound from the fresh book; Lighter refuses a wrong-direction reduce-only (21738)',
    docs: `${LIGHTER_DOC}/trading/order-types-and-matching`,
    documented: 'YES',
    mock: 'VERIFIED',
    readOnly: 'NOT_APPLICABLE',
    livePilot: 'PENDING',
    gaps: ['Lighter holds one net position per market: a close and a native stop racing each other are both reduce-only and cannot reverse, but the observed fill/cancel sequence is unverified']
  },
  {
    id: 'LIGHTER_STOP_RESIZE',
    summary: 'ModifyOrder of the reduce-only stop (by client order index) to the remaining size at the SAME trigger; confirmed by re-reading the order',
    docs: `${LIGHTER_DOC}/developers/integration-guides/signing-transactions`,
    documented: 'PARTIAL',
    mock: 'VERIFIED',
    readOnly: 'NOT_APPLICABLE',
    livePilot: 'PENDING',
    gaps: ['Whether ModifyOrder on a triggered-pending stop keeps its trigger state and expiry is not documented', 'Whether a reduce-only stop larger than the position shrinks automatically']
  },
  {
    id: 'LIGHTER_ORDER_LOOKUP',
    summary: 'GET /api/v1/accountOrders?client_order_indexes= (auth) for status, filled base/quote, trigger state; GET /api/v1/tx?by=hash and /api/v1/nextNonce for uncertain sends',
    docs: `${LIGHTER_DOC}/api/orders/accountorders`,
    documented: 'YES',
    mock: 'VERIFIED',
    readOnly: 'PENDING',
    livePilot: 'PENDING',
    gaps: ['Needs an auth token (signer)', 'Read-after-write delay between sendTx acceptance and the order becoming visible is not documented']
  },
  {
    id: 'LIGHTER_FILL_FEES',
    summary: 'Actual fills and fees from GET /api/v1/trades?order_index= (auth): size, price, taker_fee/maker_fee, realized P&L',
    docs: `${LIGHTER_DOC}/api/orders/trades`,
    documented: 'PARTIAL',
    mock: 'VERIFIED',
    readOnly: 'PENDING',
    livePilot: 'PENDING',
    gaps: ['The unit of trades[].taker_fee / maker_fee is not documented (integrator fees are in millionths); fees are not booked from this record until verified', 'accountOrderFills has no fee field']
  },
  {
    id: 'LIGHTER_FUNDING',
    summary: 'Applied funding from GET /api/v1/positionFunding (auth); positions[].total_funding_paid_out in the public snapshot',
    docs: `${LIGHTER_DOC}/api/account/positionfunding`,
    documented: 'PARTIAL',
    mock: 'NOT_APPLICABLE',
    readOnly: 'PENDING',
    livePilot: 'PENDING',
    gaps: ['Not read in this step (needs an auth token); the snapshot total is shown, never booked or simulated']
  },
  {
    id: 'LIGHTER_STOP_RENEW',
    summary: 'Renew an expiring native stop without a gap: place a new reduce-only STOP_LOSS for the position, confirm it is armed, then cancel the old one (ModifyOrder cannot change order_expiry)',
    docs: `${LIGHTER_DOC}/developers/integration-guides/signing-transactions`,
    documented: 'PARTIAL',
    mock: 'NOT_APPLICABLE',
    readOnly: 'NOT_APPLICABLE',
    livePilot: 'PENDING',
    gaps: [
      'Not implemented in this build: expiry is detected and alerted (entries halted); no renewal is sent',
      'Two reduce-only stops overlapping on one position: fill/cancel sequence when both trigger is not documented',
      'lighter-go v1.0.12 L2ModifyOrderTxInfo has no OrderExpiry field (ExpiredAt is the transaction validity)'
    ]
  },
  {
    id: 'LIGHTER_XAU_EXECUTION',
    summary: 'Mainnet XAU perp (market_id 92, size 4 dp, price 2 dp, min 0.0015 XAU / 10 USDC): orders, linked stop and reduce-only close on this market',
    docs: `${LIGHTER_DOC}/api/orders/orderbookdetails`,
    documented: 'PARTIAL',
    mock: 'VERIFIED',
    readOnly: 'NOT_APPLICABLE',
    livePilot: 'PENDING',
    gaps: ['Market IDs differ per environment and no authorized testnet account is configured: XAU order and native-stop behaviour can only be observed on mainnet, which stays disabled in this step']
  }
];


export class CapabilityNotVerified extends Error {
  constructor(readonly capability: CapabilityId) {
    super(`MEXC capability ${capability} is not verified on a live pilot account`);
    this.name = 'CapabilityNotVerified';
  }
}

/** Live-pilot verification state used by the execution gate. Defaults to the registry. */
export type CapabilityState = Partial<Record<CapabilityId, Evidence>>;

export function livePilotVerified(id: CapabilityId, override?: CapabilityState): boolean {
  const v = override?.[id] ?? [...MEXC_CAPABILITIES, ...BITUNIX_CAPABILITIES, ...LIGHTER_CAPABILITIES].find((c) => c.id === id)?.livePilot;
  return v === 'VERIFIED';
}

/**
 * Whether a partial exit on this exchange keeps the remainder covered by a stop resized to exactly
 * the remainder, by an exchange-supported mechanism verified on a live pilot (never cancel-first).
 * Paper resizes its simulated stop atomically. Where it is not verified, a partial exit still keeps
 * the original reduce-only stop at its price (it covers the remainder), but the exact resize is
 * unconfirmed: the workflow must not be presented as protected-and-verified.
 */
export interface PartialCloseProtection {
  exchange: string;
  verified: boolean;
  capability: CapabilityId | null;
  mechanism: string;
  limitation: string | null;
}

const PARTIAL_PROTECTION: Record<string, { capability: CapabilityId; mechanism: string; limitation: string }> = {
  MEXC: {
    capability: 'STOP_RESIZE_AFTER_PARTIAL_CLOSE',
    mechanism: 'Place a stop for exactly the remainder at the same price, then cancel the old stop (never cancel-first).',
    limitation:
      'MEXC stop resize after a partial close is not yet verified on a live pilot account (capability STOP_RESIZE_AFTER_PARTIAL_CLOSE). MEXC may refuse the replacement while the old stop rests ("closable quantity"); the original reduce-only stop then stays at its price and still covers the remainder, and the position shows the resize as unconfirmed.'
  },
  BITUNIX: {
    capability: 'BITUNIX_TPSL_RESIZE',
    mechanism: 'Modify the TP/SL order in place to the remaining quantity at the same price (a whole-position TP/SL follows the leg automatically).',
    limitation:
      'Bitunix TP/SL modify after a partial close is not yet verified on a live pilot account (capability BITUNIX_TPSL_RESIZE). A whole-position TP/SL follows the leg; a fixed-quantity one keeps its size and price until the modify is verified, and the position shows the resize as unconfirmed.'
  },
  LIGHTER: {
    capability: 'LIGHTER_STOP_RESIZE',
    mechanism: 'ModifyOrder of the reduce-only stop to the remaining size at the same trigger.',
    limitation:
      'Lighter stop ModifyOrder after a partial close is not yet verified on a live pilot account (capability LIGHTER_STOP_RESIZE). The original reduce-only stop stays at its price and covers the remainder; the exact resize is unconfirmed.'
  }
};

export function partialCloseProtection(exchange: string, mode: 'PAPER' | 'LIVE', override?: CapabilityState): PartialCloseProtection {
  if (mode === 'PAPER') return { exchange, verified: true, capability: null, mechanism: 'The paper simulator resizes the stop to the remainder atomically.', limitation: null };
  const p = PARTIAL_PROTECTION[exchange];
  if (!p) return { exchange, verified: false, capability: null, mechanism: 'None', limitation: `${exchange}: no verified stop-resize mechanism; partial exits are not offered as protected.` };
  const verified = livePilotVerified(p.capability, override);
  return { exchange, verified, capability: p.capability, mechanism: p.mechanism, limitation: verified ? null : p.limitation };
}
