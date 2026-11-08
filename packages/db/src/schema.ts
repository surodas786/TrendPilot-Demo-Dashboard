import { sql } from 'drizzle-orm';
import {
  boolean,
  primaryKey,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid
} from 'drizzle-orm/pg-core';

/**
 * §10 data model, M1 slice: users, sessions, catalog, order blocks, audit.
 * Money and quantities use numeric; timestamps are UTC (timestamptz).
 */

export const userRole = pgEnum('user_role', ['ADMIN', 'INVESTOR']);
export const userStatus = pgEnum('user_status', ['ACTIVE', 'SUSPENDED', 'INVITED']);
export const instrumentStatus = pgEnum('instrument_status', ['PUBLISHED', 'DISABLED']);
export const timeframe = pgEnum('timeframe', ['5m', '15m']);
export const direction = pgEnum('direction', ['LONG_ONLY', 'SHORT_ONLY', 'BOTH']);
export const emaFilter = pgEnum('ema_filter', ['OFF', 'EMA200']);
export const oppositePolicy = pgEnum('opposite_policy', ['KEEP_OPEN', 'CLOSE_ONLY', 'CLOSE_AND_REVERSE']);
export const tradingMode = pgEnum('trading_mode', ['PAPER', 'LIVE']);
export const marginMode = pgEnum('margin_mode', ['ISOLATED', 'CROSS']);
export const blockStatus = pgEnum('block_status', ['ACTIVE', 'PAUSED']);
export const sessionStage = pgEnum('session_stage', ['ACTIVE', 'MFA_PENDING']);
export const tokenKind = pgEnum('token_kind', ['INVITE', 'RESET']);

const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp('updated_at', { withTimezone: true }).notNull().defaultNow();

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: text('email').notNull(),
    name: text('name').notNull(),
    role: userRole('role').notNull(),
    status: userStatus('status').notNull().default('ACTIVE'),
    passwordHash: text('password_hash'),
    timezone: text('timezone').notNull().default('Asia/Dhaka'),
    /** AES-GCM sealed TOTP secret (security/secretBox). Never returned by any API. */
    mfaSecretEnc: text('mfa_secret_enc'),
    mfaPendingSecretEnc: text('mfa_pending_secret_enc'),
    mfaEnabledAt: timestamp('mfa_enabled_at', { withTimezone: true }),
    /** Last accepted TOTP time step, for replay protection. */
    mfaLastStep: integer('mfa_last_step'),
    invitedBy: uuid('invited_by'),
    suspendedAt: timestamp('suspended_at', { withTimezone: true }),
    revision: integer('revision').notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt()
  },
  (t) => [uniqueIndex('users_email_key').on(t.email), check('users_email_lowercase', sql`${t.email} = lower(${t.email})`)]
);

export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** SHA-256 of the opaque cookie token. The token itself is never stored. */
    tokenHash: text('token_hash').notNull(),
    createdAt: createdAt(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    /** MFA_PENDING sessions only allow completing the second factor. */
    stage: sessionStage('stage').notNull().default('ACTIVE'),
    userAgent: text('user_agent'),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow()
  },
  (t) => [uniqueIndex('sessions_token_hash_key').on(t.tokenHash), index('sessions_user_id_idx').on(t.userId)]
);

export const instruments = pgTable(
  'instruments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    exchange: text('exchange').notNull(),
    symbol: text('symbol').notNull(),
    base: text('base').notNull(),
    quote: text('quote').notNull(),
    status: instrumentStatus('status').notNull().default('DISABLED'),
    contractMultiplier: numeric('contract_multiplier', { precision: 28, scale: 12 }).notNull(),
    qtyStep: numeric('qty_step', { precision: 28, scale: 12 }).notNull(),
    minQty: numeric('min_qty', { precision: 28, scale: 12 }).notNull(),
    maxQty: numeric('max_qty', { precision: 28, scale: 12 }).notNull().default('1000000'),
    priceTick: numeric('price_tick', { precision: 28, scale: 12 }).notNull().default('0.01'),
    takerFeeRate: numeric('taker_fee_rate', { precision: 10, scale: 8 }).notNull().default('0.0004'),
    exchangeSymbol: text('exchange_symbol').notNull().default(''),
    leverageChoices: integer('leverage_choices').array().notNull(),
    suggestedStopPct: numeric('suggested_stop_pct', { precision: 10, scale: 4 }).notNull(),
    suggestedTakeProfitPct: numeric('suggested_take_profit_pct', { precision: 10, scale: 4 }).notNull(),
    suggestedTrailingEnabled: boolean('suggested_trailing_enabled').notNull().default(false),
    suggestedTrailingPct: numeric('suggested_trailing_pct', { precision: 10, scale: 4 }).notNull(),
    /** True for seeded fixture metadata that is not verified against the live exchange. */
    isFixture: boolean('is_fixture').notNull().default(false),
    revision: integer('revision').notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt()
  },
  (t) => [uniqueIndex('instruments_exchange_symbol_key').on(t.exchange, t.symbol)]
);

