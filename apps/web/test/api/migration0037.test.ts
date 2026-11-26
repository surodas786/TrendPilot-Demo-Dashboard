// Migration 0037: the shared Trailing Take Profit converts to Long / Short values with the same
// first-trigger effect, and each side's Take Profit gets its overall allocation. The SQL conversion
// functions of the migration are run on literal rows and compared with the API's own conversion of
// a legacy save (liftLegacyExitPlan), so stored blocks and old clients convert identically.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MIGRATIONS_DIR } from '@trendpilot/db';
import { liftLegacyExitPlan } from '@trendpilot/domain';
import { testDatabaseUrl } from '../testDb';

let c: pg.Client;

beforeAll(async () => {
  c = new pg.Client({ connectionString: testDatabaseUrl() });
  await c.connect();
  const sql = readFileSync(path.join(MIGRATIONS_DIR, '0037_m27_exit_plan_per_side_admin.sql'), 'utf8');
  for (const stmt of sql.split('--> statement-breakpoint').map((x) => x.trim())) {
    const body = stmt.replace(/^(--.*\n)+/g, '').trim();
    if (body.startsWith('CREATE OR REPLACE FUNCTION pg_temp.')) await c.query(body);
  }
});

afterAll(async () => {
  await c?.end();
});

const tp = (mode: string) => (mode === 'OFF' ? { mode, levels: [] } : { mode, levels: [{ id: 'tp1', movePct: '3', closePct: '100' }] });
async function convert(trailing: unknown, takeProfit: unknown) {
  const r = await c.query('select pg_temp.tp_lift_trailing($1::jsonb, $2::jsonb) as tr, pg_temp.tp_lift_allocation($1::jsonb, $2::jsonb) as tp', [JSON.stringify(trailing), JSON.stringify(takeProfit)]);
  return r.rows[0] as { tr: Record<string, unknown>; tp: Record<string, unknown> };
}

describe('migration 0037 conversion', () => {
  it('trailing on 30 %, Take Profit on → TP allocation 70, trailing closes 100 % of its pool (same as the API lift)', async () => {
    const legacy = { enabled: true, activationPct: '1', distancePct: '0.5', closePct: '30', basis: 'LAST' };
    const out = await convert(legacy, tp('FIXED'));
    expect(out.tr).toEqual({ enabled: true, activationPct: '1', distancePct: '0.5', closePct: '100', targetClose: null, basis: 'LAST' });
    expect(out.tp).toMatchObject({ mode: 'FIXED', allocationPct: '70' });
    const api = liftLegacyExitPlan({ takeProfitLong: tp('FIXED'), takeProfitShort: tp('FIXED'), trailing: legacy }) as Record<string, unknown>;
    expect(api.trailingLong).toEqual(out.tr);
    expect(api.takeProfitLong).toEqual(out.tp);
  });

  it('trailing on 40 %, Take Profit off → trailing closes 40 % of the remaining quantity', async () => {
    const out = await convert({ enabled: true, activationPct: '1', distancePct: '0.5', closePct: '40', basis: 'MARK' }, tp('OFF'));
    expect(out.tr).toMatchObject({ enabled: true, closePct: '40' });
    expect(out.tp).toEqual({ mode: 'OFF', levels: [] });
  });

  it('trailing off → off, Take Profit allocation 100; Take Profit off + 0 % → off', async () => {
    expect(await convert({ enabled: false, activationPct: null, distancePct: null, basis: 'MARK' }, tp('SPLIT'))).toEqual({
      tr: { enabled: false, activationPct: null, distancePct: null, closePct: null, targetClose: null, basis: 'MARK' },
      tp: { ...tp('SPLIT'), allocationPct: '100' }
    });
    expect((await convert({ enabled: true, activationPct: '1', distancePct: '0.5', closePct: '0', basis: 'MARK' }, tp('OFF'))).tr).toMatchObject({ enabled: false });
  });

  it('decimal shares keep their precision (12.5 → 87.5); pre-allocation rows keep closePct null (conversion hold)', async () => {
    expect((await convert({ enabled: true, activationPct: '1', distancePct: '0.5', closePct: '12.5', basis: 'MARK' }, tp('FIXED'))).tp.allocationPct).toBe('87.5');
    const held = await convert({ enabled: true, activationPct: null, distancePct: '0.5', basis: 'MARK' }, tp('FIXED'));
    expect(held.tr).toMatchObject({ enabled: true, activationPct: null, closePct: null });
    expect(held.tp.allocationPct).toBe('100');
  });

  it('an allocation already present is kept', async () => {
    expect((await convert({ enabled: true, activationPct: '1', distancePct: '0.5', closePct: '30', basis: 'MARK' }, { ...tp('FIXED'), allocationPct: '55' })).tp.allocationPct).toBe('55');
  });
});
