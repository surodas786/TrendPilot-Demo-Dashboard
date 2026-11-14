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
    /** Live allowlist: Live opening orders are refused on contracts an administrator has not allowed. */
    liveAllowed: boolean('live_allowed').notNull().default(false),
    revision: integer('revision').notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt()
  },
  (t) => [uniqueIndex('instruments_exchange_symbol_key').on(t.exchange, t.symbol)]
);

export const strategyPackages = pgTable('strategy_packages', {
  id: uuid('id').primaryKey().defaultRandom(),
  /** Display name only; renaming never changes the ID, versions, routes or investor settings. */
  name: text('name').notNull(),
  /** Archived packages keep their history but are hidden from new selections. */
  archivedAt: timestamp('archived_at', { withTimezone: true }),
  archivedBy: uuid('archived_by'),
  revision: integer('revision').notNull().default(1),
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
export const emailOutbox = pgTable(
  'email_outbox',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    toEmail: text('to_email').notNull(),
    subject: text('subject').notNull(),
    bodyText: text('body_text').notNull(),
    template: text('template').notNull(),
    /** CAPTURED (dev/test capture, never sent), QUEUED, SENT or FAILED (SMTP delivery). */
    deliveryStatus: text('delivery_status').notNull().default('CAPTURED'),
    /** Redacted SMTP error or reason; never credentials. */
    deliveryError: text('delivery_error'),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    createdAt: createdAt()
  },
  (t) => [
    check('email_outbox_delivery_status', sql`${t.deliveryStatus} IN ('CAPTURED', 'QUEUED', 'SENT', 'FAILED')`),
    index('email_outbox_delivery_idx').on(t.deliveryStatus, t.createdAt)
  ]
);

/**
 * Admin → Settings → Mail Box. Single row (id = 1). The SMTP password is sealed with the
 * platform secret box (AES-256-GCM, DATA_ENCRYPTION_KEY) and is never returned by any API.
 */
export const mailSettings = pgTable(
  'mail_settings',
  {
    id: integer('id').primaryKey().default(1),
    smtpHost: text('smtp_host').notNull(),
    smtpPort: integer('smtp_port').notNull(),
    smtpSecurity: text('smtp_security').notNull(),
    smtpUsername: text('smtp_username').notNull().default(''),
    smtpPasswordSealed: text('smtp_password_sealed'),
    senderName: text('sender_name').notNull(),
    senderEmail: text('sender_email').notNull(),
    replyTo: text('reply_to'),
    revision: integer('revision').notNull().default(1),
    updatedBy: uuid('updated_by').references(() => users.id),
    lastTestAt: timestamp('last_test_at', { withTimezone: true }),
    lastTestOk: boolean('last_test_ok'),
    lastTestRecipient: text('last_test_recipient'),
    lastTestDetail: text('last_test_detail'),
    createdAt: createdAt(),
    updatedAt: updatedAt()
  },
  (t) => [
    check('mail_settings_singleton', sql`${t.id} = 1`),
    check('mail_settings_port', sql`${t.smtpPort} BETWEEN 1 AND 65535`),
    check('mail_settings_security', sql`${t.smtpSecurity} IN ('STARTTLS', 'TLS')`)
  ]
);

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
    /** Long Take Profit (the column predates per-side Take Profit and kept its name). */
    takeProfitLong: jsonb('take_profit').notNull(),
    /** Short Take Profit. Backfilled from the shared configuration by migration 0021. */
    takeProfitShort: jsonb('take_profit_short').notNull(),
    trailing: jsonb('trailing').notNull(),
    weekdays: text('weekdays')
      .array()
      .notNull()
      .default(sql`ARRAY['SUN','MON','TUE','WED','THU','FRI','SAT']::text[]`),
    timezone: text('timezone').notNull().default('Asia/Dhaka'),
    /**
     * CFG-04 optional daily window for new exposure, HH:mm in `timezone`. Both null = All day.
     * End earlier than Start crosses midnight (the session belongs to the day it started).
     */
    tradingWindowStart: text('trading_window_start'),
    tradingWindowEnd: text('trading_window_end'),
    allowAdds: boolean('allow_adds').notNull().default(false),
    maxAdds: integer('max_adds'),
    risk: jsonb('risk').notNull().default({}),
    status: blockStatus('status').notNull().default('PAUSED'),
    /**
     * Saved before Trailing Take Profit, with the old trailing stop on. New entries are held
     * until the investor saves trailing settings again with an explicit activation value.
     */
    trailingConversionRequired: boolean('trailing_conversion_required').notNull().default(false),
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
    check(
      'order_blocks_trading_window_valid',
      sql`(${t.tradingWindowStart} IS NULL AND ${t.tradingWindowEnd} IS NULL) OR (${t.tradingWindowStart} ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' AND ${t.tradingWindowEnd} ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' AND ${t.tradingWindowStart} <> ${t.tradingWindowEnd})`
    ),
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
export const decisionStatus = pgEnum('decision_status', ['READY_FOR_EVALUATION', 'SKIPPED', 'ENTRY_APPROVED', 'EXIT_REQUESTED', 'HELD']);

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

/* ───────────────────────── M2 slice 2: market fixtures, paper execution (EXE-01..04, ARC-02) ───────────────────────── */

export const intentState = pgEnum('intent_state', ['INTENT', 'SUBMITTING', 'ACKNOWLEDGED', 'PARTIALLY_FILLED', 'FILLED', 'REJECTED', 'CANCELLED', 'EXPIRED', 'UNKNOWN']);
export const positionStatus = pgEnum('position_status', ['OPEN', 'CLOSED']);
export const protectionStatus = pgEnum('protection_status', ['PENDING', 'PROTECTED', 'UNPROTECTED']);

const money = (name: string) => numeric(name, { precision: 28, scale: 8 });
const qty = (name: string) => numeric(name, { precision: 28, scale: 12 });
const price = (name: string) => numeric(name, { precision: 32, scale: 12 });

/** MKT-01 closed-candle cache. Fixture rows in this slice; the market data worker fills it later. */
export const marketCandles = pgTable(
  'market_candles',
  {
    instrumentId: uuid('instrument_id')
      .notNull()
      .references(() => instruments.id),
    interval: text('interval').notNull(),
    openTime: timestamp('open_time', { withTimezone: true }).notNull(),
    open: price('open').notNull(),
    high: price('high').notNull(),
    low: price('low').notNull(),
    close: price('close').notNull(),
    closed: boolean('closed').notNull(),
    source: text('source').notNull(),
    createdAt: createdAt()
  },
  (t) => [primaryKey({ columns: [t.instrumentId, t.interval, t.openTime] }), check('market_candles_interval_valid', sql`${t.interval} IN ('5', '15')`)]
);

/** MKT-01 top of book. The newest row per instrument is the current quote. */
export const marketQuotes = pgTable(
  'market_quotes',
  {
    instrumentId: uuid('instrument_id')
      .notNull()
      .references(() => instruments.id),
    asOf: timestamp('as_of', { withTimezone: true }).notNull(),
    bid: price('bid').notNull(),
    ask: price('ask').notNull(),
    mark: price('mark').notNull(),
    last: price('last').notNull(),
    /** Fixture liquidity: a market order fills at most this many contracts (null = unlimited). */
    liquidityContracts: qty('liquidity_contracts'),
    source: text('source').notNull(),
    /** MEXC_PUBLIC transport: WS (primary), REST_FALLBACK or REST_POLL. Null for fixtures. */
    channel: text('channel'),
    createdAt: createdAt()
  },
  (t) => [primaryKey({ columns: [t.instrumentId, t.asOf] }), check('market_quotes_book', sql`${t.ask} >= ${t.bid} AND ${t.bid} > 0`)]
);

/**
 * SCP-03 trading account per investor AND mode (the table keeps its historical name).
 * PAPER: the isolated simulated balance. LIVE: the investor's MEXC Futures account as TrendPilot
 * sees it — wallet follows the synced exchange balance (EXCHANGE_BALANCE_SYNC ledger rows), and
 * positions, orders, fills and the ledger are separate from Paper because they are keyed by account.
 * available = wallet − positionMargin − orderReserve (Live is also capped by exchange_available).
 */
export const paperAccounts = pgTable(
  'paper_accounts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id),
    mode: tradingMode('mode').notNull().default('PAPER'),
    currency: text('currency').notNull().default('USDT'),
    /** LIVE only: last synced MEXC equity and available-to-open balance (USDT). */
    exchangeEquity: numeric('exchange_equity', { precision: 28, scale: 8 }),
    exchangeAvailable: numeric('exchange_available', { precision: 28, scale: 8 }),
    exchangeSyncedAt: timestamp('exchange_synced_at', { withTimezone: true }),
    walletBalance: money('wallet_balance').notNull(),
    positionMargin: money('position_margin').notNull().default('0'),
    orderReserve: money('order_reserve').notNull().default('0'),
    revision: integer('revision').notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt()
  },
  (t) => [
    uniqueIndex('paper_accounts_owner_mode_key').on(t.ownerId, t.mode),
    check('paper_accounts_nonnegative', sql`${t.walletBalance} >= 0 AND ${t.positionMargin} >= 0 AND ${t.orderReserve} >= 0`)
  ]
);