export const strategyPackages = pgTable('strategy_packages', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  createdAt: createdAt()
});

/** CFG-02: a published version is immutable. Repositories expose no update for it. */
export const strategyVersions = pgTable(
  'strategy_versions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    packageId: uuid('package_id')
      .notNull()
      .references(() => strategyPackages.id),
    version: integer('version').notNull(),
    timeframe: timeframe('timeframe').notNull(),
    atrLength: integer('atr_length').notNull(),
    atrFactor: numeric('atr_factor', { precision: 10, scale: 4 }).notNull(),
    permittedDirections: direction('permitted_directions').notNull(),
    emaFilter: emaFilter('ema_filter').notNull().default('OFF'),
    oppositePolicy: oppositePolicy('opposite_policy').notNull().default('KEEP_OPEN'),
    signalMaxAgeSeconds: integer('signal_max_age_seconds').notNull().default(120),
    maxPriceDeviationPct: numeric('max_price_deviation_pct', { precision: 10, scale: 4 }).notNull().default('0.5'),
    /** Null while a draft. Once set, the row and its pair mappings are immutable (DB trigger). */
    publishedAt: timestamp('published_at', { withTimezone: true }),
    publishedBy: uuid('published_by'),
    createdBy: uuid('created_by'),
    revision: integer('revision').notNull().default(1),
    createdAt: createdAt()
  },
  (t) => [uniqueIndex('strategy_versions_package_version_key').on(t.packageId, t.version)]
);

/** CFG-02 approved contract mappings of a strategy version. */
export const strategyVersionInstruments = pgTable(
  'strategy_version_instruments',
  {
    versionId: uuid('version_id')
      .notNull()
      .references(() => strategyVersions.id),
    instrumentId: uuid('instrument_id')
      .notNull()
      .references(() => instruments.id)
  },
  (t) => [primaryKey({ columns: [t.versionId, t.instrumentId] })]
);

/** IAM-01 invitation and password-reset links: hashed, expiring, single-use. */
export const userTokens = pgTable(
  'user_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    kind: tokenKind('kind').notNull(),
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    /** Set when a newer link of the same kind replaces this one. */
    supersededAt: timestamp('superseded_at', { withTimezone: true }),
    createdBy: uuid('created_by'),
    createdAt: createdAt()
  },
  (t) => [uniqueIndex('user_tokens_token_hash_key').on(t.tokenHash), index('user_tokens_user_idx').on(t.userId, t.kind)]
);

/** Development email capture (§13 "mock email"). Replaced by a provider adapter later. */
export const emailOutbox = pgTable('email_outbox', {
  id: uuid('id').primaryKey().defaultRandom(),
  toEmail: text('to_email').notNull(),
  subject: text('subject').notNull(),
  bodyText: text('body_text').notNull(),
  template: text('template').notNull(),
  createdAt: createdAt()
});

/** CFG-03 order block. One per owner, instrument and mode (D5). */
export const orderBlocks = pgTable(
  'order_blocks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id),
    instrumentId: uuid('instrument_id')
      .notNull()
      .references(() => instruments.id),
    strategyVersionId: uuid('strategy_version_id')
      .notNull()
      .references(() => strategyVersions.id),
    mode: tradingMode('mode').notNull(),
    direction: direction('direction').notNull(),
    orderCostUsdt: numeric('order_cost_usdt', { precision: 28, scale: 8 }).notNull(),
    leverage: integer('leverage').notNull(),
    marginMode: marginMode('margin_mode').notNull(),
    stop: jsonb('stop').notNull(),
    takeProfit: jsonb('take_profit').notNull(),
    trailing: jsonb('trailing').notNull(),
    weekdays: text('weekdays')
      .array()
      .notNull()
      .default(sql`ARRAY['SUN','MON','TUE','WED','THU','FRI','SAT']::text[]`),
    timezone: text('timezone').notNull().default('Asia/Dhaka'),
    allowAdds: boolean('allow_adds').notNull().default(false),
    maxAdds: integer('max_adds'),
    risk: jsonb('risk').notNull().default({}),
    status: blockStatus('status').notNull().default('PAUSED'),
    revision: integer('revision').notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt()
  },
  (t) => [
    uniqueIndex('order_blocks_owner_instrument_mode_key').on(t.ownerId, t.instrumentId, t.mode),
    index('order_blocks_owner_id_idx').on(t.ownerId),
    check('order_blocks_order_cost_positive', sql`${t.orderCostUsdt} > 0`),
    check('order_blocks_leverage_positive', sql`${t.leverage} > 0`),
    check('order_blocks_weekdays_valid', sql`${t.weekdays} <@ ARRAY['SUN','MON','TUE','WED','THU','FRI','SAT']::text[]`),
    check('order_blocks_max_adds_range', sql`${t.maxAdds} IS NULL OR (${t.maxAdds} BETWEEN 1 AND 10)`),
    check('order_blocks_revision_positive', sql`${t.revision} > 0`)
  ]
);

