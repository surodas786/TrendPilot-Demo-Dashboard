export interface ScenarioOverrides {
  /** Fixed simulated entry ATR per pair for a named demonstration. */
  atr: Record<string, number>;
  /** Entry and exit fills at the reference/trigger price (named demonstration only). */
  zeroSlippage: boolean;
}

export interface PresentationState {
  loadedAt: number;
  /** Index into PRESENTATION_PRICES of the last applied update (0 = entry price). */
  step: number;
  accountIds: string[];
}

export const PRESENTATION_NAME = 'Shared signal to completed trade';
export const PRESENTATION_PAIR = 'BTCUSDT';
export const PRESENTATION_ATR = 200;

/** Ordered simulated price updates. Mark price = last price in this scenario. */
export const PRESENTATION_PRICES = [50000, 50150, 50450, 50600, 50800, 50650, 50500];

export const PRESENTATION_ACCOUNTS = [
{ accountId: 'acct-a', userId: 'user-1', name: 'Presentation Account A', subscriptionId: 'sub-a-trend', planId: 'xp-pres-a-v1', orderCost: 100, leverage: 5 },
{ accountId: 'acct-c', userId: 'user-2', name: 'Presentation Account B', subscriptionId: 'sub-c-trend', planId: 'xp-pres-c-v1', orderCost: 50, leverage: 5 }];


/** Accounts removed from the fixture so each user has exactly one connected paper account. */
export const PRESENTATION_REMOVED_ACCOUNTS = ['acct-b', 'acct-d'];

export const PRESENTATION_SCOPE = [
'Nadia Rahman → Demo Account A becomes “Presentation Account A” (order cost 100 USDT, 5×)',
'Omar Siddiqui → Demo Account C becomes “Presentation Account B” (order cost 50 USDT, 5×)',
'Both reset to 5,000 USDT wallet and equity with no positions, orders, ledger events, transfers or funding',
'Demo Accounts B and D are removed from this fixture so each user has one connected account (Reset demo restores them)',
'Other subscriptions on these accounts are removed; each account gets one partial-profit-and-trailing exit plan and a Ready Supertrend 15m subscription (not activated)',
'Entry pauses, user suspension and the global halt are cleared; route policy and BTCUSDT price reset to 50,000'];


export const PRESENTATION_ASSUMPTIONS = [
'Entry ATR fixed at 200 USDT → initial stop 1.5 ATR = 49,700, 1R = 300',
'Partial target 1.5R = 50,450 closes 50%; remaining stop tightens toward estimated breakeven, then trails 1R from the best price',
'Mark price and last price are equal in this scenario',
'Zero slippage in this named demonstration only — other scenarios keep the 0.02% assumption',
'Fee 0.05% per fill · no funding settlements'];


/** Annotation shown for each playback step. */
export const PRESENTATION_NOTES = [
'Entry price. After dispatch both accounts fill at 50,000 and protection is confirmed at 49,700.',
'50,150 — below the 50,450 partial target. No exit; stop stays at 49,700.',
'50,450 — partial target triggers; 50% fills. Remaining stop moves toward estimated breakeven and trailing starts at 1R from 50,450.',
'50,600 — new best price. Trailing stop rises to 50,300.',
'50,800 — high of the move. Trailing stop rises to 50,500.',
'50,650 — pullback. Stops never loosen; stop stays at 50,500.',
'50,500 — trailing stop triggers; remaining position closes at 50,500.'];