/** EXE-04 durable order intent. Committed (with its margin reservation) before any submission. */
export const orderIntents = pgTable(
  'order_intents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id),
    paperAccountId: uuid('paper_account_id')
      .notNull()
      .references(() => paperAccounts.id),
    orderBlockId: uuid('order_block_id')
      .notNull()
      .references(() => orderBlocks.id),
    /** Entries and signal-driven exits are linked to the decision that caused them. */
    decisionId: uuid('decision_id').references(() => signalDecisions.id),
    eventId: uuid('event_id').references(() => signalEvents.id),
    instrumentId: uuid('instrument_id')
      .notNull()
      .references(() => instruments.id),
    mode: tradingMode('mode').notNull(),
    /** OPEN or CLOSE. */
    kind: text('kind').notNull(),
    /** CLOSE only: the managed position being reduced. */
    positionId: uuid('position_id'),
    exitReason: text('exit_reason'),
    /** CLOSE for a take-profit target: the target's immutable level ID (EXT-03). */
    targetLevelId: text('target_level_id'),
    /** Manual closes: client-supplied Idempotency-Key, unique per owner. */
    idempotencyKey: text('idempotency_key'),
    requestedBy: uuid('requested_by'),
    filledContracts: qty('filled_contracts').notNull().default('0'),
    side: text('side').notNull(),
    /** Stable client order ID: the same value is sent on every (re)submission. */
    clientOrderId: text('client_order_id').notNull(),
    state: intentState('state').notNull().default('INTENT'),
    stateReason: text('state_reason'),
    contracts: qty('contracts').notNull(),
    quantity: qty('quantity').notNull(),
    expectedPrice: price('expected_price').notNull(),
    stopPrice: price('stop_price').notNull(),
    stopBasis: text('stop_basis').notNull(),
    leverage: integer('leverage').notNull(),
    marginMode: marginMode('margin_mode').notNull(),
    reservedUsdt: money('reserved_usdt').notNull(),
    sizing: jsonb('sizing').notNull(),
    /** Immutable copy of the block and pinned strategy version at decision time. */
    settingsSnapshot: jsonb('settings_snapshot').notNull(),
    submittedAt: timestamp('submitted_at', { withTimezone: true }),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt()
  },
  (t) => [
    uniqueIndex('order_intents_decision_key').on(t.decisionId),
    uniqueIndex('order_intents_client_order_key').on(t.clientOrderId),
    index('order_intents_owner_idx').on(t.ownerId, t.createdAt),
    // ARC-02: at most one unresolved exposure-changing operation per scope.
    uniqueIndex('order_intents_one_unresolved_per_scope')
      .on(t.paperAccountId, t.instrumentId, t.mode)
      .where(sql`${t.state} IN ('INTENT', 'SUBMITTING', 'ACKNOWLEDGED', 'PARTIALLY_FILLED', 'UNKNOWN')`),
    uniqueIndex('order_intents_idempotency_key').on(t.ownerId, t.idempotencyKey).where(sql`${t.idempotencyKey} IS NOT NULL`),
    index('order_intents_position_idx').on(t.positionId),
    check('order_intents_side_valid', sql`${t.side} IN ('LONG', 'SHORT')`),
    check('order_intents_kind_valid', sql`${t.kind} IN ('OPEN', 'CLOSE')`),
    check('order_intents_positive', sql`${t.contracts} > 0 AND (${t.kind} <> 'OPEN' OR ${t.reservedUsdt} > 0)`),
    check('order_intents_links', sql`(${t.kind} = 'OPEN' AND ${t.decisionId} IS NOT NULL) OR (${t.kind} = 'CLOSE' AND ${t.positionId} IS NOT NULL)`)
  ]
);

