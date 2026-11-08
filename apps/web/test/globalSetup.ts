import { runMigrations } from '@trendpilot/db';
import { testDatabaseUrl } from './testDb';

export default async function setup(): Promise<void> {
  await runMigrations(testDatabaseUrl());
}
