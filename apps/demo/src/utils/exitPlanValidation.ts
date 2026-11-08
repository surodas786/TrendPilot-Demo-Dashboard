import type { ExitPlanConfig } from '../types/exitPlan';

export type PlanField = 'name' | 'triggerBasis' | 'stopValue' | 'targetValue' | 'activationValue' | 'partialValue' | 'closePct' | 'trailValue';
export type PlanErrors = Partial<Record<PlanField, string>>;

type ValueKind = 'percent' | 'r' | 'multiple' | 'price';

function check(v: number | null, kind: ValueKind): string | undefined {
  if (v === null) return 'Required for this mode.';
  if (Number.isNaN(v)) return 'Enter a number.';
  if (v <= 0) return 'Must be greater than zero.';
  if (kind === 'percent' && v >= 100) return 'Use a price move below 100%.';
  if ((kind === 'r' || kind === 'multiple') && v > 20) return 'Use 20 or less in this demo.';
  return undefined;
}

const kindOf = (m: 'percent' | 'price' | 'r' | 'atr'): ValueKind => m === 'atr' ? 'multiple' : m;

export function validateName(name: string): string | undefined {
  const n = name.trim();
  if (!n) return 'Enter a plan name.';
  if (n.length > 60) return 'Use 60 characters or fewer.';
  return undefined;
}

/**
 * Structural validity only. A structurally valid plan can still fail order-specific
 * checks for a particular pair, direction, quantity or entry price.
 */
export function validatePlanStructure(name: string, c: ExitPlanConfig): PlanErrors {
  const e: PlanErrors = {
    name: validateName(name),
    triggerBasis: c.triggerBasis ? undefined : 'Select a trigger basis.',
    stopValue: check(c.stopValue, kindOf(c.stopMethod))
  };
  if (c.mode === 'fixed') e.targetValue = check(c.targetValue, kindOf(c.targetMethod));
  if (c.mode === 'trailing') {
    e.activationValue = check(c.activationValue, kindOf(c.activationMethod));
    e.trailValue = check(c.trailValue, kindOf(c.trailMethod));
  }
  if (c.mode === 'partial-trailing') {
    e.partialValue = check(c.partialValue, kindOf(c.partialMethod));
    e.trailValue = check(c.trailValue, kindOf(c.trailMethod));
    if (c.closePct === null) e.closePct = 'Required for this mode.';else
    if (Number.isNaN(c.closePct)) e.closePct = 'Enter a number.';else
    if (c.closePct <= 0 || c.closePct >= 100) e.closePct = 'Must be greater than 0 and less than 100.';
  }
  (Object.keys(e) as PlanField[]).forEach((k) => e[k] === undefined && delete e[k]);
  return e;
}

export function isPlanStructurallyValid(name: string, c: ExitPlanConfig): boolean {
  return Object.keys(validatePlanStructure(name, c)).length === 0;
}