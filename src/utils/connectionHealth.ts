import type {
  CheckResult,
  ConnectionScenario,
  ConnectionStatus,
  DemoAccount,
  HealthDimension } from
'../types/trading';

export const SCENARIO_OPTIONS: {value: ConnectionScenario;label: string;description: string;}[] = [
{ value: 'healthy', label: 'Healthy connection', description: 'All simulated checks pass' },
{ value: 'invalid-credentials', label: 'Invalid credentials', description: 'The demo key is rejected' },
{ value: 'missing-trade-permission', label: 'Missing trade permission', description: 'Key can read data but cannot trade' },
{ value: 'public-feed-down', label: 'Public feed unavailable', description: 'Simulated market prices stop streaming' },
{ value: 'private-feed-down', label: 'Private feed unavailable', description: 'Order and position updates stop streaming' },
{ value: 'sync-failed', label: 'Account synchronization failed', description: 'Balances and positions do not reconcile' }];


export const WIZARD_SCENARIOS: {value: ConnectionScenario;label: string;description: string;}[] = [
{ value: 'healthy', label: 'Successful connection', description: 'All checks pass' },
{ value: 'invalid-credentials', label: 'Invalid credentials', description: 'Credential check fails' },
{ value: 'missing-trade-permission', label: 'Missing trade permission', description: 'Trading permission check fails' },
{ value: 'exchange-unavailable', label: 'Exchange unavailable', description: 'Simulated exchange outage' }];


export function scenarioLabel(scenario: ConnectionScenario): string {
  return (
    SCENARIO_OPTIONS.find((s) => s.value === scenario)?.label ??
    WIZARD_SCENARIOS.find((s) => s.value === scenario)?.label ??
    scenario);

}

export function isCredentialScenario(scenario: ConnectionScenario): boolean {
  return scenario === 'invalid-credentials' || scenario === 'missing-trade-permission';
}

export interface ConnectionHealth {
  credentials: HealthDimension;
  tradePermission: HealthDimension;
  publicFeed: HealthDimension;
  privateFeed: HealthDimension;
  sync: HealthDimension;
}

/** Each dimension is tracked separately so one failure never masks another. */
export function connectionHealth(a: DemoAccount): ConnectionHealth {
  if (a.disconnected) {
    return { credentials: 'off', tradePermission: 'off', publicFeed: 'off', privateFeed: 'off', sync: 'off' };
  }
  const s = a.scenario;
  return {
    credentials: s === 'invalid-credentials' ? 'failed' : 'ok',
    tradePermission: s === 'missing-trade-permission' ? 'failed' : 'ok',
    publicFeed: s === 'public-feed-down' || s === 'exchange-unavailable' ? 'failed' : 'ok',
    privateFeed: s === 'private-feed-down' || s === 'exchange-unavailable' ? 'failed' : 'ok',
    sync: s === 'sync-failed' || a.lastSyncAttempt?.ok === false ? 'failed' : 'ok'
  };
}

export function failureReason(a: DemoAccount): string | null {
  if (a.disconnected) return null;
  const h = connectionHealth(a);
  if (a.scenario === 'exchange-unavailable') return 'Exchange unavailable (simulated)';
  if (h.credentials === 'failed') return 'Demo credentials rejected';
  if (h.tradePermission === 'failed') return 'Trade permission missing';
  if (h.privateFeed === 'failed') return 'Private account feed unavailable';
  if (h.publicFeed === 'failed') return 'Public market feed unavailable';
  if (h.sync === 'failed') return 'Account synchronization failed';
  return null;
}

export function connectionStatus(a: DemoAccount): ConnectionStatus {
  if (a.disconnected) return 'disconnected';
  const h = connectionHealth(a);
  if (h.credentials === 'failed' || a.scenario === 'exchange-unavailable') return 'error';
  if (failureReason(a)) return 'degraded';
  if (a.needsRevalidation) return 'validation-required';
  return 'connected';
}