/**
 * Paper simulator state — the "exchange" side of paper trading. Written only by the simulator,
 * in its own transaction, exactly like a remote venue would. Keyed by client order ID.
 */
export const simOrders = pgTable(
  'sim_orders',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    paperAccountId: uuid('paper_account_id')
      .notNull()
      .references(() => paperAccounts.id),
    clientOrderId: text('client_order_id').notNull(),
    instrumentId: uuid('instrument_id')
      .notNull()
      .references(() => instruments.id),
    kind: text('kind').notNull(),
    side: text('side').notNull(),
    contracts: qty('contracts').notNull(),
    status: text('status').notNull(),
    reduceOnly: boolean('reduce_only').notNull().default(false),
    triggerPrice: price('trigger_price'),
    triggerBasis: text('trigger_basis'),
    parentOrderId: uuid('parent_order_id'),
    rejectReason: text('reject_reason'),
    createdAt: createdAt()
  },
  (t) => [uniqueIndex('sim_orders_client_key').on(t.clientOrderId), index('sim_orders_parent_idx').on(t.parentOrderId)]
);

export const simFills = pgTable(
  'sim_fills',
  {
    id: text('id').primaryKey(),
    orderId: uuid('order_id')
      .notNull()
      .references(() => simOrders.id),
    paperAccountId: uuid('paper_account_id')
      .notNull()
      .references(() => paperAccounts.id),
    contracts: qty('contracts').notNull(),
    price: price('price').notNull(),
    fee: money('fee').notNull(),
    filledAt: timestamp('filled_at', { withTimezone: true }).notNull()
  },
  (t) => [index('sim_fills_order_idx').on(t.orderId)]
);

