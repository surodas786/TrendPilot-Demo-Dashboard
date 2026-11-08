export type ExitMode = 'fixed' | 'trailing' | 'partial-trailing';
export type TriggerBasis = 'mark' | 'last';
export type StopMethod = 'percent' | 'price' | 'atr';
export type TargetMethod = 'percent' | 'price' | 'r';
export type ThresholdMethod = 'percent' | 'r';
export type DistanceMethod = 'percent' | 'price' | 'r';
export type ExitPlanStatus = 'draft' | 'valid' | 'archived';

/**
 * Exit rules. Percentages always refer to underlying price movement from the
 * average entry, never to leveraged return on margin. "price" values are USDT per
 * unit of the underlying asset (or an explicit price for fixed targets).
 */
export interface ExitPlanConfig {
  mode: ExitMode;
  triggerBasis: TriggerBasis | null;
  closeOnOpposite: boolean;
  stopMethod: StopMethod;
  stopValue: number | null;
  /** Mode A */
  targetMethod: TargetMethod;
  targetValue: number | null;
  /** Mode B */
  activationMethod: ThresholdMethod;
  activationValue: number | null;
  /** Mode C */
  partialMethod: ThresholdMethod;
  partialValue: number | null;
  closePct: number | null;
  moveToBreakeven: boolean;
  /** Modes B and C */
  trailMethod: DistanceMethod;
  trailValue: number | null;
}

/** One immutable version of an exit plan. Editing a saved plan creates a new version in the same family. */
export interface ExitPlan {
  id: string;
  familyId: string;
  version: number;
  accountId: string;
  name: string;
  description: string;
  status: ExitPlanStatus;
  config: ExitPlanConfig;
  example?: boolean;
  createdAt: number;
  updatedAt: number;
}

export type SimScenario = 'stop-hit' | 'target' | 'trailing-exit' | 'partial-trailing' | 'opposite' | 'gap' | 'partial-min';

export type SimEventKind =
'entry' |
'protection' |
'partial-trigger' |
'partial-fill' |
'stop-adjust' |
'trail-activate' |
'trail-tighten' |
'opposite' |
'exit-trigger' |
'closing' |
'close-fill' |
'cancel' |
'reject' |
'info';

export interface SimEvent {
  id: string;
  kind: SimEventKind;
  title: string;
  detail: string;
}

export type SimPhase = 'open' | 'waiting' | 'trailing' | 'triggered' | 'closing' | 'closed' | 'rejected';

export interface SimFrame {
  step: number;
  price: number;
  activeStop: number | null;
  best: number;
  phase: SimPhase;
  remaining: number;
  events: SimEvent[];
}