import { loadRootEnv, requireEnv } from '../env';
import { runMigrations } from '../migrate';

loadRootEnv();
const url = process.env.MIGRATE_DATABASE_URL ?? requireEnv('DATABASE_URL');
await runMigrations(url);
console.log(`Migrations applied to ${new URL(url).pathname.slice(1)}.`);
