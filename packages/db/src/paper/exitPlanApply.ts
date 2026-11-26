import { and, eq, inArray, sql } from 'drizzle-orm';
import {
  Decimal,
  partialCloseContracts,
  partialExitCheck,
  planExits,
  takeProfitFor,
  takeProfitPrice,
  trailingActivationPrice,
  trailingFor,
  trailingLevelFrom,
  type ExitPlanSettings
} from '@trendpilot/domain';
import type { Executor } from '../client';
import { instruments, orderIntents, positions, positionTargets } from '../schema';

/**
 * Admin → Common Exit Definition, "Apply to existing linked positions": updates the exit plan of one
 * open position in place, atomically, or leaves it untouched with a reason.
 *
 * Preserved, never reset: completed targets (DONE) and their identities, a target or trailing close
 * whose order is still in flight (the update waits for none and never adds a second order), the
 * persisted quantity of a trailing trigger that is not filled yet, trailing cycle history (cycle
 * count, completed extreme, watermark) and a target close that already fired. Only exits that have
 * not acted yet take the new thresholds.
 *
 * Refused (SKIPPED) as a whole: positions opened under earlier exit rules (before per-side partial
 * trailing), and plans whose quantities the instrument's exchange limits would refuse.
 */

const D = (v: Decimal.Value) => new Decimal(v);
const UNRESOLVED = ['INTENT', 'SUBMITTING', 'ACKNOWLEDGED', 'PARTIALLY_FILLED', 'UNKNOWN'] as const;

export interface ExitPlanApplyOutcome {
  positionId: string;
  ownerId: string;
  orderBlockId: string;
  side: 'LONG' | 'SHORT';
  /** APPLIED (written), WOULD_APPLY (preview), SKIPPED (left on its previous plan). */
  status: 'APPLIED' | 'WOULD_APPLY' | 'SKIPPED';
  reason?: string;
  /** Human-readable list of what changes. */
  changes: string[];
  /** Kept as they were (completed, in flight). */
  kept: string[];
  /** Thresholds the latest price already crosses: the exit may fire on the next fresh price. */
  warnings: string[];
}