/** Platform fill record. Deduplicated by exchange fill ID within the account (EXE-04). */
export const fills = pgTable(
  'fills',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id),
    paperAccountId: uuid('paper_account_id')
      .notNull()
      .references(() => paperAccounts.id),
    intentId: uuid('intent_id')
      .notNull()
      .references(() => orderIntents.id),
    exchangeFillId: text('exchange_fill_id').notNull(),
    side: text('side').notNull(),
    contracts: qty('contracts').notNull(),
    price: price('price').notNull(),
    fee: money('fee').notNull(),
    filledAt: timestamp('filled_at', { withTimezone: true }).notNull(),
    createdAt: createdAt()
  },
  (t) => [uniqueIndex('fills_account_fill_key').on(t.paperAccountId, t.exchangeFillId), index('fills_owner_idx').on(t.ownerId)]
);

/** Managed position. One open position per account, contract and mode (one-way, SCP-01). */
export const positions = pgTable(
  'positions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id),
    paperAccountId: uuid('paper_account_id')
      .notNull()
      .references(() => paperAccounts.id),
    instrumentId: uuid('instrument_id')
      .notNull()
      .references(() => instruments.id),
    orderBlockId: uuid('order_block_id')
      .notNull()
      .references(() => orderBlocks.id),
    openIntentId: uuid('open_intent_id')
      .notNull()
      .references(() => orderIntents.id),
    mode: tradingMode('mode').notNull(),
    side: text('side').notNull(),
    status: positionStatus('status').notNull().default('OPEN'),
    contracts: qty('contracts').notNull(),
    initialContracts: qty('initial_contracts').notNull(),
    quantity: qty('quantity').notNull(),
    avgEntryPrice: price('avg_entry_price').notNull(),
    leverage: integer('leverage').notNull(),
    marginMode: marginMode('margin_mode').notNull(),
    marginUsdt: money('margin_usdt').notNull(),
    liquidationEstimate: price('liquidation_estimate').notNull(),
    stopPrice: price('stop_price').notNull(),
    stopBasis: text('stop_basis').notNull(),
    stopOrderRef: text('stop_order_ref'),
    stopContracts: qty('stop_contracts'),
    /** Strategy version saved at entry; closing signals match its lineage (SIG-04). */
    strategyVersionId: uuid('strategy_version_id').references(() => strategyVersions.id),
    /** Fixed TP target from the confirmed average entry (null = TP off). */
    takeProfitPrice: price('take_profit_price'),
    takeProfitBasis: text('take_profit_basis'),
    /**
     * EXT-04 trailing exit, persisted so it survives restarts: OFF, WAITING (not yet activated),
     * ACTIVE, or DONE (Trailing Take Profit has closed all the quantity it manages). Watermark =
     * highest (Long) / lowest (Short) basis price since activation; the level only tightens. A
     * software trigger: the fixed venue stop stays in place for the whole open quantity.
     * `trailingKind` is saved at entry: TAKE_PROFIT (Trailing Take Profit) or STOP (legacy
     * trailing stop of positions opened before it; their saved behaviour is kept).
     */
    trailingStatus: text('trailing_status').notNull().default('OFF'),
    trailingKind: text('trailing_kind').notNull().default('TAKE_PROFIT'),
    trailingBasis: text('trailing_basis'),
    trailingDistancePct: numeric('trailing_distance_pct', { precision: 10, scale: 4 }),
    trailingActivationPrice: price('trailing_activation_price'),
    trailingActivatedAt: timestamp('trailing_activated_at', { withTimezone: true }),
    trailingWatermark: price('trailing_watermark'),
    trailingStopPrice: price('trailing_stop_price'),
    trailingUpdatedAt: timestamp('trailing_updated_at', { withTimezone: true }),
    /**
     * Contracts of the confirmed opening quantity assigned to Trailing Take Profit ("Position to
     * close (%)"), and how many of them confirmed fills have closed. Null planned = a position
     * opened before explicit allocation: its trailing exit manages what no target reserves.
     */
    trailingPlannedContracts: qty('trailing_planned_contracts'),
    trailingFilledContracts: qty('trailing_filled_contracts').notNull().default('0'),
    realizedPnlUsdt: money('realized_pnl_usdt').notNull().default('0'),
    feesUsdt: money('fees_usdt').notNull().default('0'),
    closeReason: text('close_reason'),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    protectionStatus: protectionStatus('protection_status').notNull().default('PENDING'),
    protectionVerifiedAt: timestamp('protection_verified_at', { withTimezone: true }),
    /** LIVE: MEXC positionId, liquidation price and cumulative funding from the private sync. */
    exchangePositionRef: text('exchange_position_ref'),
    exchangeLiquidationPrice: price('exchange_liquidation_price'),
    exchangeFundingUsdt: money('exchange_funding_usdt'),
    exchangeSyncedAt: timestamp('exchange_synced_at', { withTimezone: true }),
    /**
     * LIVE manual-close reconciliation. `exchangeContracts`: what MEXC reported for this position at
     * the last successful sync. `exchangeCloseState` = FILLS_PENDING when MEXC holds less than
     * TrendPilot (fully closed when 0) but the closing fills are not yet listed, so the exit is not
     * booked; null otherwise. `exchangeFlatAt`: when MEXC was first seen holding none of it.
     */
    exchangeContracts: qty('exchange_contracts'),
    exchangeCloseState: text('exchange_close_state'),
    exchangeFlatAt: timestamp('exchange_flat_at', { withTimezone: true }),
    /** Contracts closed on MEXC whose fills are not booked yet (FILLS_PENDING, also after the position is CLOSED). */
    exchangePendingContracts: qty('exchange_pending_contracts'),
    settingsSnapshot: jsonb('settings_snapshot').notNull(),
    openedAt: timestamp('opened_at', { withTimezone: true }).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt()
  },
  (t) => [
    uniqueIndex('positions_open_intent_key').on(t.openIntentId),
    uniqueIndex('positions_one_open_per_scope').on(t.paperAccountId, t.instrumentId, t.mode).where(sql`${t.status} = 'OPEN'`),
    index('positions_owner_idx').on(t.ownerId, t.openedAt),
    check('positions_trailing_status_valid', sql`${t.trailingStatus} IN ('OFF', 'WAITING', 'ACTIVE', 'DONE')`),
    check('positions_trailing_kind_valid', sql`${t.trailingKind} IN ('TAKE_PROFIT', 'STOP')`),
    check('positions_exchange_close_state_valid', sql`${t.exchangeCloseState} IS NULL OR ${t.exchangeCloseState} IN ('FILLS_PENDING')`),
    check('positions_trailing_alloc_valid', sql`${t.trailingFilledContracts} >= 0 AND (${t.trailingPlannedContracts} IS NULL OR ${t.trailingFilledContracts} <= ${t.trailingPlannedContracts})`)
  ]
);

