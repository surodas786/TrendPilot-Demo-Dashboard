import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: ['packages/domain', 'packages/db', 'apps/web', 'apps/worker']
  }
});
