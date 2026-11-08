import type { SignalScenarioId } from '../types/signals';

export interface SignalScenarioMeta {
  id: SignalScenarioId;
  label: string;
  expected: string;
  /** Extra setup beyond the common reset of Demo Accounts C and D. */
  setup: string[];
  resetsAccountA?: boolean;
  preDispatch?: string;
}

/** Common scope of every scenario setup. Shown before confirmation. */
export const SCENARIO_COMMON_SCOPE = [
'Resets Demo Account C and D (Omar Siddiqui) to empty positions, orders and ledger with their original balances',
'Restores their Supertrend subscriptions, Omar’s user status and the route policy to defaults',
'Releases the global entry halt and clears signal sequence watermarks (feed history is kept)',
'Resets shared paper prices to the default mock prices'];


export const signalScenarios: SignalScenarioMeta[] = [
{
  id: 'two-users',
  label: 'One shared signal executes for two users',
  expected: 'Accounts A and C execute independently; D is rejected for margin.',
  setup: ['Resets Demo Account A (Nadia Rahman) to an empty signal-ready fixture with 5,000 USDT', 'Attaches the example exit plan to “Supertrend · BTC & ETH” and activates it'],
  resetsAccountA: true
},
{ id: 'margin', label: 'One account lacks margin while another executes', expected: 'C executes; D is rejected — margin would fall below its reserve.', setup: [] },
{
  id: 'duplicate',
  label: 'Duplicate signal causes no second entry',
  expected: 'The second receipt is stored as a duplicate referencing the first and creates no dispatch.',
  setup: [],
  preDispatch: 'Dispatches an Open long SOLUSDT signal first, then pre-fills the same signal ID'
},
{ id: 'expired', label: 'Expired signal is rejected', expected: 'Rejected: received 95 s after candle close (entry limit 30 s).', setup: [] },
{
  id: 'out-of-order',
  label: 'Out-of-order signal is rejected',
  expected: 'Rejected: the candle is older than the accepted watermark.',
  setup: [],
  preDispatch: 'Dispatches an Open long ETHUSDT signal for the latest candle first'
},
{ id: 'paused-sub', label: 'Paused subscription is skipped', expected: 'C is skipped — its subscription is paused. No pause is lifted.', setup: ['Pauses “Supertrend · all pairs” on Demo Account C'] },
{
  id: 'existing-position',
  label: 'Existing position blocks another entry',
  expected: 'C is skipped — one position per account and pair.',
  setup: [],
  preDispatch: 'Dispatches an Open long BTCUSDT signal for the previous candle first'
},
{ id: 'unknown', label: 'Entry submission outcome is unknown', expected: 'C shows Outcome unknown with margin reserved; reconcile it — no retry is sent.', setup: ['Demo Account C entry submissions return no acknowledgement'] },
{ id: 'partial', label: 'Partial entry fill receives protection', expected: 'C fills half; the stop covers the filled part; fill the remainder to resize protection.', setup: ['Demo Account C entries fill 50% first'] },
{ id: 'protection-fail', label: 'Protection fails and recovery is attempted', expected: 'C fills, its stop is rejected, and a reduce-only recovery close runs.', setup: ['Demo Account C protective stops are rejected'] }];