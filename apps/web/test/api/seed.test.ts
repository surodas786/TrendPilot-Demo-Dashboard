// SRS §14 deliverable: development seed contents (fixtures only, no credentials for any exchange).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema } from '@trendpilot/db';
import { resetDatabase, seedFixtures } from '@trendpilot/db/testing';
import { direct, teardown } from '../helpers';
import { testDatabaseUrl } from '../testDb';

beforeAll(async () => {
  await resetDatabase(direct.db, testDatabaseUrl());
  await seedFixtures(direct.db);
  await seedFixtures(direct.db); // idempotent
});
afterAll(teardown);

describe('development seed', () => {
  it('creates one admin and two investors with hashed passwords', async () => {
    const users = await direct.db.select().from(schema.users);
    expect(users.filter((u) => u.role === 'ADMIN')).toHaveLength(1);
    expect(users.filter((u) => u.role === 'INVESTOR')).toHaveLength(2);
    expect(users.every((u) => u.passwordHash?.startsWith('$argon2id$'))).toBe(true);
    expect(users.every((u) => u.timezone === 'Asia/Dhaka' && u.status === 'ACTIVE')).toBe(true);
  });

  it('publishes exactly one approved MEXC Futures contract', async () => {
    const rows = await direct.db.select().from(schema.instruments);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ exchange: 'MEXC', symbol: 'BTCUSDT', quote: 'USDT', status: 'PUBLISHED', isFixture: true });
  });

  it('publishes exactly one strategy version', async () => {
    const versions = await direct.db.select().from(schema.strategyVersions);
    expect(versions).toHaveLength(1);
    expect(versions[0]).toMatchObject({ timeframe: '15m', atrLength: 10, emaFilter: 'OFF', oppositePolicy: 'KEEP_OPEN' });
    expect(versions[0]!.publishedAt).not.toBeNull();
  });

  it('creates no order blocks or sessions', async () => {
    expect(await direct.db.select().from(schema.orderBlocks)).toHaveLength(0);
    expect(await direct.db.select().from(schema.sessions)).toHaveLength(0);
  });
});