/** Paper ledger. Append-only; one row per (account, kind, reference) so nothing books twice. */
export const ledgerEntries = pgTable(
  'ledger_entries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id),
    paperAccountId: uuid('paper_account_id')
      .notNull()
      .references(() => paperAccounts.id),
    kind: text('kind').notNull(),
    /** Which balance the entry moves: WALLET, POSITION_MARGIN or ORDER_RESERVE. */
    bucket: text('bucket').notNull(),
    amount: money('amount').notNull(),
    refType: text('ref_type').notNull(),
    refId: text('ref_id').notNull(),
    memo: text('memo'),
    createdAt: createdAt()
  },
  (t) => [uniqueIndex('ledger_entries_once_key').on(t.paperAccountId, t.kind, t.refId), index('ledger_entries_owner_idx').on(t.ownerId, t.createdAt)]
);

/* ───────────────────────── M2 slice 3: paper exits (EXT-01/02/05/06/07) ───────────────────────── */

/** One row per confirmed exit fill: reason, quantity, price, fee, realized P&L, released margin. Append-only. */
export const positionExits = pgTable(
  'position_exits',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id),
    paperAccountId: uuid('paper_account_id')
      .notNull()
      .references(() => paperAccounts.id),
    positionId: uuid('position_id')
      .notNull()
      .references(() => positions.id),
    /** Null for venue-triggered stops (no platform order intent). */
    intentId: uuid('intent_id').references(() => orderIntents.id),
    reason: text('reason').notNull(),
    exchangeFillId: text('exchange_fill_id').notNull(),
    contracts: qty('contracts').notNull(),
    price: price('price').notNull(),
    fee: money('fee').notNull(),
    realizedPnl: money('realized_pnl').notNull(),
    marginReleased: money('margin_released').notNull(),
    remainingContracts: qty('remaining_contracts').notNull(),
    filledAt: timestamp('filled_at', { withTimezone: true }).notNull(),
    createdAt: createdAt()
  },
  (t) => [uniqueIndex('position_exits_fill_key').on(t.paperAccountId, t.exchangeFillId), index('position_exits_position_idx').on(t.positionId)]
);

/** The simulator's own view of each paper position (the venue's authority for reduce-only). */
export const simPositions = pgTable(
  'sim_positions',
  {
    paperAccountId: uuid('paper_account_id')
      .notNull()
      .references(() => paperAccounts.id),
    instrumentId: uuid('instrument_id')
      .notNull()
      .references(() => instruments.id),
    side: text('side'),
    contracts: qty('contracts').notNull().default('0'),
    updatedAt: updatedAt()
  },
  (t) => [primaryKey({ columns: [t.paperAccountId, t.instrumentId] }), check('sim_positions_nonnegative', sql`${t.contracts} >= 0`)]
);