/** OPS-04: append-only audit trail. No update or delete path exists in the repositories. */
export const auditEvents = pgTable(
  'audit_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    actorUserId: uuid('actor_user_id').references(() => users.id),
    action: text('action').notNull(),
    targetType: text('target_type').notNull(),
    targetId: text('target_id'),
    result: text('result').notNull(),
    before: jsonb('before'),
    after: jsonb('after'),
    metadata: jsonb('metadata'),
    correlationId: text('correlation_id').notNull(),
    createdAt: createdAt()
  },
  (t) => [index('audit_events_target_idx').on(t.targetType, t.targetId), index('audit_events_actor_idx').on(t.actorUserId)]
);

/* ───────────────────────── M2 slice 1: TradingView intake (§6) and jobs (ARC-01) ───────────────────────── */

export const signalAction = pgEnum('signal_action', ['BULLISH_FLIP', 'BEARISH_FLIP', 'CLOSE_LONG', 'CLOSE_SHORT']);
export const routeKind = pgEnum('route_kind', ['ACTIONABLE', 'INFO_ONLY']);
export const eventDisposition = pgEnum('event_disposition', ['DISPATCH', 'INFO_ONLY']);
export const eventStatus = pgEnum('event_status', ['ACCEPTED', 'DISPATCHED']);
export const jobStatus = pgEnum('job_status', ['PENDING', 'RUNNING', 'DONE', 'DEAD']);
export const decisionStatus = pgEnum('decision_status', ['READY_FOR_EVALUATION', 'SKIPPED']);

/** SIG-01: rotatable ingress. Only a SHA-256 verifier and a short lookup prefix are stored. */
export const webhookIngress = pgTable(
  'webhook_ingress',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Stable namespace for the SIG-05 dedupe key; survives token rotation. */
    namespace: text('namespace').notNull(),
    name: text('name').notNull(),
    tokenPrefix: text('token_prefix').notNull(),
    tokenHash: text('token_hash').notNull(),
    rotatedAt: timestamp('rotated_at', { withTimezone: true }),
    createdBy: uuid('created_by'),
    createdAt: createdAt()
  },
  (t) => [uniqueIndex('webhook_ingress_namespace_key').on(t.namespace), index('webhook_ingress_prefix_idx').on(t.tokenPrefix)]
);

/** SIG-04: source tuple → execution contract and strategy lineage (package). */
export const signalRoutes = pgTable(
  'signal_routes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ingressId: uuid('ingress_id')
      .notNull()
      .references(() => webhookIngress.id),
    name: text('name').notNull(),
    sourceExchange: text('source_exchange').notNull(),
    sourceSymbol: text('source_symbol').notNull(),
    interval: text('interval').notNull(),
    action: signalAction('action').notNull(),
    kind: routeKind('kind').notNull().default('ACTIONABLE'),
    instrumentId: uuid('instrument_id')
      .notNull()
      .references(() => instruments.id),
    packageId: uuid('package_id')
      .notNull()
      .references(() => strategyPackages.id),
    maxSignalAgeSeconds: integer('max_signal_age_seconds').notNull().default(120),
    clockToleranceSeconds: integer('clock_tolerance_seconds').notNull().default(5),
    enabled: boolean('enabled').notNull().default(true),
    revision: integer('revision').notNull().default(1),
    createdBy: uuid('created_by'),
    createdAt: createdAt(),
    updatedAt: updatedAt()
  },
  (t) => [
    // Reject ambiguous routes: one enabled route per source tuple.
    uniqueIndex('signal_routes_tuple_key')
      .on(t.ingressId, t.sourceExchange, t.sourceSymbol, t.interval, t.action)
      .where(sql`${t.enabled}`),
    check('signal_routes_interval_valid', sql`${t.interval} IN ('5', '15')`),
    check('signal_routes_age_range', sql`${t.maxSignalAgeSeconds} BETWEEN 10 AND 3600`),
    check('signal_routes_tolerance_range', sql`${t.clockToleranceSeconds} BETWEEN 0 AND 60`)
  ]
);

