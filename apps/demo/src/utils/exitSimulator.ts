import { computeExitPreview, floorToStep, roundPrice, sideSign, trailDistanceAt } from './exitPlanMath';
import type { ExitPreview, ExitPreviewInput } from './exitPlanMath';
import { round2 } from './accountMath';
import { formatNumber } from './format';
import type { ExitMode, SimEvent, SimEventKind, SimFrame, SimPhase, SimScenario } from '../types/exitPlan';

export const SIM_SCENARIOS: {id: SimScenario;label: string;modes: ExitMode[];}[] = [
{ id: 'stop-hit', label: 'Initial stop hit', modes: ['fixed', 'trailing', 'partial-trailing'] },
{ id: 'target', label: 'Target reached', modes: ['fixed'] },
{ id: 'trailing-exit', label: 'Favorable movement, then trailing exit', modes: ['trailing'] },
{ id: 'partial-trailing', label: 'Partial target filled, then trailing exit', modes: ['partial-trailing'] },
{ id: 'opposite', label: 'Confirmed opposite signal', modes: ['fixed', 'trailing', 'partial-trailing'] },
{ id: 'gap', label: 'Price gap through stop', modes: ['fixed', 'trailing', 'partial-trailing'] },
{ id: 'partial-min', label: 'Partial exit below minimum quantity', modes: ['partial-trailing'] }];


export const PHASE_LABELS: Record<SimPhase, string> = {
  open: 'Open — initial stop and target active',
  waiting: 'Waiting for activation',
  trailing: 'Trailing active',
  triggered: 'Exit triggered',
  closing: 'Closing',
  closed: 'Closed',
  rejected: 'Entry rejected'
};

export interface SimResult {
  frames: SimFrame[];
  preview: ExitPreview;
  rejected: string | null;
  summary: {gross: number;fees: number;net: number;slippage: number;} | null;
}

interface PathSpec {
  rs: number[];
  oppositeAt?: number;
  gapAt?: number;
}

function buildPath(scenario: SimScenario, p: ExitPreview): PathSpec {
  const trR = p.trailR ?? 1;
  const ramp = (peak: number) => {
    const up = [0.15, 0.3, 0.5, 0.7, 0.85, 1].map((k) => +(k * peak).toFixed(3));
    const step = Math.max(trR * 0.35, 0.12);
    const down: number[] = [];
    for (let r = peak - step, n = 0; n < 12 && r > peak - trR * 1.8 - 0.2; r -= step, n++) down.push(+r.toFixed(3));
    return [...up, ...down];
  };
  switch (scenario) {
    case 'stop-hit':
      return { rs: [-0.2, -0.45, -0.7, -0.9, -1.02, -1.15] };
    case 'target':{
        const t = p.targetR ?? 2;
        return { rs: [0.25 * t, 0.12 * t, 0.45 * t, 0.7 * t, 0.9 * t, t + 0.05, t + 0.2] };
      }
    case 'trailing-exit':
      return { rs: ramp((p.activationR ?? 1) + Math.max(trR * 1.5, 0.6)) };
    case 'partial-trailing':
      return { rs: ramp((p.partial?.r ?? 1.5) + Math.max(trR * 1.5, 0.6)) };
    case 'opposite':
      return { rs: [0.2, 0.45, 0.35, 0.5, 0.42, 0.48], oppositeAt: 3 };
    case 'gap':
      return { rs: [0.15, 0.3, 0.12, -1.6], gapAt: 3 };
    default:
      return { rs: [] };
  }
}

/**
 * Deterministic step-by-step exit simulation over explicit ordered price updates.
 * Frames are precomputed, so replaying or repeated clicks can never duplicate a fill.
 * Isolated from account records — never touches balances or positions.
 */
