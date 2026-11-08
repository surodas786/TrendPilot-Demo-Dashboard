import type { ExitPlanConfig } from './exitPlan';

export type SignalAction = 'open-long' | 'open-short' | 'close-long' | 'close-short';

/** Fictional demo user. Role and user switching are interface demonstrations only. */
export interface DemoUser {
  id: string;
  name: string;
  email: string;
  status: 'invited' | 'active' | 'suspended';
  invitation: 'pending' | 'accepted';
  createdAt: number;
  /** Administrator pause of new entries for this user. */
  entriesPaused: boolean;
  /** The trader's own workspace-wide pause (dashboard control). */
  workspacePaused: boolean;
  /** Investor's configured timezone (IANA). Defaults to Asia/Dhaka when unset. */
  timezone?: string;
}

/** Central routing policy for one approved strategy. Simulation only — no public endpoint exists. */
export interface SignalRoute {
  id: string;
  label: string;
  enabled: boolean;
  strategyId: string;
  approvedVersion: string;
  sourceExchange: string;
  /** Source (TradingView) symbol → execution pair. */
  symbolMap: Record<string, string>;
  marketType: 'perpetual';
  timeframe: string;
  allowedActions: SignalAction[];
  /** Entry freshness limit: candle close → gateway receipt. */
  maxSignalAgeSec: number;
  /** Close-signal freshness policy (more lenient: closing reduces exposure). */
  closeMaxSignalAgeSec: number;
  requireConfirmed: boolean;
  acceptEntries: boolean;
  acceptCloses: boolean;
  updatedAt: number;
  /** Which TradingView alert this route is for. Missing on older saved routes = Supertrend. */
  triggerType?: RouteTriggerType;
  /** Indicator or alert-condition name when triggerType is 'custom'. */
  triggerName?: string;
  /** Trade trigger (default) or Information only. */
  usage?: RouteUsage;
}

export type RouteTriggerType = 'supertrend' | 'custom';
export type RouteUsage = 'trade' | 'info';

/** Sanitized payload. Never contains exchange keys or secrets. */
export interface SignalPayload {
  signal_id: string;
  strategy_id: string;
  strategy_version: string;
  source_exchange: string;
  source_symbol: string;
  market_type: string;
  timeframe: string;
  action: string;
  candle_close_time: string;
  signal_created_at: string;
  reference_price: number;
  confirmed: boolean;
  route_id?: string;
  alert_trigger?: string;
  /** Incoming TradingView interval as received. */
  interval?: string;
}

/** Composer input (paper signal). Times are epoch ms on the simulation clock. */
export interface SignalInput {
  routeId: string;
  strategyVersion: string;
  pair: string;
  action: SignalAction;
  referencePrice: number;
  candleCloseAt: number;
  createdAt: number;
  receivedAt: number;
  confirmed: boolean;
  signalId: string;
  /** Incoming TradingView interval ("5", "5m", "15", "15m"). Checked against the route and any package. */
  timeframe?: string;
}

export type CheckStatus = 'pass' | 'fail' | 'skip';

export interface SignalCheck {
  id: string;
  label: string;
  status: CheckStatus;
  detail: string;
}

export type ValidationOutcome = 'accepted' | 'rejected' | 'duplicate';

export type DeliveryState = 'pending' | 'evaluating' | 'skipped' | 'rejected' | 'submitted' | 'partially-filled' | 'executed' | 'failed' | 'unknown';

export interface DeliverySnapshot {
  strategyVersion: string;
  subscriptionLabel: string;
  riskPolicy: string;
  exitPlanLabel: string;
  orderCost: number;
  leverage: number;
}

export interface Delivery {
  id: string;
  userId: string;
  accountId: string;
  subscriptionId: string | null;
  kind: 'entry' | 'close' | 'opposite-close';
  state: DeliveryState;
  reason: string;
  link?: {to: string;label: string;};
  evaluatedAt: number;
  submittedAt?: number;
  ackAt?: number;
  firstFillAt?: number;
  finalFillAt?: number;
  orderIds: string[];
  positionId?: string;
  snapshot?: DeliverySnapshot;
  protection?: string;
  recovery?: string[];
}

/** Every receipt attempt is stored, including rejected and duplicate attempts. */
export interface CentralSignal {
  id: string;
  signalId: string;
  routeId: string;
  strategyId: string;
  strategyVersion: string;
  sourceExchange: string;
  sourceSymbol: string;
  pair: string;
  action: SignalAction;
  timeframe: string;
  candleCloseAt: number;
  createdAt: number;
  receivedAt: number;
  validatedAt: number;
  referencePrice: number;
  confirmed: boolean;
  payload: SignalPayload;
  checks: SignalCheck[];
  outcome: ValidationOutcome;
  reason: string;
  duplicateOf?: string;
  deliveries: Delivery[];
  scenario?: string;
  /** Route was Information only: logged, no trading actions. */
  infoOnly?: boolean;
  /** Route name and trigger at receipt time (later route edits don't rewrite history). */
  routeLabel?: string;
  triggerLabel?: string;
}

export type EntryBehavior = 'fill' | 'partial' | 'unknown' | 'reject' | 'protection-fail';

export interface AdminLogEntry {
  id: string;
  at: number;
  operator: string;
  action: string;
  target: string;
  previous: string;
  next: string;
}

/** Live exit state for positions opened through the paper signal flow. */
export interface ExitRuntime {
  config: ExitPlanConfig;
  planId: string;
  rDistance: number;
  best: number;
  trailActive: boolean;
  partialDone: boolean;
  partialPrice: number | null;
  activationPrice: number | null;
  targetPrice: number | null;
}

/** Links an entry order back to the signal delivery that created it. */
export interface SignalOrderContext {
  centralId: string;
  deliveryId: string;
  subscriptionId: string;
  planId: string;
  positionId: string;
}

export type SignalScenarioId =
'two-users' |
'margin' |
'duplicate' |
'expired' |
'out-of-order' |
'paused-sub' |
'existing-position' |
'unknown' |
'partial' |
'protection-fail';