import path from 'node:path';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { createDb } from './client';
import { findRepoRoot } from './env';

export const MIGRATIONS_DIR = path.join(findRepoRoot(), 'packages/db/migrations');

export async function runMigrations(connectionString: string): Promise<void> {
  const h = createDb(connectionString, 1);
  try {
    await migrate(h.db, { migrationsFolder: MIGRATIONS_DIR });
  } finally {
    await h.close();
  }
}
