import { DEMO_START_MS } from './mockData';
import type { DemoUser } from '../types/signals';
import type { ExitPlan } from '../types/exitPlan';
import type { Subscription } from '../types/strategy';
import type { DemoAccount } from '../types/trading';
import type { UserLink } from '../types/users';

const HOUR = 3600000;
const DAY = 24 * HOUR;

export const PRIMARY_USER_ID = 'user-1';
export const ADMIN_OPERATOR = 'Demo Administrator';

/** Fictional demo users. Accounts without a userId belong to the primary user. */
export const demoUsers: DemoUser[] = [
{ id: 'user-1', name: 'Nadia Rahman', email: 'nadia@trendpilot.example', status: 'active', invitation: 'accepted', createdAt: DEMO_START_MS - 30 * DAY, entriesPaused: false, workspacePaused: false },
{ id: 'user-2', name: 'Omar Siddiqui', email: 'omar@trendpilot.example', status: 'active', invitation: 'accepted', createdAt: DEMO_START_MS - 12 * DAY, entriesPaused: false, workspacePaused: false },
{ id: 'user-3', name: 'Farhan Ahmed', email: 'farhan@trendpilot.example', status: 'invited', invitation: 'pending', createdAt: DEMO_START_MS - 2 * DAY, entriesPaused: false, workspacePaused: false },
{ id: 'user-4', name: 'Lina Chowdhury', email: 'lina@trendpilot.example', status: 'suspended', invitation: 'accepted', createdAt: DEMO_START_MS - 20 * DAY, entriesPaused: false, workspacePaused: false }];


/** Simulated invitation for the seeded invited subscriber. */
export const seedUserLinks: UserLink[] = [{ id: 'SIM-INV-SEED-FA01', userId: 'user-3', kind: 'invite', createdAt: DEMO_START_MS - 2 * DAY, state: 'active' }];

const baseAccount = {
  exchangeId: 'mexc',
  environment: 'paper' as const,
  scenario: 'healthy' as const,
  disconnected: false,
  entriesPaused: false,
  needsRevalidation: false
};

/** Second user's fictional paper accounts. Original accounts and balances are unchanged. */
export const secondUserAccounts: DemoAccount[] = [
{
  ...baseAccount,
  id: 'acct-c',
  userId: 'user-2',
  name: 'Demo Account C',
  descriptor: 'Swing paper account',
  openingEquity: 3000,
  maxOpenPositions: 3,
  maskedKey: 'DEMO-••••-C2T8',
  createdAt: DEMO_START_MS - 9 * DAY,
  preferences: { allowedPairs: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'], positionMode: 'One-way', marginMode: 'Isolated', leverage: 5, isDefault: true },
  lastSyncAt: DEMO_START_MS - 9000,
  lastSyncAttempt: { at: DEMO_START_MS - 9000, ok: true },
  lastValidation: { at: DEMO_START_MS - 4 * HOUR, ok: true }
},
{
  ...baseAccount,
  id: 'acct-d',
  userId: 'user-2',
  name: 'Demo Account D',
  descriptor: 'Small paper account',
  openingEquity: 150,
  maxOpenPositions: 2,
  maskedKey: 'DEMO-••••-D5W1',
  createdAt: DEMO_START_MS - 3 * DAY,
  preferences: { allowedPairs: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'], positionMode: 'One-way', marginMode: 'Isolated', leverage: 5, isDefault: false },
  lastSyncAt: DEMO_START_MS - 14000,
  lastSyncAttempt: { at: DEMO_START_MS - 14000, ok: true },
  lastValidation: { at: DEMO_START_MS - 3 * HOUR, ok: true }
}];


const created = DEMO_START_MS - 4 * HOUR;

export const secondUserExitPlans: ExitPlan[] = [
{
  id: 'xp-c-fixed-v1',
  familyId: 'xp-c-fixed',
  version: 1,
  accountId: 'acct-c',
  name: 'ATR stop · 2R target',
  description: 'Initial stop 1.5 ATR, fixed target at 2R, close on a confirmed opposite signal.',
  status: 'valid',
  config: {
    mode: 'fixed',
    triggerBasis: 'mark',
    closeOnOpposite: true,
    stopMethod: 'atr',
    stopValue: 1.5,
    targetMethod: 'r',
    targetValue: 2,
    activationMethod: 'r',
    activationValue: null,
    partialMethod: 'r',
    partialValue: null,
    closePct: null,
    moveToBreakeven: true,
    trailMethod: 'r',
    trailValue: null
  },
  createdAt: created,
  updatedAt: created
},
{
  id: 'xp-d-fixed-v1',
  familyId: 'xp-d-fixed',
  version: 1,
  accountId: 'acct-d',
  name: '2% stop · 4% target',
  description: 'Initial stop 2% from entry, fixed target 4%.',
  status: 'valid',
  config: {
    mode: 'fixed',
    triggerBasis: 'mark',
    closeOnOpposite: false,
    stopMethod: 'percent',
    stopValue: 2,
    targetMethod: 'percent',
    targetValue: 4,
    activationMethod: 'r',
    activationValue: null,
    partialMethod: 'r',
    partialValue: null,
    closePct: null,
    moveToBreakeven: true,
    trailMethod: 'r',
    trailValue: null
  },
  createdAt: created,
  updatedAt: created
}];


export const secondUserSubscriptions: Subscription[] = [
{
  id: 'sub-c-trend',
  label: 'Supertrend · all pairs',
  strategyId: 'supertrend-15m',
  version: '1.0',
  accountId: 'acct-c',
  exchangeId: 'mexc',
  pairs: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'],
  directions: 'both',
  emaFilter: true,
  orderCost: 100,
  leverage: 5,
  riskPolicyId: 'acct-c',
  exitPlanId: 'xp-c-fixed-v1',
  lifecycle: 'saved',
  paused: false,
  activated: true,
  createdAt: created,
  updatedAt: created
},
{
  id: 'sub-d-trend',
  label: 'Supertrend · BTC & ETH',
  strategyId: 'supertrend-15m',
  version: '1.0',
  accountId: 'acct-d',
  exchangeId: 'mexc',
  pairs: ['BTCUSDT', 'ETHUSDT'],
  directions: 'both',
  emaFilter: true,
  orderCost: 100,
  leverage: 5,
  riskPolicyId: 'acct-d',
  exitPlanId: 'xp-d-fixed-v1',
  lifecycle: 'saved',
  paused: false,
  activated: true,
  createdAt: created,
  updatedAt: created
}];


export function ownerOf(account: DemoAccount | undefined): string {
  return account?.userId ?? PRIMARY_USER_ID;
}