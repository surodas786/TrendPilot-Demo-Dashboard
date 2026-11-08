import { closeDb, createDb, FIXTURE_IDS, FIXTURE_USERS, schema, totp } from '@trendpilot/db';
import { resetDatabase, seedFixtures, seedPassword, seedTestInstruments } from '@trendpilot/db/testing';
import { eq } from 'drizzle-orm';
import * as login from '@/app/v1/auth/login/route';
import { resetAllLimits } from '@/server/rateLimit';
import { testDatabaseUrl } from './testDb';

export const BASE = 'http://localhost:3000';
export const BTC = FIXTURE_IDS.instruments.BTCUSDT;
export const ETH = FIXTURE_IDS.instruments.ETHUSDT;
export const XRP_DISABLED = FIXTURE_IDS.instruments.XRPUSDT;
export const VERSION = FIXTURE_IDS.version;
/** Test version approved for BTCUSDT and ETHUSDT. */
export const TEST_VERSION = FIXTURE_IDS.testVersion;
export const USERS = FIXTURE_USERS;

/** Direct database access for asserting stored rows, bypassing the API. */
export const direct = createDb(testDatabaseUrl(), 2);

export async function resetAndSeed(): Promise<void> {
  await resetDatabase(direct.db, testDatabaseUrl());
  await seedFixtures(direct.db);
  await seedTestInstruments(direct.db);
  resetAllLimits();
}

export async function teardown(): Promise<void> {
  await closeDb();
  await direct.close();
}

type Params = Record<string, string>;
type Handler = (req: Request, ctx?: { params: Promise<any> }) => Promise<Response>;

export interface CallOptions {
  method?: string;
  path?: string;
  cookie?: string;
  body?: unknown;
  ifMatch?: string | number;
  params?: Params;
  headers?: Record<string, string>;
}

/** Invokes a Next.js route handler exactly as an HTTP request would reach it. */
export async function call(handler: Handler, o: CallOptions = {}): Promise<{ status: number; body: any; headers: Headers }> {
  const headers: Record<string, string> = { ...o.headers };
  if (o.cookie) headers.cookie = o.cookie;
  if (o.body !== undefined) headers['content-type'] = 'application/json';
  if (o.ifMatch !== undefined) headers['if-match'] = typeof o.ifMatch === 'number' ? `"${o.ifMatch}"` : o.ifMatch;
  const req = new Request(`${BASE}${o.path ?? '/'}`, {
    method: o.method ?? 'GET',
    headers,
    body: o.body === undefined ? undefined : JSON.stringify(o.body)
  });
  const res = await handler(req, { params: Promise.resolve(o.params ?? {}) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers };
}

/** Signs in through the real login route and returns the Cookie header to send. */
export async function signIn(email: string, password = seedPassword()): Promise<string> {
  const res = await call(login.POST as Handler, { method: 'POST', path: '/v1/auth/login', body: { email, password } });
  if (res.status !== 200) throw new Error(`login failed for ${email}: ${res.status} ${JSON.stringify(res.body)}`);
  const setCookie = res.headers.get('set-cookie') ?? '';
  return setCookie.split(';')[0]!;
}

export async function userId(email: string): Promise<string> {
  const [u] = await direct.db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.email, email));
  return u!.id;
}

/** A complete valid create body; override fields per test. */
export function blockBody(overrides: Record<string, unknown> = {}) {
  return {
    instrumentId: BTC,
    strategyVersionId: VERSION,
    mode: 'PAPER',
    direction: 'BOTH',
    orderCostUsdt: '100',
    leverage: 10,
    marginMode: 'ISOLATED',
    stop: { type: 'PERCENT', value: '1.5', basis: 'MARK' },
    takeProfit: { mode: 'FIXED', levels: [{ id: 'tp1', movePct: '3', closePct: '100' }] },
    trailing: { enabled: false, activationPct: null, distancePct: null, basis: 'MARK' },
    weekdays: ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'],
    allowAdds: false,
    maxAdds: null,
    risk: { maxOpenPositions: null, maxNotionalUsdt: null, maxStopRiskUsdt: null, dailyLossLimitUsdt: null, cooldownMinutes: null, maxSpreadPct: null, maxPriceDeviationPct: null },
    ...overrides
  };
}

/** Token from the newest captured email to an address (the local mailbox, not a real inbox). */
export async function latestLinkToken(to: string, template: 'INVITE' | 'RESET'): Promise<string> {
  const rows = await direct.db.select().from(schema.emailOutbox).where(eq(schema.emailOutbox.toEmail, to));
  const mail = rows.filter((r) => r.template === template).sort((a, b) => +b.createdAt - +a.createdAt)[0];
  const m = mail && /#token=([A-Za-z0-9_-]+)/.exec(mail.bodyText);
  if (!m) throw new Error(`No ${template} email for ${to}`);
  return m[1]!;
}

export const totpNow = (secret: string, offsetSteps = 0) => totp.totpAt(secret, totp.timeStep() + offsetSteps);
