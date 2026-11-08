import { defineProject } from 'vitest/config';

export default defineProject({
  test: { name: 'db-unit', environment: 'node', include: ['test/**/*.test.ts'] }
});