/** SIG-05: one row per accepted canonical event. */
export const signalEvents = pgTable(
  'signal_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ingressNamespace: text('ingress_namespace').notNull(),
    routeId: uuid('route_id')
      .notNull()
      .references(() => signalRoutes.id),
    streamKey: text('stream_key').notNull(),
    action: signalAction('action').notNull(),
    sourceExchange: text('source_exchange').notNull(),
    sourceSymbol: text('source_symbol').notNull(),
    interval: text('interval').notNull(),
    instrumentId: uuid('instrument_id')
      .notNull()
      .references(() => instruments.id),
    packageId: uuid('package_id')
      .notNull()
      .references(() => strategyPackages.id),
    barOpenAt: timestamp('bar_open_at', { withTimezone: true }).notNull(),
    barCloseAt: timestamp('bar_close_at', { withTimezone: true }).notNull(),
    alertFiredAt: timestamp('alert_fired_at', { withTimezone: true }).notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull(),
    referencePrice: numeric('reference_price', { precision: 32, scale: 12 }).notNull(),
    disposition: eventDisposition('disposition').notNull(),
    status: eventStatus('status').notNull().default('ACCEPTED'),
    dispatchedAt: timestamp('dispatched_at', { withTimezone: true }),
    correlationId: text('correlation_id').notNull(),
    createdAt: createdAt()
  },
  (t) => [
    uniqueIndex('signal_events_dedupe_key').on(t.ingressNamespace, t.routeId, t.barOpenAt, t.action),
    index('signal_events_stream_idx').on(t.streamKey, t.barOpenAt),
    check('signal_events_bar_order', sql`${t.barCloseAt} > ${t.barOpenAt}`)
  ]
);

/** Rejected deliveries, kept for operations. Never contains the ingress token. */
export const signalRejections = pgTable(
  'signal_rejections',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ingressNamespace: text('ingress_namespace'),
    routeId: uuid('route_id'),
    reason: text('reason').notNull(),
    httpStatus: integer('http_status').notNull(),
    detail: jsonb('detail'),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull(),
    correlationId: text('correlation_id').notNull(),
    createdAt: createdAt()
  },
  (t) => [index('signal_rejections_received_idx').on(t.receivedAt)]
);

/** ARC-01 durable job queue (transactional outbox). At-least-once; claims expire; fenced completion. */
export const jobs = pgTable(
  'jobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    kind: text('kind').notNull(),
    /** Idempotency: one job per logical unit of work (e.g. one dispatch per event). */
    dedupeKey: text('dedupe_key').notNull(),
    payload: jsonb('payload').notNull(),
    status: jobStatus('status').notNull().default('PENDING'),
    runAfter: timestamp('run_after', { withTimezone: true }).notNull().defaultNow(),
    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(8),
    claimedBy: text('claimed_by'),
    claimToken: uuid('claim_token'),
    claimExpiresAt: timestamp('claim_expires_at', { withTimezone: true }),
    lastError: text('last_error'),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt()
  },
  (t) => [uniqueIndex('jobs_dedupe_key').on(t.dedupeKey), index('jobs_claimable_idx').on(t.status, t.runAfter)]
);

/** SIG-05 / §10: private per-investor outcome. Unique per event, order block and decision step. */
export const signalDecisions = pgTable(
  'signal_decisions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    eventId: uuid('event_id')
      .notNull()
      .references(() => signalEvents.id),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id),
    orderBlockId: uuid('order_block_id')
      .notNull()
      .references(() => orderBlocks.id),
    strategyVersionId: uuid('strategy_version_id')
      .notNull()
      .references(() => strategyVersions.id),
    step: text('step').notNull(),
    status: decisionStatus('status').notNull(),
    reason: text('reason'),
    detail: jsonb('detail').notNull(),
    evaluatedAt: timestamp('evaluated_at', { withTimezone: true }).notNull(),
    correlationId: text('correlation_id').notNull(),
    createdAt: createdAt()
  },
  (t) => [uniqueIndex('signal_decisions_unique_step').on(t.eventId, t.orderBlockId, t.step), index('signal_decisions_owner_idx').on(t.ownerId, t.createdAt)]
);
