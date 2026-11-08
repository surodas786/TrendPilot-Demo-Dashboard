import { loadRootEnv } from '@trendpilot/db';
import { runOnce, startWorker } from './worker';

loadRootEnv();

try {
  if (process.argv.includes('--once')) {
    const results = await runOnce();
    process.exit(results.some((r) => r.outcome === 'DEAD') ? 2 : 0);
  }
  const worker = await startWorker();
  const shutdown = async () => {
    await worker.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
} catch (e) {
  console.error(`[worker] failed to start: ${(e as Error).message}`);
  process.exit(1);
}