/**
 * EXT-03 take-profit targets of one position (a fixed TP is one target). Immutable level ID and
 * planned share of the base quantity; requested and confirmed filled quantities are tracked
 * separately, and only confirmed fills complete a target.
 */
export const positionTargets = pgTable(
  'position_targets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id),
    positionId: uuid('position_id')
      .notNull()
      .references(() => positions.id),
    levelId: text('level_id').notNull(),
    ordinal: integer('ordinal').notNull(),
    movePct: numeric('move_pct', { precision: 10, scale: 4 }).notNull(),
    closePct: numeric('close_pct', { precision: 10, scale: 4 }).notNull(),
    triggerPrice: price('trigger_price').notNull(),
    triggerBasis: text('trigger_basis').notNull(),
    plannedContracts: qty('planned_contracts').notNull(),
    requestedContracts: qty('requested_contracts').notNull().default('0'),
    filledContracts: qty('filled_contracts').notNull().default('0'),
    status: text('status').notNull().default('PENDING'),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    /**
     * ARM_PULLBACK: reaching the target arms it (persisted here, so it survives worker restarts)
     * and a later price back through the target closes its quantity. TOUCH: targets of positions
     * opened before that rule, which close when reached.
     */
    triggerRule: text('trigger_rule').notNull().default('TOUCH'),
    armedAt: timestamp('armed_at', { withTimezone: true }),
    armedPrice: price('armed_price'),
    createdAt: createdAt(),
    updatedAt: updatedAt()
  },
  (t) => [
    uniqueIndex('position_targets_level_key').on(t.positionId, t.levelId),
    check('position_targets_trigger_rule_valid', sql`${t.triggerRule} IN ('TOUCH', 'ARM_PULLBACK')`),
    check('position_targets_status_valid', sql`${t.status} IN ('PENDING', 'REQUESTED', 'PARTIAL', 'DONE', 'CANCELLED')`),
    check('position_targets_quantities', sql`${t.plannedContracts} >= 0 AND ${t.requestedContracts} >= 0 AND ${t.filledContracts} >= 0 AND ${t.filledContracts} <= ${t.plannedContracts}`)
  ]
);

/* ─────────────────────── Step 8: MKT-01/02 public market-data feed ─────────────────────── */

/** Per contract and source: the feed's current health. Survives feed-process restarts. */
export const marketFeedStatus = pgTable(
  'market_feed_status',
  {
    instrumentId: uuid('instrument_id')
      .notNull()
      .references(() => instruments.id),
    source: text('source').notNull(),
    exchangeSymbol: text('exchange_symbol').notNull(),
    state: text('state').notNull().default('STARTING'),
    stateSince: timestamp('state_since', { withTimezone: true }).notNull().defaultNow(),
    /** Newest written quote, in the local clock domain. */
    lastQuoteAt: timestamp('last_quote_at', { withTimezone: true }),
    /** The exchange's own timestamp of that quote (repeat detection). */
    lastExchangeTime: timestamp('last_exchange_time', { withTimezone: true }),
    lastSuccessAt: timestamp('last_success_at', { withTimezone: true }),
    /** Newest closed bar open synced, per interval: {"5": iso, "15": iso}. */
    lastCandleOpen: jsonb('last_candle_open'),
    consecutiveFailures: integer('consecutive_failures').notNull().default(0),
    nextRetryAt: timestamp('next_retry_at', { withTimezone: true }),
    lastError: text('last_error'),
    clockOffsetMs: integer('clock_offset_ms'),
    /** Channel of the newest written quote (WS, REST_FALLBACK, REST_POLL). */
    quoteChannel: text('quote_channel'),
    /** Local receipt time of the newest WebSocket ticker for this contract (repeats included). */
    lastStreamAt: timestamp('last_stream_at', { withTimezone: true }),
    contractCheck: jsonb('contract_check'),
    contractCheckedAt: timestamp('contract_checked_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
  },
  (t) => [
    primaryKey({ columns: [t.instrumentId, t.source] }),
    check('market_feed_status_state_valid', sql`${t.state} IN ('STARTING', 'HEALTHY', 'STALE', 'DOWN', 'CLOCK_SKEW', 'SYMBOL_UNAVAILABLE')`)
  ]
);

/** Append-only feed history: state changes, gaps, backfills, revisions, unverifiable windows. */
export const marketFeedEvents = pgTable(
  'market_feed_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    instrumentId: uuid('instrument_id')
      .notNull()
      .references(() => instruments.id),
    source: text('source').notNull(),
    kind: text('kind').notNull(),
    message: text('message').notNull(),
    detail: jsonb('detail').notNull().default({}),
    windowFrom: timestamp('window_from', { withTimezone: true }),
    windowTo: timestamp('window_to', { withTimezone: true }),
    createdAt: createdAt()
  },
  (t) => [index('market_feed_events_created_idx').on(t.createdAt), index('market_feed_events_instrument_idx').on(t.instrumentId, t.createdAt)]
);