export const STATUS_LABELS: Record<ConnectionStatus, string> = {
  connected: 'Connected',
  'validation-required': 'Validation required',
  degraded: 'Degraded',
  error: 'Error',
  disconnected: 'Disconnected'
};

export interface EntryState {
  enabled: boolean;
  kind: 'enabled' | 'user' | 'blocked' | 'validation' | 'disconnected';
  label: 'Enabled' | 'Paused';
  reason: string;
}

export function entryState(a: DemoAccount): EntryState {
  if (a.disconnected) return { enabled: false, kind: 'disconnected', label: 'Paused', reason: 'Connection disconnected' };
  if (a.entriesPaused) return { enabled: false, kind: 'user', label: 'Paused', reason: 'Paused for this account' };
  const failure = failureReason(a);
  if (failure) return { enabled: false, kind: 'blocked', label: 'Paused', reason: `Blocked — ${failure.toLowerCase()}` };
  if (a.needsRevalidation) return { enabled: false, kind: 'validation', label: 'Paused', reason: 'Validation and sync required' };
  return { enabled: true, kind: 'enabled', label: 'Enabled', reason: 'New simulated entries allowed' };
}

const CHECKS: {id: string;label: string;detail: string;}[] = [
{ id: 'credentials', label: 'Credential validation', detail: 'Demo key and secret accepted' },
{ id: 'identity', label: 'Account identity', detail: 'Paper account identified' },
{ id: 'access', label: 'Balance and position access', detail: 'Balances, positions, orders and fills readable' },
{ id: 'trading', label: 'Trading permission', detail: 'Submit and cancel trades allowed · withdrawals not requested' },
{ id: 'mode', label: 'Position mode', detail: 'One-way mode confirmed' },
{ id: 'instruments', label: 'Eligible instruments', detail: 'BTCUSDT, ETHUSDT and SOLUSDT perpetuals available' },
{ id: 'sync', label: 'Account synchronization', detail: 'Balances and positions reconciled' }];


const FAILURES: Partial<Record<ConnectionScenario, {id: string;reason: string;}>> = {
  'invalid-credentials': { id: 'credentials', reason: 'The demo API key or secret was rejected (simulated signature error).' },
  'exchange-unavailable': { id: 'credentials', reason: 'The exchange did not respond — simulated service outage. Try again later.' },
  'missing-trade-permission': { id: 'trading', reason: 'The demo key can read data but lacks “Submit and cancel trades”.' },
  'private-feed-down': { id: 'access', reason: 'Private account feed unavailable — balances and positions could not be read.' },
  'public-feed-down': { id: 'instruments', reason: 'Public market feed unavailable — instrument data could not be loaded.' },
  'sync-failed': { id: 'sync', reason: 'Balances and positions did not reconcile during synchronization.' }
};

export function buildChecks(scenario: ConnectionScenario): CheckResult[] {
  const failure = FAILURES[scenario];
  const failIndex = failure ? CHECKS.findIndex((c) => c.id === failure.id) : -1;
  return CHECKS.map((c, i) => {
    if (failIndex === -1 || i < failIndex) return { id: c.id, label: c.label, state: 'passed', detail: c.detail };
    if (i === failIndex) return { id: c.id, label: c.label, state: 'failed', reason: failure?.reason };
    return { id: c.id, label: c.label, state: 'skipped' };
  });
}

export function syncOutcome(a: DemoAccount): {ok: boolean;reason?: string;} {
  switch (a.scenario) {
    case 'invalid-credentials':
      return { ok: false, reason: 'Credentials rejected — account could not be read' };
    case 'exchange-unavailable':
      return { ok: false, reason: 'Exchange unavailable (simulated)' };
    case 'private-feed-down':
      return { ok: false, reason: 'Private account feed unavailable' };
    case 'sync-failed':
      return { ok: false, reason: 'Balances and positions did not reconcile' };
    default:
      return { ok: true };
  }
}

/** Builds a fictional masked reference. Credential values themselves are never kept. */
export function maskKey(key: string): string {
  const clean = key.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  const last = clean.slice(-4).padStart(4, '0');
  return `DEMO-••••-${last}`;
}