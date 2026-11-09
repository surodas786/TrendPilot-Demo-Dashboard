import { loadRootEnv } from '@trendpilot/db';
import { runFeedOnce, startFeed } from './feed';

loadRootEnv();

try {
  if (process.argv.includes('--once')) {
    const s = await runFeedOnce();
    process.exit(s.instruments.some((r) => r.state === 'DOWN') ? 2 : 0);
  }
  const feed = await startFeed();
  const shutdown = async () => {
    await feed.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
} catch (e) {
  console.error(`[feed] failed to start: ${(e as Error).message}`);
  process.exit(1);
}