/* ───────────────────────── Step 9: settled funding (REP-02) ───────────────────────── */

/** Settled funding rates per contract (public history or fixture). A predicted rate is never stored here. */
export const fundingRates = pgTable(
  'funding_rates',
  {
    instrumentId: uuid('instrument_id')
      .notNull()
      .references(() => instruments.id),
    settledAt: timestamp('settled_at', { withTimezone: true }).notNull(),
    rate: numeric('rate', { precision: 18, scale: 10 }).notNull(),
    source: text('source').notNull(),
    createdAt: createdAt()
  },
  (t) => [primaryKey({ columns: [t.instrumentId, t.settledAt] })]
);

/** Simulated funding booked to a paper position at one settlement. Once per position and settlement. */
export const paperFunding = pgTable(
  'paper_funding',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id),
    paperAccountId: uuid('paper_account_id')
      .notNull()
      .references(() => paperAccounts.id),
    positionId: uuid('position_id')
      .notNull()
      .references(() => positions.id),
    instrumentId: uuid('instrument_id')
      .notNull()
      .references(() => instruments.id),
    settledAt: timestamp('settled_at', { withTimezone: true }).notNull(),
    rate: numeric('rate', { precision: 18, scale: 10 }).notNull(),
    contracts: qty('contracts').notNull(),
    markPrice: price('mark_price').notNull(),
    notional: money('notional').notNull(),
    /** Paid is negative, received positive (REP-02). */
    amount: money('amount').notNull(),
    source: text('source').notNull(),
    createdAt: createdAt()
  },
  (t) => [uniqueIndex('paper_funding_once').on(t.positionId, t.settledAt), index('paper_funding_owner_idx').on(t.ownerId, t.settledAt)]
);

/* ───────────────────────── Step 10: operations (OPS) ───────────────────────── */

/** Liveness of background services (worker, market feed). One row per service instance. */
export const serviceHeartbeats = pgTable(
  'service_heartbeats',
  {
    service: text('service').notNull(),
    instance: text('instance').notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull(),
    detail: jsonb('detail').notNull().default({}),
    stoppedAt: timestamp('stopped_at', { withTimezone: true })
  },
  (t) => [primaryKey({ columns: [t.service, t.instance] })]
);

/* ───────────────────────── Step 12: live pilot scope (OPS-02) ───────────────────────── */

/**
 * The live pilot allowlist: one investor, one MEXC account (reference only, never credentials),
 * one contract, operator-approved limits. At most one pilot is open at a time; adds and automatic
 * reversals are off by constraint.
 */
export const livePilots = pgTable(
  'live_pilots',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    status: text('status').notNull().default('DRAFT'),
    investorId: uuid('investor_id')
      .notNull()
      .references(() => users.id),
    instrumentId: uuid('instrument_id')
      .notNull()
      .references(() => instruments.id),
    /** Human reference for the verified MEXC account (e.g. UID suffix). Never a key. */
    exchangeAccountRef: text('exchange_account_ref').notNull(),
    maxOrderContracts: numeric('max_order_contracts', { precision: 28, scale: 12 }).notNull(),
    maxOrderNotionalUsdt: numeric('max_order_notional_usdt', { precision: 28, scale: 8 }).notNull(),
    maxLeverage: integer('max_leverage').notNull(),
    maxExposureUsdt: numeric('max_exposure_usdt', { precision: 28, scale: 8 }).notNull(),
    allowAdds: boolean('allow_adds').notNull().default(false),
    allowReversal: boolean('allow_reversal').notNull().default(false),
    /** Recorded pre-pilot checks: { CHECK_ID: { passed, evidence, by, at } }. */
    checks: jsonb('checks').notNull().default({}),
    approvedBy: uuid('approved_by').references(() => users.id),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    investorActivatedAt: timestamp('investor_activated_at', { withTimezone: true }),
    entriesHalted: boolean('entries_halted').notNull().default(false),
    haltReason: text('halt_reason'),
    haltedAt: timestamp('halted_at', { withTimezone: true }),
    revision: integer('revision').notNull().default(1),
    createdBy: uuid('created_by').references(() => users.id),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp('ended_at', { withTimezone: true })
  },
  (t) => [
    check('live_pilots_status_valid', sql`${t.status} IN ('DRAFT', 'APPROVED', 'ACTIVE', 'ENDED')`),
    check('live_pilots_no_adds_or_reversal', sql`${t.allowAdds} = false AND ${t.allowReversal} = false`),
    check('live_pilots_limits_positive', sql`${t.maxOrderContracts} > 0 AND ${t.maxOrderNotionalUsdt} > 0 AND ${t.maxExposureUsdt} > 0 AND ${t.maxLeverage} BETWEEN 1 AND 20`),
    uniqueIndex('live_pilots_one_open').on(sql`(true)`).where(sql`${t.status} <> 'ENDED'`)
  ]
);