export function runExitSimulation(input: ExitPreviewInput, scenario: SimScenario): SimResult {
  let preview = computeExitPreview(input);
  if (scenario === 'partial-min') {
    const spec = preview.spec;
    preview = computeExitPreview({ ...input, quantityOverride: floorToStep(spec.minQuantity * 1.5, spec) });
  }
  const c = input.config;
  const dec = preview.spec.priceDecimals;
  const qd = preview.spec.quantityDecimals;
  const asset = preview.spec.baseAsset;
  const px = (v: number) => formatNumber(v, dec);
  const qty = (v: number) => `${formatNumber(v, qd)} ${asset}`;
  let seq = 0;
  const ev = (kind: SimEventKind, title: string, detail = ''): SimEvent => ({ id: `e${seq++}`, kind, title, detail });

  const entry = preview.entryPrice;
  const s = sideSign(input.direction);
  const blocking = preview.errors[0] ?? (preview.stopPrice === null ? 'Initial stop is incomplete — complete the stop rule to simulate.' : null);
  if (blocking) {
    return {
      preview,
      rejected: blocking,
      summary: null,
      frames: [
      {
        step: 0,
        price: entry,
        activeStop: null,
        best: entry,
        phase: 'rejected',
        remaining: 0,
        events: [ev('reject', 'Entry configuration rejected before any order', blocking)]
      }]

    };
  }

  const d = preview.stopDistance as number;
  const initialStop = preview.stopPrice as number;
  const f = preview.feeRate;
  let stop = initialStop;
  let best = entry;
  let remaining = preview.quantity;
  let trailing = false;
  let partialDone = false;
  let gross = 0;
  let fees = preview.entryFee;
  let slippage = 0;
  const basePhase = (): SimPhase => trailing ? 'trailing' : c.mode === 'fixed' ? 'open' : 'waiting';
  const basis = c.triggerBasis === 'last' ? 'last' : 'mark';

  const frames: SimFrame[] = [
  {
    step: 0,
    price: entry,
    activeStop: stop,
    best,
    phase: basePhase(),
    remaining,
    events: [
    ev('entry', 'Entry filled', `${input.direction === 'long' ? 'Long' : 'Short'} ${qty(remaining)} at ${px(entry)} (simulated average fill)`),
    ev(
      'protection',
      'Initial protection established',
      `Stop ${px(initialStop)} · 1R = ${px(d)}${preview.targetPrice !== null ? ` · target ${px(preview.targetPrice)}` : ''}${
      preview.partial ? ` · partial target ${px(preview.partial.price)}` : ''}${
      preview.activationPrice !== null ? ` · trailing activates at ${px(preview.activationPrice)}` : ''}`
    )]

  }];


  const path = buildPath(scenario, preview);
  const prices = path.rs.map((r) => roundPrice(entry + s * r * d, dec));
  let closed = false;

  const closeOut = (price: number, trigger: number, fill: number, reason: string, pre: SimEvent[]) => {
    frames.push({ step: frames.length, price, activeStop: stop, best, phase: 'triggered', remaining, events: [...pre, ev('exit-trigger', `${reason} triggered`, `Trigger ${px(trigger)} on ${basis} price ${px(price)}`)] });
    frames.push({ step: frames.length, price, activeStop: stop, best, phase: 'closing', remaining, events: [ev('closing', 'Closing order submitted', `Reduce-only close of ${qty(remaining)} (simulated)`)] });
    const slip = Math.abs(fill - trigger);
    slippage = slip;
    gross += s * (fill - entry) * remaining;
    fees += fill * remaining * f;
    const closedQty = remaining;
    remaining = 0;
    const obsolete = [
    reason.includes('stop') ? null : 'stop order',
    c.mode === 'fixed' && !reason.includes('Target') ? 'take-profit order' : null,
    c.mode === 'partial-trailing' && !partialDone ? 'partial take-profit order' : null].
    filter(Boolean) as string[];
    frames.push({
      step: frames.length,
      price,
      activeStop: null,
      best,
      phase: 'closed',
      remaining: 0,
      events: [
      ev(
        'close-fill',
        'Closing fill confirmed',
        `${qty(closedQty)} at ${px(fill)}${slip > 0 ? ` · slippage ${px(slip)} (${formatNumber(slip / trigger * 100, 3)}%) worse than trigger ${px(trigger)}` : ' · filled at trigger price in this simulation'}`
      ),
      ev('cancel', 'Obsolete exit orders cancelled', `${obsolete.length ? obsolete.join(', ') : 'No remaining exit orders'} · no reverse position opened · exit processing stopped`)]

    });
    closed = true;
  };

  for (let i = 0; i < prices.length && !closed; i++) {
    const p = prices[i];
    const events: SimEvent[] = [];
    if (s * (p - best) > 0) best = p;

    // 1. Stop check against the stop that was active before this update.
    if (s * (p - stop) <= 0) {
      const isGap = i === path.gapAt;
      const label = stop === initialStop ? 'Initial stop' : trailing ? 'Trailing stop' : 'Adjusted stop';
      closeOut(p, stop, isGap ? p : stop, label, events);
      break;
    }
    // 2. Fixed target
    if (c.mode === 'fixed' && preview.targetPrice !== null && s * (p - preview.targetPrice) >= 0) {
      closeOut(p, preview.targetPrice, preview.targetPrice, 'Target', events);
      break;
    }
    // 3. Partial target (mode C) — trailing activates after the partial fill.
    if (c.mode === 'partial-trailing' && preview.partial && !partialDone && s * (p - preview.partial.price) >= 0) {
      const pp = preview.partial;
      events.push(ev('partial-trigger', 'Partial target triggered', `Trigger ${px(pp.price)} on ${basis} price ${px(p)}`));
      gross += s * (pp.price - entry) * pp.quantity;
      fees += pp.price * pp.quantity * f;
      remaining = pp.remaining;
      partialDone = true;
      events.push(ev('partial-fill', 'Partial exit filled', `${qty(pp.quantity)} at ${px(pp.price)} · ${qty(remaining)} remains`));
      if (c.moveToBreakeven && preview.breakeven !== null) {
        const tightened = s * (preview.breakeven - stop) > 0;
        if (tightened) {
          events.push(ev('stop-adjust', 'Remaining stop adjusted', `${px(stop)} → ${px(preview.breakeven)} (toward estimated breakeven)`));
          stop = preview.breakeven;
        } else events.push(ev('info', 'Remaining stop kept', `Estimated breakeven ${px(preview.breakeven)} would loosen the stop — not applied`));
      }
      trailing = true;
      best = p;
      events.push(ev('trail-activate', 'Trailing activated', `After partial fill · best ${basis} price ${px(best)}`));
    }
    // 4. Trailing activation (mode B)
    if (c.mode === 'trailing' && !trailing && preview.activationPrice !== null && s * (p - preview.activationPrice) >= 0) {
      trailing = true;
      events.push(ev('trail-activate', 'Trailing activated', `Activation ${px(preview.activationPrice)} reached · initial stop stays until a tighter level applies`));
    }
    // 5. Tighten — never loosen.
    if (trailing) {
      const dist = trailDistanceAt(c, best, d);
      if (dist !== null) {
        const candidate = roundPrice(best - s * dist, dec);
        if (s * (candidate - stop) > 0) {
          events.push(ev('trail-tighten', 'Trailing stop tightened', `${px(stop)} → ${px(candidate)} · best ${px(best)} ${s > 0 ? '−' : '+'} ${px(dist)}`));
          stop = candidate;
        }
      }
    }
    // 6. Opposite signal
    if (i === path.oppositeAt) {
      events.push(ev('opposite', 'Confirmed opposite strategy signal', `Received at ${basis} price ${px(p)}`));
      if (c.closeOnOpposite) {
        closeOut(p, p, p, 'Opposite-signal exit', events);
        break;
      }
      events.push(ev('info', 'Position kept open', 'Opposite-signal exit is off in this plan — no reverse position is opened'));
    }
    frames.push({ step: frames.length, price: p, activeStop: stop, best, phase: basePhase(), remaining, events });
  }

  if (!closed) {
    const last = frames[frames.length - 1];
    last.events.push(ev('info', 'Preview path ended', 'Position remains open under the plan'));
  }

  return {
    preview,
    rejected: null,
    frames,
    summary: closed ? { gross: round2(gross), fees: round2(fees), net: round2(gross - fees), slippage } : null
  };
}