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
  | 'ACCOUNT_ELIGIBILITY';

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
    summary: 'POST /api/v1/private/order/create: side 4 close long / 2 close short, type 5, positionId; reduceOnly=true in one-way mode',
    docs: `${DOC}place-order`,
    documented: 'PARTIAL',
    mock: 'VERIFIED',
    readOnly: 'NOT_APPLICABLE',
    livePilot: 'PENDING',
    gaps: ['`reduceOnly` "applies only in one-way mode"; in hedge mode the close sides are relied on to never open the opposite side (not stated explicitly)', 'No error code is documented for a reduce-only order that would increase a position']
  },
  {
    id: 'STOP_RESIZE_AFTER_PARTIAL_CLOSE',
    summary: 'Keep stop coverage equal to the remaining contracts after a partial close (cancel + POST /api/v1/private/stoporder/place volType 1)',
    docs: `${DOC}place-tpsl-order-by-position`,
    documented: 'PARTIAL',
    mock: 'VERIFIED',
    readOnly: 'NOT_APPLICABLE',
    livePilot: 'PENDING',
    gaps: [
      'Not documented whether an attached/position stop shrinks automatically after a partial close',
      'Placing a replacement before cancelling can exceed "closable quantity"; cancel-then-place leaves a short unprotected gap',
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

export class CapabilityNotVerified extends Error {
  constructor(readonly capability: CapabilityId) {
    super(`MEXC capability ${capability} is not verified on a live pilot account`);
    this.name = 'CapabilityNotVerified';
  }
}

/** Live-pilot verification state used by the execution gate. Defaults to the registry. */
export type CapabilityState = Partial<Record<CapabilityId, Evidence>>;

export function livePilotVerified(id: CapabilityId, override?: CapabilityState): boolean {
  const v = override?.[id] ?? MEXC_CAPABILITIES.find((c) => c.id === id)?.livePilot;
  return v === 'VERIFIED';
}
