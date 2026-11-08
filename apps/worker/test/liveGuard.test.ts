// AT-11, OPS-02: the worker refuses to start with live order transport enabled.
import { describe, expect, it } from 'vitest';
import { LiveTransportError } from '@trendpilot/domain';
import { startWorker } from '../src/worker';

describe('worker live-transport guard', () => {
  it.each(['enabled', 'true', 'live'])('refuses LIVE_ORDER_TRANSPORT=%s before touching the database', async (value) => {
    // An unreachable database URL proves the guard runs before any connection attempt.
    const env = { LIVE_ORDER_TRANSPORT: value, NODE_ENV: 'test', DATABASE_URL: 'postgres://nobody:nothing@127.0.0.1:1/none' };
    await expect(startWorker({ env, log: () => {} })).rejects.toBeInstanceOf(LiveTransportError);
  });

  it('starts and stops against the test database when transport is disabled', async () => {
    const logs: string[] = [];
    const url = process.env.DATABASE_URL_TEST ?? 'postgres://trendpilot:trendpilot@localhost:5433/trendpilot_test';
    const w = await startWorker({ env: { LIVE_ORDER_TRANSPORT: 'disabled', DATABASE_URL: url }, heartbeatMs: 60_000, processJobs: false, log: (m) => logs.push(m) });
    await w.stop();
    expect(logs[0]).toMatch(/live order transport disabled/);
  });
});
