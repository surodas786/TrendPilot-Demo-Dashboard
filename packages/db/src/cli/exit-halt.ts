/**
 * Automatic-exit halts on Live positions (set when MEXC rejects a close deterministically, e.g.
 * 2001, or the automatic retry budget is spent).
 *
 *   npm run ops:exit-halt                                  # list halted open positions (read-only)
 *   npm run ops:exit-halt -- --clear <positionId> --yes    # resume automatic exits for one position
 *
 * Clearing only lets the position's own triggers (take profit, trailing, signal close) request a
 * close again on a later price; it sends nothing itself. Clear it only after the cause is fixed and
 * the current MEXC position has been checked (ops:close-incident-trace / ops:live-position-check).
 */
import { and, eq, isNotNull, sql } from 'drizzle-orm';
import { createDb } from '../client';
import { loadRootEnv, requireEnv } from '../env';
import { recordAudit } from '../repos/audit';
import { positions } from '../schema';

loadRootEnv();
const arg = (n: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const clear = arg('clear');
const h = createDb(requireEnv('DATABASE_URL'), 1);
try {
  if (!clear) {
    const rows = await h.db
      .select({ id: positions.id, ownerId: positions.ownerId, side: positions.side, contracts: positions.contracts, status: positions.status, haltedAt: positions.exitHaltedAt, reason: positions.exitHaltReason, intentId: positions.exitHaltIntentId })
      .from(positions)
      .where(and(isNotNull(positions.exitHaltedAt), eq(positions.status, 'OPEN')));
    console.log(`Halted open positions: ${rows.length}`);
    if (rows.length) console.table(rows);
  } else {
    if (!process.argv.includes('--yes')) {
      console.error('Add --yes to clear the halt (automatic exits for this position resume on the next price).');
      process.exit(2);
    }
    const [row] = await h.db
      .update(positions)
      .set({ exitHaltedAt: null, exitHaltReason: null, exitHaltIntentId: null, exitRetryFrom: new Date(), updatedAt: sql`now()` })
      .where(and(eq(positions.id, clear), isNotNull(positions.exitHaltedAt)))
      .returning({ id: positions.id });
    if (!row) {
      console.log('No halt on that position.');
    } else {
      await recordAudit(h.db, { actorUserId: null, action: 'POSITION_EXIT_HALT_CLEAR', targetType: 'position', targetId: clear, result: 'SUCCESS', metadata: {}, correlationId: 'ops-exit-halt' });
      console.log(`Cleared the exit halt on ${clear}.`);
    }
  }
} finally {
  await h.close();
}
