import { DEMO_START_MS } from './mockData';
import type { ExitPlan, ExitPlanConfig } from '../types/exitPlan';

export const EXAMPLE_LABEL = 'Example for simulation — performance not evaluated';

/** Editable example preset. Sample configuration only, not a trading recommendation. */
export const EXAMPLE_PRESET: {name: string;description: string;config: ExitPlanConfig;} = {
  name: 'Example · ATR stop, partial and trail',
  description: 'Initial stop 1.5 ATR. Close 50% at 1.5R, tighten the rest toward estimated breakeven, trail at 1R, close on a confirmed opposite signal.',
  config: {
    mode: 'partial-trailing',
    triggerBasis: 'mark',
    closeOnOpposite: true,
    stopMethod: 'atr',
    stopValue: 1.5,
    targetMethod: 'r',
    targetValue: 2,
    activationMethod: 'r',
    activationValue: 1,
    partialMethod: 'r',
    partialValue: 1.5,
    closePct: 50,
    moveToBreakeven: true,
    trailMethod: 'r',
    trailValue: 1
  }
};

export const EMPTY_EXIT_CONFIG: ExitPlanConfig = {
  mode: 'fixed',
  triggerBasis: 'mark',
  closeOnOpposite: false,
  stopMethod: 'percent',
  stopValue: null,
  targetMethod: 'r',
  targetValue: null,
  activationMethod: 'r',
  activationValue: null,
  partialMethod: 'r',
  partialValue: null,
  closePct: null,
  moveToBreakeven: true,
  trailMethod: 'r',
  trailValue: null
};

/** Seeded example plan on Demo Account A. Not attached to any subscription. */
export const seedExitPlans: ExitPlan[] = [
{
  id: 'xp-example-v1',
  familyId: 'xp-example',
  version: 1,
  accountId: 'acct-a',
  name: EXAMPLE_PRESET.name,
  description: EXAMPLE_PRESET.description,
  status: 'valid',
  config: { ...EXAMPLE_PRESET.config },
  example: true,
  createdAt: DEMO_START_MS - 3 * 3600000,
  updatedAt: DEMO_START_MS - 3 * 3600000
}];


/**
 * Simulated 15m ATR(10) values for previews only. Fictional — isolated from
 * dashboard prices and existing positions.
 */
export const simulatedAtr: Record<string, number> = {
  BTCUSDT: 420,
  ETHUSDT: 28,
  SOLUSDT: 2.1
};