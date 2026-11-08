import { defineConfig } from 'drizzle-kit';

// Generates SQL migrations from src/schema.ts. Migrations are reviewed and checked in.
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema.ts',
  out: './migrations'
});