/* ───────────────────────── Live mode: exchange connections and the platform switch ───────────────────────── */

/**
 * OPS-01 one MEXC Futures connection per investor. The API key and secret are sealed with
 * AES-256-GCM (DATA_ENCRYPTION_KEY) and are only opened on the server to sign requests; no API
 * returns them. Live opening orders need: VERIFIED (read checks passed), approved by an
 * administrator with limits, activated by the investor (default Off), and not halted.
 */
export const exchangeConnections = pgTable(
  'exchange_connections',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id),
    exchange: text('exchange').notNull().default('MEXC'),
    /** Non-secret account reference (e.g. UID suffix). */
    accountRef: text('account_ref').notNull(),
    apiKeySealed: text('api_key_sealed').notNull(),
    secretSealed: text('secret_sealed').notNull(),
    /** Last 4 characters of the API key, for display only. */
    keyFingerprint: text('key_fingerprint').notNull(),
    status: text('status').notNull().default('PENDING'),
    /** Result of the read-only verification: position mode, balances, open positions, errors. */
    verification: jsonb('verification').notNull().default({}),
    verifiedAt: timestamp('verified_at', { withTimezone: true }),
    positionMode: text('position_mode'),
    approvedBy: uuid('approved_by').references(() => users.id),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    maxOrderContracts: numeric('max_order_contracts', { precision: 28, scale: 12 }),
    maxOrderNotionalUsdt: numeric('max_order_notional_usdt', { precision: 28, scale: 8 }),
    maxLeverage: integer('max_leverage'),
    maxExposureUsdt: numeric('max_exposure_usdt', { precision: 28, scale: 8 }),
    /** Investor activation of Live trading. Default Off. */
    liveEnabled: boolean('live_enabled').notNull().default(false),
    activatedAt: timestamp('activated_at', { withTimezone: true }),
    entriesHalted: boolean('entries_halted').notNull().default(false),
    haltReason: text('halt_reason'),
    haltedAt: timestamp('halted_at', { withTimezone: true }),
    lastSyncAt: timestamp('last_sync_at', { withTimezone: true }),
    lastSyncError: text('last_sync_error'),
    /** Last sync that completed every MEXC query (lastSyncAt also moves on a failed attempt). */
    lastSyncOkAt: timestamp('last_sync_ok_at', { withTimezone: true }),
    /** Held by the running private sync (one run per account); expires if a run dies. */
    syncLeaseUntil: timestamp('sync_lease_until', { withTimezone: true }),
    /** Differences between MEXC and TrendPilot found by the private sync (OPS-03). */
    drift: jsonb('drift').notNull().default([]),
    revision: integer('revision').notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt()
  },
  (t) => [
    uniqueIndex('exchange_connections_owner_key').on(t.ownerId),
    check('exchange_connections_status_valid', sql`${t.status} IN ('PENDING', 'VERIFIED', 'FAILED', 'REVOKED')`),
    check('exchange_connections_position_mode_valid', sql`${t.positionMode} IS NULL OR ${t.positionMode} IN ('ONE_WAY', 'HEDGE')`),
    check(
      'exchange_connections_limits_valid',
      sql`(${t.approvedAt} IS NULL) OR (${t.maxOrderContracts} > 0 AND ${t.maxOrderNotionalUsdt} > 0 AND ${t.maxExposureUsdt} >= ${t.maxOrderNotionalUsdt} AND ${t.maxLeverage} BETWEEN 1 AND 125)`
    ),
    check('exchange_connections_activation_needs_approval', sql`${t.liveEnabled} = false OR (${t.approvedAt} IS NOT NULL AND ${t.status} = 'VERIFIED')`)
  ]
);

/**
 * The platform Live switch (single row, id = 1). Default Off. `entries_halted` stops every new
 * Live entry at once while protection and closes keep running. `capability_evidence` holds the
 * operator's record for each MEXC order capability (VERIFIED with evidence, or PILOT_ACCEPTED for
 * the supervised first trades).
 */
export const liveControl = pgTable(
  'live_control',
  {
    id: integer('id').primaryKey().default(1),
    liveEnabled: boolean('live_enabled').notNull().default(false),
    entriesHalted: boolean('entries_halted').notNull().default(false),
    haltReason: text('halt_reason'),
    haltedAt: timestamp('halted_at', { withTimezone: true }),
    capabilityEvidence: jsonb('capability_evidence').notNull().default({}),
    note: text('note'),
    updatedBy: uuid('updated_by').references(() => users.id),
    revision: integer('revision').notNull().default(1),
    updatedAt: updatedAt()
  },
  (t) => [check('live_control_singleton', sql`${t.id} = 1`)]
);
