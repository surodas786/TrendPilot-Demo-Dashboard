import { execSync } from 'node:child_process';

/** Migrates and reseeds the dedicated *_e2e database through the db package CLIs. */
export default function globalSetup(): void {
  const url = process.env.DATABASE_URL_E2E ?? 'postgres://trendpilot:trendpilot@localhost:5433/trendpilot_e2e';
  const env = { ...process.env, MIGRATE_DATABASE_URL: url, SEED_DATABASE_URL: url };
  execSync('npm run migrate -w @trendpilot/db', { stdio: 'inherit', env });
  execSync('npm run seed -w @trendpilot/db -- --reset', { stdio: 'inherit', env });
}