export async function applyExitPlanToPosition(tx: Executor, positionId: string, plan: ExitPlanSettings, o: { version: number; now: Date; dryRun?: boolean; lastPrice?: string | null }): Promise<ExitPlanApplyOutcome> {
  const [p] = await tx.select().from(positions).where(eq(positions.id, positionId)).for(o.dryRun ? 'share' : 'update');
  const side = (p?.side ?? 'LONG') as 'LONG' | 'SHORT';
  const out: ExitPlanApplyOutcome = { positionId, ownerId: p?.ownerId ?? '', orderBlockId: p?.orderBlockId ?? '', side, status: o.dryRun ? 'WOULD_APPLY' : 'APPLIED', changes: [], kept: [], warnings: [] };
  const skip = (reason: string): ExitPlanApplyOutcome => ({ ...out, status: 'SKIPPED', reason, changes: [] });
  if (!p || p.status !== 'OPEN') return skip('POSITION_NOT_OPEN: the position is no longer open.');
  const snap = p.settingsSnapshot as { exitRules?: string } | null;
  if (snap?.exitRules !== 'V3') return skip('LEGACY_EXIT_RULES: opened under earlier exit rules (before per-side partial trailing); it keeps the plan it was opened with.');

  const [inst] = await tx.select().from(instruments).where(eq(instruments.id, p.instrumentId));
  const spec = { priceTick: inst!.priceTick, qtyStep: inst!.qtyStep };
  const limits = { qtyStep: inst!.qtyStep, minQty: inst!.minQty };
  const tp = takeProfitFor(plan, side);
  const tr = trailingFor(plan, side);
  const planned = planExits(side, p.avgEntryPrice, p.initialContracts, { takeProfit: tp, trailing: tr }, spec);

  // Validate against the instrument before anything is written.
  let left = D(p.initialContracts);
  for (const [i, t] of planned.targets.entries()) {
    const c = partialExitCheck(t.plannedContracts, left.toFixed(), limits);
    if (!c.ok) return skip(`INVALID_FOR_INSTRUMENT: take profit target ${i + 1} (${t.plannedContracts} of ${left.toFixed()}) — ${c.message}`);
    left = left.minus(t.plannedContracts);
  }
  if (tr.enabled && tr.closePct) {
    const first = partialCloseContracts(planned.trailingContracts, tr.closePct, spec.qtyStep);
    if (D(planned.trailingContracts).gt(0)) {
      const c = partialExitCheck(first, p.initialContracts, limits);
      if (!c.ok) return skip(`INVALID_FOR_INSTRUMENT: trailing take profit (${first} of ${p.initialContracts}) — ${c.message}`);
    }
  }

  const inFlight = await tx
    .select({ exitReason: orderIntents.exitReason, targetLevelId: orderIntents.targetLevelId })
    .from(orderIntents)
    .where(and(eq(orderIntents.positionId, p.id), eq(orderIntents.kind, 'CLOSE'), inArray(orderIntents.state, [...UNRESOLVED])));
  const trailingInFlight = inFlight.some((i) => i.exitReason === 'TRAILING_TAKE_PROFIT');

  /* ── Take Profit targets, matched by their stable level ID ── */
  const rows = await tx.select().from(positionTargets).where(eq(positionTargets.positionId, p.id));
  const byId = new Map(rows.map((r) => [r.levelId, r]));
  const wantIds = new Set(planned.targets.map((t) => t.levelId));
  const price = o.lastPrice ?? null;
  const writes: (() => Promise<unknown>)[] = [];
  for (const t of planned.targets) {
    const row = byId.get(t.levelId);
    if (!row) {
      out.changes.push(`Add target ${t.ordinal} (${t.levelId}) at ${t.triggerPrice} for ${t.plannedContracts}`);
      if (price && (side === 'LONG' ? D(price).gte(t.triggerPrice) : D(price).lte(t.triggerPrice))) out.warnings.push(`Target ${t.ordinal} at ${t.triggerPrice} is already reached: it arms on the next fresh price.`);
      writes.push(() => tx.insert(positionTargets).values({ ownerId: p.ownerId, positionId: p.id, ...t, triggerBasis: p.takeProfitBasis ?? p.stopBasis, triggerRule: 'ARM_PULLBACK' }).onConflictDoNothing());
      continue;
    }
    if (row.status === 'DONE' || row.status === 'CANCELLED') {
      out.kept.push(`Target ${row.levelId}: ${row.status === 'DONE' ? 'already completed' : 'cancelled'} — never fires again`);
      continue;
    }
    if (row.status === 'REQUESTED' || inFlight.some((i) => i.targetLevelId === row.levelId)) {
      out.kept.push(`Target ${row.levelId}: its order is in flight — kept unchanged`);
      continue;
    }
    const plannedQty = Decimal.max(t.plannedContracts, row.filledContracts).toFixed();
    const samePrice = D(row.triggerPrice).eq(t.triggerPrice);
    if (samePrice && D(row.plannedContracts).eq(plannedQty) && row.ordinal === t.ordinal) continue;
    out.changes.push(`Target ${row.levelId}: ${row.triggerPrice} → ${t.triggerPrice}, ${row.plannedContracts} → ${plannedQty}${D(row.filledContracts).gt(0) ? ` (${row.filledContracts} already filled)` : ''}`);
    if (!samePrice && price && (side === 'LONG' ? D(price).gte(t.triggerPrice) : D(price).lte(t.triggerPrice))) out.warnings.push(`Target ${row.levelId} at ${t.triggerPrice} is already reached: it arms on the next fresh price.`);
    writes.push(() =>
      tx
        .update(positionTargets)
        .set({
          ordinal: t.ordinal,
          movePct: t.movePct,
          closePct: t.closePct,
          triggerPrice: t.triggerPrice,
          plannedContracts: plannedQty,
          // A moved target re-arms from a fresh price; an unmoved one keeps its arming.
          ...(samePrice ? {} : { armedAt: null, armedPrice: null }),
          updatedAt: sql`now()`
        })
        .where(eq(positionTargets.id, row.id))
    );
  }
  for (const row of rows) {
    if (wantIds.has(row.levelId) || row.status === 'DONE' || row.status === 'CANCELLED') continue;
    if (row.status === 'REQUESTED' || inFlight.some((i) => i.targetLevelId === row.levelId)) {
      out.kept.push(`Target ${row.levelId}: removed from the plan but its order is in flight — it completes first`);
      continue;
    }
    out.changes.push(`Cancel target ${row.levelId} (not in the new plan)${D(row.filledContracts).gt(0) ? `; ${row.filledContracts} already filled stays booked` : ''}`);
    writes.push(() => tx.update(positionTargets).set({ status: 'CANCELLED', updatedAt: sql`now()` }).where(eq(positionTargets.id, row.id)));
  }

  /* ── Trailing Take Profit ── */
  const trailingSet: Partial<typeof positions.$inferInsert> = {};
  const pending = p.trailingCycleContracts !== null && D(p.trailingCycleFilled).lt(p.trailingCycleContracts);
  if (trailingInFlight || pending) {
    out.kept.push(`Trailing take profit: a close of ${p.trailingCycleContracts ?? '?'} is ${trailingInFlight ? 'in flight' : 'pending completion'} — it completes with its saved quantity first; trailing settings are kept until then`);
  } else if (!tr.enabled || !tr.activationPct || !tr.distancePct || !tr.closePct) {
    if (p.trailingStatus !== 'OFF' && p.trailingStatus !== 'DONE') {
      out.changes.push('Trailing take profit: off');
      Object.assign(trailingSet, { trailingStatus: 'DONE', trailingUpdatedAt: o.now });
    }
  } else {
    const activation = trailingActivationPrice(side, p.avgEntryPrice, tr.activationPct, spec.priceTick);
    const status = p.trailingStatus === 'OFF' || p.trailingStatus === 'DONE' ? 'WAITING' : p.trailingStatus;
    if (p.trailingStatus === 'DONE' && p.trailingCycle > 0) {
      out.kept.push('Trailing take profit: already closed its whole pool — stays done');
    } else {
      // The level only ever tightens (also enforced by a database trigger): a new retracement
      // applies from the next better price; it never loosens the level the position already holds.
      const candidate = (status === 'ACTIVE' || status === 'REARM') && p.trailingWatermark ? trailingLevelFrom(side, p.trailingWatermark, tr.distancePct, spec.priceTick) : null;
      const level = candidate === null ? p.trailingStopPrice : p.trailingStopPrice === null ? candidate : side === 'LONG' ? Decimal.max(candidate, p.trailingStopPrice).toFixed() : Decimal.min(candidate, p.trailingStopPrice).toFixed();
      if (status === 'WAITING' && p.trailingActivationPrice !== activation) out.changes.push(`Trailing activation ${p.trailingActivationPrice ?? '—'} → ${activation}`);
      if (p.trailingDistancePct === null || !D(p.trailingDistancePct).eq(tr.distancePct)) out.changes.push(`Trailing retracement ${p.trailingDistancePct ?? '—'}% → ${tr.distancePct}%${level && level !== p.trailingStopPrice ? ` (level ${p.trailingStopPrice} → ${level})` : ''}`);
      if (p.trailingClosePct === null || !D(p.trailingClosePct).eq(tr.closePct)) out.changes.push(`Close on each trigger ${p.trailingClosePct ?? '—'}% → ${tr.closePct}% (from the next trigger)`);
      if (p.trailingBasis !== tr.basis) out.changes.push(`Trailing basis ${p.trailingBasis ?? '—'} → ${tr.basis}`);
      if (p.trailingStatus === 'OFF') out.changes.push('Trailing take profit: on (waits for activation)');
      if (p.trailingCycle > 0) out.kept.push(`Trailing take profit: ${p.trailingCycle} completed cycle(s) and their best price ${p.trailingCycleExtreme ?? '—'} are kept`);
      if (level && price && (side === 'LONG' ? D(price).lte(level) : D(price).gte(level)) && status === 'ACTIVE') out.warnings.push(`The new trailing level ${level} is already crossed: trailing may close on the next fresh price.`);
      Object.assign(trailingSet, {
        trailingKind: 'TAKE_PROFIT',
        trailingStatus: status,
        trailingBasis: tr.basis,
        trailingDistancePct: tr.distancePct,
        trailingActivationPrice: status === 'WAITING' ? activation : p.trailingActivationPrice,
        trailingStopPrice: level,
        trailingClosePct: tr.closePct,
        trailingUpdatedAt: o.now
      });
    }
  }
  // Target close inside trailing: one-shot. Fired / done / skipped ones are kept.
  const tc = tr.enabled && tr.targetClose?.enabled && tr.targetClose.movePct && tr.targetClose.closePct ? tr.targetClose : null;
  const tcFired = p.trailingTargetContracts !== null || ['REQUESTED', 'DONE', 'SKIPPED'].includes(p.trailingTargetStatus ?? '');
  if (tcFired) {
    if (p.trailingTargetStatus) out.kept.push(`Trailing target close: ${p.trailingTargetStatus === 'DONE' ? 'already completed' : p.trailingTargetStatus === 'SKIPPED' ? 'already fired (not sent)' : 'fired, completing its saved quantity'} — never fires again`);
  } else if (tc) {
    const tcPrice = takeProfitPrice(side, p.avgEntryPrice, tc.movePct!, spec.priceTick);
    if (p.trailingTargetPrice !== tcPrice || p.trailingTargetClosePct === null || !D(p.trailingTargetClosePct).eq(tc.closePct!)) out.changes.push(`Trailing target close ${p.trailingTargetPrice ?? 'none'} → ${tcPrice} (${tc.closePct}% of the pool)`);
    if (price && (side === 'LONG' ? D(price).gte(tcPrice) : D(price).lte(tcPrice))) out.warnings.push(`The trailing target close at ${tcPrice} is already reached: it closes on the next fresh price.`);
    Object.assign(trailingSet, { trailingTargetPrice: tcPrice, trailingTargetClosePct: tc.closePct, trailingTargetStatus: 'PENDING' });
  } else if (p.trailingTargetStatus === 'PENDING') {
    out.changes.push('Trailing target close: removed');
    Object.assign(trailingSet, { trailingTargetStatus: 'CANCELLED' });
  }


  if (o.dryRun) return out;
  for (const w of writes) await w();
  await tx
    .update(positions)
    .set({
      ...trailingSet,
      exitPlanSource: 'ADMIN',
      exitPlanAdminVersion: o.version,
      exitPlanAppliedAt: o.now,
      settingsSnapshot: sql`${positions.settingsSnapshot} || ${JSON.stringify({ exitPlanApplied: { version: o.version, appliedAt: o.now.toISOString(), takeProfit: tp, trailingSide: tr } })}::jsonb`,
      updatedAt: sql`now()`
    })
    .where(eq(positions.id, p.id));
  return out;
}
