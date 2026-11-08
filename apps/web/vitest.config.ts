import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineProject } from 'vitest/config';

const here = path.dirname(fileURLToPath(import.meta.url));

export default defineProject({
  resolve: { alias: { '@': path.join(here, 'src') } },
  test: {
    name: 'web-api',
    environment: 'node',
    include: ['test/**/*.test.ts'],
    globalSetup: ['test/globalSetup.ts'],
    setupFiles: ['test/setupEnv.ts'],
    // All files share one test database and reset it, so run them one at a time.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000
  }
});
