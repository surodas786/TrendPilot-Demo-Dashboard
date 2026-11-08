import { loadRootEnv } from '@trendpilot/db';

/** The integration-test database. Never the development database. */
export function testDatabaseUrl(): string {
  loadRootEnv();
  const url = process.env.DATABASE_URL_TEST ?? 'postgres://trendpilot:trendpilot@localhost:5433/trendpilot_test';
  if (!/_test$/.test(new URL(url).pathname)) throw new Error(`DATABASE_URL_TEST must point at a *_test database, got ${url}`);
  return url;
}
