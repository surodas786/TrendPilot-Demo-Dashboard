// Migration 0029 (a Live account per exchange) applied to a database that already holds MEXC
// accounts: a scratch *_test database is migrated to 0028, given Paper and MEXC Live accounts with
// ledger rows and a MEXC connection, then upgraded. Every existing row must keep its id and values
// and read as MEXC; a Bitunix Live account can then be added; Paper stays MEXC-only; and the old
// (owner, mode) uniqueness still holds for MEXC.
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MIGRATIONS_DIR, runMigrations } from '@trendpilot/db';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { drizzle } from 'drizzle-orm/node-postgres';
import { testDatabaseUrl } from '../testDb';

const scratchName = 'trendpilot_mig0029_test';
const scratchUrl = (() => {
  const u = new URL(testDatabaseUrl());
  u.pathname = `/${scratchName}`;
  return u.toString();
})();
let tmp: string;

async function admin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: testDatabaseUrl() });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

beforeAll(async () => {
  await admin(async (c) => {
    await c.query(`DROP DATABASE IF EXISTS ${scratchName}`);
    await c.query(`CREATE DATABASE ${scratchName}`);
  });
  // A migrations folder that stops at 0028: the schema as it is deployed today.
  tmp = mkdtempSync(path.join(tmpdir(), 'tp-mig-'));
  cpSync(MIGRATIONS_DIR, tmp, { recursive: true });
  const journalPath = path.join(tmp, 'meta', '_journal.json');
  const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as { entries: { idx: number; tag: string }[] };
  for (const e of journal.entries.filter((x) => x.idx >= 29)) rmSync(path.join(tmp, `${e.tag}.sql`));
  journal.entries = journal.entries.filter((x) => x.idx < 29);
  writeFileSync(journalPath, JSON.stringify(journal));
  const c = new pg.Client({ connectionString: scratchUrl });
  await c.connect();
  try {
    await migrate(drizzle(c), { migrationsFolder: tmp });
  } finally {
    await c.end();
  }
}, 120_000);

afterAll(async () => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  await admin((c) => c.query(`DROP DATABASE IF EXISTS ${scratchName}`));
});

describe('migration 0029 on existing MEXC accounts', () => {
  it('keeps every Paper and MEXC Live account, ledger and connection; adds the per-exchange key', async () => {
    const c = new pg.Client({ connectionString: scratchUrl });
    await c.connect();
    let before: Record<string, unknown>[];
    let ledgerBefore: Record<string, unknown>[];
    let owner: string;
    try {
      const cols = await c.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'paper_accounts' AND column_name = 'exchange'`);
      expect(cols.rowCount).toBe(0); // really at 0028
      owner = (await c.query(`INSERT INTO users (email, name, role, status) VALUES ('mig@example.test', 'Mig', 'INVESTOR', 'ACTIVE') RETURNING id`)).rows[0].id as string;
      const paper = (await c.query(`INSERT INTO paper_accounts (owner_id, mode, wallet_balance, position_margin, order_reserve) VALUES ($1, 'PAPER', '10000.12345678', '12.5', '3') RETURNING id`, [owner])).rows[0];
      const live = (await c.query(`INSERT INTO paper_accounts (owner_id, mode, wallet_balance, exchange_equity, exchange_available, exchange_synced_at) VALUES ($1, 'LIVE', '251.5', '260.75', '240.1', now()) RETURNING id`, [owner])).rows[0];
      await c.query(
        `INSERT INTO ledger_entries (owner_id, paper_account_id, kind, bucket, amount, ref_type, ref_id) VALUES ($1, $2, 'EXCHANGE_BALANCE_SYNC', 'WALLET', '251.5', 'exchange_sync', 'r1'), ($1, $3, 'OPENING_BALANCE', 'WALLET', '10000.12345678', 'paper_account', 'r2')`,
        [owner, live.id, paper.id]
      );
      await c.query(`INSERT INTO exchange_connections (owner_id, account_ref, api_key_sealed, secret_sealed, key_fingerprint, status, position_mode) VALUES ($1, 'uid-1', 'sealed-k', 'sealed-s', '…1111', 'VERIFIED', 'ONE_WAY')`, [owner]);
      before = (await c.query(`SELECT * FROM paper_accounts ORDER BY mode`)).rows;
      ledgerBefore = (await c.query(`SELECT * FROM ledger_entries ORDER BY ref_id`)).rows;
    } finally {
      await c.end();
    }

    await runMigrations(scratchUrl); // the real migrations folder: applies 0029 and anything after it

    const d = new pg.Client({ connectionString: scratchUrl });
    await d.connect();
    try {
      const after = (await d.query(`SELECT * FROM paper_accounts ORDER BY mode`)).rows;
      // Every existing account: same id and every value unchanged; the new column reads MEXC.
      expect(after.map(({ exchange: _e, ...rest }) => rest)).toEqual(before);
      expect(after.map((r) => r.exchange)).toEqual(['MEXC', 'MEXC']);
      expect((await d.query(`SELECT * FROM ledger_entries ORDER BY ref_id`)).rows).toEqual(ledgerBefore);
      expect((await d.query(`SELECT exchange, status, position_mode FROM exchange_connections`)).rows).toEqual([{ exchange: 'MEXC', status: 'VERIFIED', position_mode: 'ONE_WAY' }]);
      // A Bitunix Live account can now sit next to the MEXC one…
      await d.query(`INSERT INTO paper_accounts (owner_id, mode, exchange, wallet_balance) VALUES ($1, 'LIVE', 'BITUNIX', '0')`, [owner]);
      // …but there is still one MEXC Live and one Paper account per investor, and Paper is MEXC-only.
      await expect(d.query(`INSERT INTO paper_accounts (owner_id, mode, wallet_balance) VALUES ($1, 'LIVE', '0')`, [owner])).rejects.toThrow(/paper_accounts_owner_mode_exchange_key/);
      await expect(d.query(`INSERT INTO paper_accounts (owner_id, mode, exchange, wallet_balance) VALUES ($1, 'PAPER', 'BITUNIX', '0')`, [owner])).rejects.toThrow(/paper_accounts_exchange_valid/);
      await expect(d.query(`INSERT INTO paper_accounts (owner_id, mode, exchange, wallet_balance) VALUES ($1, 'LIVE', 'BINANCE', '0')`, [owner])).rejects.toThrow(/paper_accounts_exchange_valid/);
    } finally {
      await d.end();
    }
  });
});
