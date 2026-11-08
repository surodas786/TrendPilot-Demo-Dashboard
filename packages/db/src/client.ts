import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { loadRootEnv, requireEnv } from './env';
import * as schema from './schema';

export type Db = NodePgDatabase<typeof schema>;
/** A database handle or an open transaction; repositories accept either. */
export type Executor = Db | Parameters<Parameters<Db['transaction']>[0]>[0];

export interface DbHandle {
  db: Db;
  pool: pg.Pool;
  close: () => Promise<void>;
}

export function createDb(connectionString: string, max = 10): DbHandle {
  const pool = new pg.Pool({ connectionString, max });
  const db = drizzle(pool, { schema });
  return { db, pool, close: () => pool.end() };
}

type GlobalWithDb = typeof globalThis & { __trendpilotDb?: DbHandle };

/** Process-wide handle for DATABASE_URL, reused across Next.js hot reloads. */
export function getDb(): Db {
  const g = globalThis as GlobalWithDb;
  if (!g.__trendpilotDb) {
    loadRootEnv();
    g.__trendpilotDb = createDb(requireEnv('DATABASE_URL'));
  }
  return g.__trendpilotDb.db;
}

export async function closeDb(): Promise<void> {
  const g = globalThis as GlobalWithDb;
  const h = g.__trendpilotDb;
  g.__trendpilotDb = undefined;
  await h?.close();
}
